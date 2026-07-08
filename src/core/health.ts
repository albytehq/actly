import type { InMemoryStore } from '../stores/memory.js'
import type { AnyStateStore } from '../types/index.js'
import { LIMITS } from '../utils/limits.js'
import { ResourceExhaustedError } from '../errors.js'
import type { ObservabilityHooks, WatchdogEvent } from '../observability.js'
import { safeCall } from '../utils/safeCall.js'

/**
 * Map a store instance to the scope `withStore()` uses internally for it.
 *
 * `withStore()` registers its `'scoped:<uuid>'` scope here so
 * `createHealthCheck(store)` can resolve the scope automatically. Without
 * this lookup, `withStore(store)` + `createHealthCheck(store)` (a common
 * pattern) silently reads the `'default'` scope and misses every error /
 * inflight event the scoped `act()` records.
 *
 * WeakMap keys don't keep the store alive: once destroyed + dropped, the
 * entry is reclaimed automatically.
 */
const storeScopes = new WeakMap<object, string>()

/** Register the scope a `withStore()` call uses for the given store. */
export function registerStoreScope(store: AnyStateStore, scope: string): void {
  storeScopes.set(store as unknown as object, scope)
}

/**
 * Resolve the scope for a store, if one was registered via `withStore()`.
 * Returns `undefined` for the default store (which uses scope `'default'`).
 */
export function resolveStoreScope(store: AnyStateStore): string | undefined {
  return storeScopes.get(store as unknown as object)
}

/**
 * Health status for a single scope. Each scope gets its own HealthState
 * entry in a Map; createHealthCheck reads only from the specified scope
 * (default: 'default').
 */
export interface HealthStatus {
  /** Live entry count in the associated store. */
  storeSize: number
  /** Number of in-flight act() calls in this scope. */
  pendingInflight: number
  /** Milliseconds since the health module loaded. */
  uptimeMs: number
  /** Last error recorded in this scope, if any. */
  lastError?: { code: string; message: string; timestamp: number }
  /** Timestamp of the last successful act() in this scope, if any. */
  lastSuccessAt?: number
}

interface HealthState {
  inflight: number
  lastError?: { code: string; message: string; timestamp: number }
  lastSuccessAt?: number
}

// per-scope state (one entry per scope key).
const healthStates = new Map<string, HealthState>()
const startTime = Date.now()

// process-wide in-flight budget; prevents self-DoS from runaway callers.
// Opt out via ACTLY_NO_INFLIGHT_LIMIT=1. Cached as module-level consts so
// V8 can constant-fold the disabled check (reading LIMITS + process.env
// on every call caused deopt).
const INFLIGHT_LIMIT_DISABLED =
  process.env.ACTLY_NO_INFLIGHT_LIMIT === '1' ||
  process.env.ACTLY_NO_INFLIGHT_LIMIT === 'true'
const INFLIGHT_LIMIT = LIMITS.MAX_GLOBAL_INFLIGHT
let globalInflightCount = 0

// watchdog: tracks the START of the current "busy period" (the 0→1
// transition of globalInflightCount). Updating a timestamp on every
// register/unregister would refresh under sustained churn so the watchdog
// never fired even when individual fns were hung. Tracking the busy-period
// start means a stuck fn holding the period open trips the watchdog even
// when mixed with healthy traffic.
//
// False positives under legitimately-sustained load are acceptable (the
// warning says "if this persists, a fn may be hung"); false negatives on a
// truly stuck call are not.
let inflightBusySince: number | undefined
let watchdogTimer: ReturnType<typeof setInterval> | undefined
let watchdogThresholdMs = 60_000
const watchdogHooks = new Set<ObservabilityHooks>()
// track which busy-period the watchdog already fired on so a stuck fn
// doesn't page operators every intervalMs for the whole stuck duration.
// Reset when the busy period ends (inflight → 0).
let watchdogFiredForBusySince: number | undefined

/**
 * Mark the start of a busy period if we just transitioned from 0 → >0.
 * Called from `registerInflight` AFTER the increment.
 */
function noteInflightUp(): void {
  if (inflightBusySince === undefined) {
    inflightBusySince = Date.now()
  }
}

