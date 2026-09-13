import type { AnyStateStore } from '../types.js'
import { isSyncStore } from '../stores/contract.js'
import { LIMITS } from '../limits.js'
import { ResourceExhaustedError } from '../errors.js'
import type { ObservabilityHooks, WatchdogEvent } from '../observability.js'
import { assertObservabilityHooks } from '../validate.js'
import { safeCall } from '../safeCall.js'

/**
 * Map a store instance to the scope `withStore()` uses for it, so
 * `createHealthCheck(store)` resolves the scope automatically. WeakMap keys
 * do not keep the store alive.
 */
const storeScopes = new WeakMap<object, string>()

/** Register the scope a `withStore()` call uses for the given store. */
export function registerStoreScope(store: AnyStateStore, scope: string): void {
  storeScopes.set(store as unknown as object, scope)
}

/**
 * Resolve the scope registered for a store, if any; undefined for the
 * default store (scope `'default'`).
 */
export function resolveStoreScope(store: AnyStateStore): string | undefined {
  return storeScopes.get(store as unknown as object)
}

/** Health status for a single scope. */
export interface HealthStatus {
  /** Live entry count in the associated store. `-1` for async stores. */
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

const healthStates = new Map<string, HealthState>()
const startTime = Date.now()

// process-wide in-flight budget; prevents self-DoS from runaway callers.
// Opt out via ACTLY_NO_INFLIGHT_LIMIT=1 before the first act() call.
// Cached as module-level consts so V8 constant-folds the disabled check.
const INFLIGHT_LIMIT_DISABLED =
  process.env.ACTLY_NO_INFLIGHT_LIMIT === '1' ||
  process.env.ACTLY_NO_INFLIGHT_LIMIT === 'true'
const INFLIGHT_LIMIT = LIMITS.MAX_GLOBAL_INFLIGHT
let globalInflightCount = 0

// Watchdog busy-period tracking: the START of the 0→1 transition, not a
// per-call timestamp — refreshing under churn would never fire even when
// individual fns are hung.
let inflightBusySince: number | undefined
let watchdogTimer: ReturnType<typeof setInterval> | undefined
let watchdogThresholdMs = 60_000
const watchdogHooks = new Set<ObservabilityHooks>()
// which busy-period the watchdog already fired on, so a stuck fn does not
// page operators every interval for the whole stuck duration
let watchdogFiredForBusySince: number | undefined

function noteInflightUp(): void {
  if (inflightBusySince === undefined) {
    inflightBusySince = Date.now()
  }
}

function noteInflightDown(): void {
  if (globalInflightCount === 0) {
    inflightBusySince = undefined
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
  // prune idle scopes so high-cardinality multi-tenant scenarios do not
  // grow the Map unbounded; 'default' is reused every call and stays
  if (s.inflight === 0 && s.lastError === undefined && scope !== 'default') {
    healthStates.delete(scope)
  }
}

/**
 * Enable the in-flight watchdog: an unref'd background interval fires
 * `onWatchdog` once per busy period when in-flight work has been pending
 * longer than `thresholdMs`. Opt-in — the per-attempt `timeout` policy
 * covers most workloads.
 *
 * `thresholdMs` must be a positive finite number (validated since 1.4):
 * `NaN` or `Infinity` would reach `setInterval`, which clamps them to a
 * 1 ms busy loop, and a `NaN` threshold also fires the watchdog on every
 * tick. `hooks` are validated with the same rules as `act()`'s
 * observability hooks (typo'd hook names are rejected).
 *
 * @param thresholdMs Pending threshold before firing. Default 60s.
 * @param hooks       Hooks to fire on; also registrable via
 *                    {@link registerWatchdogHooks}.
 */
export function enableWatchdog(
  thresholdMs = 60_000,
  hooks?: ObservabilityHooks,
): void {
  if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new RangeError(
      `Actly: enableWatchdog thresholdMs must be a positive finite number, got ${thresholdMs}`,
    )
  }
  if (hooks) assertObservabilityHooks(hooks)
  // recreate the interval on a threshold change so the check frequency
  // matches the new threshold
  const prevThreshold = watchdogThresholdMs
  watchdogThresholdMs = thresholdMs
  if (hooks) watchdogHooks.add(hooks)
  if (watchdogTimer && thresholdMs === prevThreshold) return
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }

  const intervalMs = Math.max(50, Math.floor(thresholdMs / 4))
  watchdogTimer = setInterval(() => {
    if (globalInflightCount === 0) return
    if (inflightBusySince === undefined) return
    const elapsed = Date.now() - inflightBusySince
    if (elapsed < watchdogThresholdMs) return
    if (watchdogFiredForBusySince === inflightBusySince) return
    watchdogFiredForBusySince = inflightBusySince

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

  const t = watchdogTimer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}

/**
 * Register an `ObservabilityHooks` object to receive `onWatchdog` events
 * without passing it to every act() call. Same validation rules as
 * `act()`'s observability hooks: unknown hook names (typos) and
 * non-function values throw.
 */
export function registerWatchdogHooks(hooks: ObservabilityHooks): void {
  assertObservabilityHooks(hooks)
  watchdogHooks.add(hooks)
}

/**
 * Unregister a previously-registered hooks object. No-op if never
 * registered. Without this, per-request hooks objects accumulate in the
 * Set forever (a slow leak).
 */
export function unregisterWatchdogHooks(hooks: ObservabilityHooks): void {
  watchdogHooks.delete(hooks)
}

/** Disable the watchdog and clear all registered hooks. Idempotent. */
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
 * Call `()` for a snapshot; call `.dispose()` to stop the probe timer.
 */
export interface HealthCheckFn {
  (): HealthStatus
  /** Stop the probe timer if one was created. Safe to call multiple times. */
  dispose(): void
}

/**
 * Create a health check for a store + scope.
 *
 * @param store   Store to report `storeSize` from. Any store implementing
 *                the store contract works (since 1.4 — previously typed
 *                as the concrete InMemoryStore class). Async stores report
 *                `storeSize: -1` because `size()` is a Promise there.
 * @param scope   Which scope's inflight/error/success data to report.
 *                Defaults to the scope `withStore()` registered for this
 *                store, then `'default'`.
 * @param options.probeIntervalMs Optional periodic probe that warns when
 *                an inflight slot is held; the returned function's
 *                `.dispose()` stops it.
 */
export function createHealthCheck(
  store: AnyStateStore,
  options?: { scope?: string; probeIntervalMs?: number },
): HealthCheckFn {
  const scope = options?.scope ?? resolveStoreScope(store) ?? 'default'
  const probeIntervalMs = options?.probeIntervalMs
  if (probeIntervalMs !== undefined &&
      (typeof probeIntervalMs !== 'number' || !Number.isFinite(probeIntervalMs) || probeIntervalMs <= 0)) {
    throw new RangeError(
      `Actly: probeIntervalMs must be a positive finite number when provided, got ${probeIntervalMs}`,
    )
  }

  let probeTimer: ReturnType<typeof setInterval> | undefined
  if (probeIntervalMs) {
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
      storeSize: isSyncStore(store) ? store.size() : -1,
      pendingInflight: s?.inflight ?? 0,
      uptimeMs: Date.now() - startTime,
      lastError: s?.lastError,
      lastSuccessAt: s?.lastSuccessAt,
    }
  }

  checkFn.dispose = () => {
    if (probeTimer !== undefined) {
      clearInterval(probeTimer)
      probeTimer = undefined
    }
  }

  return checkFn as HealthCheckFn
}