/**
 * Clear the busy period marker if we just transitioned from >0 → 0.
 * Called from `unregisterInflight` AFTER the decrement.
 */
function noteInflightDown(): void {
  if (globalInflightCount === 0) {
    inflightBusySince = undefined
    // reset the "already fired" flag so the next busy period can fire.
    watchdogFiredForBusySince = undefined
  }
}

function getState(scope: string): HealthState {
  let s = healthStates.get(scope)
  if (!s) {
    s = { inflight: 0 }
    healthStates.set(scope, s)
  }
  return s
}

export function registerInflight(scope: string): void {
  // enforce the budget BEFORE incrementing. Cached consts let V8
  // constant-fold the disabled check; the remaining comparison is a single
  // integer compare.
  if (!INFLIGHT_LIMIT_DISABLED && globalInflightCount >= INFLIGHT_LIMIT) {
    throw new ResourceExhaustedError(globalInflightCount, INFLIGHT_LIMIT)
  }
  globalInflightCount++
  noteInflightUp()
  getState(scope).inflight++
}

export function unregisterInflight(scope: string): void {
  globalInflightCount = Math.max(0, globalInflightCount - 1)
  noteInflightDown()
  const s = getState(scope)
  s.inflight = Math.max(0, s.inflight - 1)
  // prune idle scope entries so high-cardinality multi-tenant scenarios
  // (50k tenants) don't grow the Map unbounded. When inflight reaches 0 AND
  // there's no lastError, delete the entry; getState() recreates it lazily.
  // The 'default' scope is never pruned (reused on every act() call).
  if (s.inflight === 0 && s.lastError === undefined && scope !== 'default') {
    healthStates.delete(scope)
  }
}

/**
 * Enable the in-flight watchdog. A background interval (unref'd) checks
 * every `thresholdMs / 4` whether any in-flight act() has been pending
 * longer than `thresholdMs`; if so, fires `onWatchdog` on every registered
 * ObservabilityHooks object.
 *
 * Opt-in: for most workloads the per-attempt `timeout` policy is enough.
 * The watchdog catches `fn` calls that ignore the signal AND have no
 * timeout configured.
 *
 * @param thresholdMs Pending threshold before the watchdog fires. Default 60s.
 * @param hooks       Hooks to fire onWatchdog on. Can also be passed to
 *                    act() calls; the watchdog fires on it independently.
 */
export function enableWatchdog(
  thresholdMs = 60_000,
  hooks?: ObservabilityHooks,
): void {
  // if the threshold changes, recreate the interval so check frequency
  // matches the new threshold. Otherwise the first call fixes the interval
  // forever: enableWatchdog(100) after enableWatchdog(60_000) would leave
  // the interval at 15s, defeating the 100ms threshold.
  const prevThreshold = watchdogThresholdMs
  watchdogThresholdMs = thresholdMs
  if (hooks) watchdogHooks.add(hooks)
  if (watchdogTimer && thresholdMs === prevThreshold) return // already enabled, no change
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }

  // Check every thresholdMs/4. For small thresholds (test scenarios with
  // thresholdMs=100), use thresholdMs directly to ensure timely firing.
  // Minimum 50ms prevents excessive CPU usage on tiny thresholds.
  const intervalMs = Math.max(50, Math.floor(thresholdMs / 4))
  watchdogTimer = setInterval(() => {
    if (globalInflightCount === 0) return
    if (inflightBusySince === undefined) return
    const elapsed = Date.now() - inflightBusySince
    if (elapsed < watchdogThresholdMs) return
    // fire ONCE per busy period. Without this, a stuck fn pages operators
    // every intervalMs for the entire stuck duration (a 10-min stuck fn
    // produced ~40 events at the default 15s interval). Now we fire once
    // when the threshold is first crossed, then stay quiet until the busy
    // period ends (inflight → 0) and a new one starts.
    if (watchdogFiredForBusySince === inflightBusySince) return
    watchdogFiredForBusySince = inflightBusySince

    // Busy period exceeded threshold; emit watchdog event.
    const event: WatchdogEvent = {
      type: 'watchdog',
      key: '<unknown>',
      traceId: '<watchdog>',
      timestamp: Date.now(),
      elapsedMs: elapsed,
      scope: '<process>',
    }
    for (const h of watchdogHooks) {
      safeCall(h.onWatchdog, event)
    }
  }, intervalMs)

  // unref so the watchdog doesn't keep the process alive on its own.
  const t = watchdogTimer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}

/**
 * Register an `ObservabilityHooks` object to receive `onWatchdog` events.
 * The hooks object can also be passed to act() calls; the watchdog fires
 * on it independently of any specific act() call.
 */
export function registerWatchdogHooks(hooks: ObservabilityHooks): void {
  watchdogHooks.add(hooks)
}

/**
 * Unregister a previously-registered `ObservabilityHooks` object so it
 * stops receiving `onWatchdog` events. No-op if never registered.
 *
 * Without this, long-running processes that pass fresh hooks objects per
 * request (e.g. a per-request logger) accumulate closures in the
 * `watchdogHooks` Set forever: a slow memory leak.
 */
export function unregisterWatchdogHooks(hooks: ObservabilityHooks): void {
  watchdogHooks.delete(hooks)
}

/**
 * Disable the watchdog and clear all registered hooks.
 * Safe to call multiple times.
 */
export function disableWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }
  watchdogHooks.clear()
}

export function recordError(scope: string, code: string, message: string): void {
  const s = getState(scope)
  s.lastError = { code, message, timestamp: Date.now() }
}

export function recordSuccess(scope: string): void {
  getState(scope).lastSuccessAt = Date.now()
}

/**
 * Health check function returned by {@link createHealthCheck}.
 * Call `()` to get a snapshot. Call `.dispose()` to stop the probe timer.
 */
export interface HealthCheckFn {
  (): HealthStatus
  /** Stop the probe timer if one was created. Safe to call multiple times. */
  dispose(): void
}

/**
 * Create a health check function for a specific store + scope.
 *
 * @param store   The store to report `storeSize` from.
 * @param scope   Which scope's inflight/error/success data to report.
 *                Default 'default' (the scope used by `act()` without
 *                `withStore`). For scoped stores, pass the same scope
 *                string the scoped `act()` uses; typically the scope ID
 *                returned internally by `withStore`.
 *
 * The `scope` parameter is respected; the health check reports data only
 * for the named scope. Optional `probeIntervalMs` schedules a periodic
 * probe that emits a console.warn when an inflight slot is held > 60s
 * (useful for long-running processes where a stuck fn would otherwise
 * hold a slot forever). The returned function has a `.dispose()` method
 * that stops the probe timer.
 */
export function createHealthCheck(
  store: InMemoryStore,
  options?: { scope?: string; probeIntervalMs?: number },
): HealthCheckFn {
  // Resolve scope in priority order: explicit option > scope registered by
  // withStore() for this store > 'default'. This closes the foot-gun where
  // withStore(store) + createHealthCheck(store) read different scopes and
  // the health check silently reports stale data.
  const scope = options?.scope ?? resolveStoreScope(store) ?? 'default'
  const probeIntervalMs = options?.probeIntervalMs

  let probeTimer: ReturnType<typeof setInterval> | undefined
  if (probeIntervalMs && probeIntervalMs > 0) {
    probeTimer = setInterval(() => {
      const s = healthStates.get(scope)
      if (s && s.inflight > 0) {
        console.warn(
          `Actly: health probe detected ${s.inflight} in-flight calls in scope "${scope}" ` +
          `at ${new Date().toISOString()}. If this persists, a fn may be hung.`,
        )
      }
    }, probeIntervalMs)
    const t = probeTimer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  const checkFn = (): HealthStatus => {
    const s = healthStates.get(scope)
    return {
      storeSize: store.size(),
      pendingInflight: s?.inflight ?? 0,
      uptimeMs: Date.now() - startTime,
      lastError: s?.lastError,
      lastSuccessAt: s?.lastSuccessAt,
    }
  }

  // Attach dispose method so callers can stop the probe timer.
  checkFn.dispose = () => {
    if (probeTimer !== undefined) {
      clearInterval(probeTimer)
      probeTimer = undefined
    }
  }

  return checkFn as HealthCheckFn
}
