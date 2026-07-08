import type {
  ActFn,
  ActOptions,
  ActResult,
  PolicyApplier,
  RunMeta,
  AnyStateStore,
  SyncStateStore,
  AsyncStateStore,
  ObservabilityContext,
  ActlyFailedBy,
} from '../types/index.js'
import { execute }                from './executor.js'
import { retryPolicy }            from '../policies/retry.js'
import { timeoutPolicy, totalTimeoutPolicy } from '../policies/timeout.js'
import { dedupePolicy }           from '../policies/dedupe.js'
import { cachePolicy }            from '../policies/cache.js'
import { circuitBreakerPolicy }   from '../policies/circuitBreaker.js'
import { bulkheadPolicy }         from '../policies/bulkhead.js'
import { rateLimitPolicy }        from '../policies/rateLimit.js'
import { createDefaultStore }        from '../stores/memory.js'
import { isSyncStore }            from '../stores/base.js'
import { linkSignal, raceAbort }  from '../utils/abort.js'
import { sanitizeError, sanitizeErrorMessage } from '../utils/sanitize.js'
import { safeCall } from '../utils/safeCall.js'
import { registerInflight, unregisterInflight, recordError, recordSuccess, registerStoreScope } from './health.js'
import { registerDrainable, unregisterDrainable } from './shutdown.js'
import {
  assertKey,
  assertOptions,
} from '../utils/validate.js'
import type { ObservabilityHooks } from '../observability.js'
// HedgeTimeoutError lives in errors.ts so it shares the ActlyError taxonomy.
import { HedgeTimeoutError }      from '../errors.js'

// Module-level default store. Bounded (maxSize 10k, 60s sweep) so long-running
// servers don't leak. Pass your own InMemoryStore via withStore() for unbounded.
const defaultStore = createDefaultStore()

// Kept here so invalidate() doesn't need to import policy internals.
const CACHE_NS = 'cache:'

/**
 * Monotonic clock for durations. Date.now() is wall-clock and can jump
 * backwards under NTP/DST/VM restores; performance.now() is monotonic.
 * Falls back to Date.now() when performance is unavailable.
 */
function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * Trace ID for log/metric correlation. Uses crypto.randomUUID when available,
 * falls back to a timestamp+random string.
 */
function generateTraceId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `actly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build the observability context, or return undefined when there are no
 * hooks. Shared via PolicyContext.observability so every policy sees the
 * same traceId + hooks.
 */
function buildObservability(
  hooks: ObservabilityHooks | undefined,
  traceId: string | undefined,
): ObservabilityContext | undefined {
  // No hooks, no context. Policies check ctx.observability != null before
  // allocating events.
  if (!hooks) return undefined
  // Skip the allocation for an empty hooks object too.
  const hasAnyHook =
    !!hooks.onAttempt ||
    !!hooks.onRetry ||
    !!hooks.onCacheHit ||
    !!hooks.onCacheMiss ||
    !!hooks.onDedupeJoin ||
    !!hooks.onTimeout ||
    !!hooks.onFinalSuccess ||
    !!hooks.onFinalFailure ||
    !!hooks.onBackpressure ||
    !!hooks.onWatchdog
  if (!hasAnyHook) return undefined
  return {
    traceId: traceId ?? generateTraceId(),
    hooks,
    joinerCounter: 0,
  }
}

/**
 * Map a caught error to its `failedBy` bucket. Requires instanceof Error
 * for name sniffing so plain objects can't spoof it.
 */
function classifyFailure(error: unknown): ActlyFailedBy {
  if (error == null || typeof error !== 'object') return 'fn-error'
  const code = (error as { code?: string }).code
  if (code === 'ACTLY_ABORT') return 'abort'
  if (code === 'ACTLY_TIMEOUT') return 'timeout'
  if (code === 'ACTLY_TOTAL_TIMEOUT') return 'total-timeout'
  if (code === 'ACTLY_RETRY_EXHAUSTED') return 'retry-exhausted'
  if (code === 'ACTLY_VALIDATION') return 'validation'
  if (code === 'ACTLY_CIRCUIT_OPEN') return 'circuit-open'
  if (code === 'ACTLY_BULKHEAD_FULL') return 'bulkhead-full'
  if (code === 'ACTLY_RATE_LIMIT') return 'rate-limited'
  if (code === 'ACTLY_RESOURCE_EXHAUSTED') return 'resource-exhausted'
  if (code === 'ACTLY_HEDGE_TIMEOUT') return 'hedge-timeout'
  // Fall back to name sniffing for non-actly errors (DOMException abort etc.).
  if (error instanceof Error) {
    const name = (error as { name?: string }).name
    if (name === 'AbortError') return 'abort'
  }
  return 'fn-error'
}

/** Normalize `dedupe: true` shorthand. Returns undefined when disabled. */
function normalizeDedupe(
  opt: ActOptions['dedupe'],
): { enabled: true; inflightTtl?: number } | undefined {
  if (opt === true) return { enabled: true }
  if (opt && typeof opt === 'object' && opt.enabled) {
    // Skip 0/NaN: dedupePolicy defaults to 5min, which is safer than
    // 0 (immediate expiry) if a bad value slips through validation.
    if (opt.inflightTtl !== undefined && opt.inflightTtl !== 0 && !Number.isNaN(opt.inflightTtl)) {
      return { enabled: true, inflightTtl: opt.inflightTtl }
    }
    return { enabled: true }
  }
  return undefined
}

/**
 * Build the policy chain. Order is fixed (see executor.ts). No-op policies
 * like retry.attempts=1 are skipped.
 */
function buildPolicies<T>(options: ActOptions): Array<PolicyApplier<T>> {
  const dedupe = normalizeDedupe(options.dedupe)
  const policies: Array<PolicyApplier<T>> = []

  // outermost: rate limiter blocks before any work is done
  if (options.rateLimit) {
    policies.push(rateLimitPolicy<T>(options.rateLimit))
  }

  // breaker blocks when the downstream is failing
  if (options.circuitBreaker) {
    policies.push(circuitBreakerPolicy<T>(options.circuitBreaker))
  }

  // hard wall-clock budget over the whole operation
  if (options.totalTimeout && options.totalTimeout.ms > 0) {
    policies.push(totalTimeoutPolicy<T>(options.totalTimeout))
  }

  // cache hit short-circuits everything below
  if (options.cache && options.cache.ttl > 0) {
    policies.push(cachePolicy<T>(options.cache))
  }

  // bulkhead caps concurrency per key
  if (options.bulkhead) {
    policies.push(bulkheadPolicy<T>(options.bulkhead))
  }

  // dedupe collapses concurrent callers before retry fires
  if (dedupe) {
    policies.push(dedupePolicy<T>(dedupe))
  }

  // retry owns the attempt loop (attempts=1 is a no-op, skip)
  if (options.retry && options.retry.attempts > 1) {
    policies.push(retryPolicy<T>(options.retry))
  }

  // innermost: per-attempt clock, resets on every retry
  if (options.timeout && options.timeout.ms > 0) {
    policies.push(timeoutPolicy<T>(options.timeout))
  }

  return policies
}

/**
 * Build a root AbortController from options.signal. Pre-aborted signals
 * produce a pre-aborted controller; otherwise we link the user signal in.
 */
function buildRootSignal(
  userSignal: AbortSignal | undefined,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController()
  if (userSignal) {
    const unlink = linkSignal(userSignal, controller)
    return { controller, cleanup: unlink }
  }
  return { controller, cleanup: () => {} }
}

/**
 * Execute `fn` with the given reliability policies.
 *
 * @param key     Stable identifier for this action. Scopes dedupe + cache.
 * @param fn      Async work. Receives an AbortSignal for cooperative
 *                cancellation (legacy `() => Promise<T>` is still accepted,
 *                the signal is just ignored).
 * @param options Which policies to apply. All fields are optional.
 * @returns       ActResult<T>. Always resolves, never throws.
 *                Check `result.ok` before reading `result.value`.
 *
 * @example
 * const result = await act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, {
 *   retry:        { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout:      { ms: 5_000 },
 *   totalTimeout: { ms: 12_000 },
 *   dedupe:       true,
 *   cache:        { ttl: 60_000 },
 * })
 * if (result.ok) console.log(result.value, result.source, result.attempts)
 * else console.error(result.error)
 */
export async function act<T>(
  key: string,
  fn: ActFn<T>,
  options: ActOptions<T> = {},
): Promise<ActResult<T>> {
  assertKey(key)
  assertOptions(options)

  // Fast path: no options means no policies, no signal, no observability.
  const hasAnyOption =
    options.retry !== undefined ||
    options.timeout !== undefined ||
    options.totalTimeout !== undefined ||
    options.dedupe !== undefined ||
    options.cache !== undefined ||
    options.signal !== undefined ||
    options.observability !== undefined ||
    options.traceId !== undefined ||
    options.circuitBreaker !== undefined ||
    options.bulkhead !== undefined ||
    options.rateLimit !== undefined ||
    options.hedge !== undefined ||
    options.fallback !== undefined ||
    options.audit !== undefined

  if (!hasAnyOption) {
    // registerInflight can throw under high concurrency; convert to
    // ActFailure so the never-rejects contract holds on the fast path too.
    const startedAt = monotonicNow()
    try {
      registerInflight('default')
    } catch (e) {
      const now = monotonicNow()
      const durationMs = now - startedAt
      recordError('default', 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e))
      return { ok: false, error: e, attempts: 0, durationMs }
    }
    registerDrainable('default')
    try {
      const value = await fn(new AbortController().signal)
      recordSuccess('default')
      return { ok: true, value, source: 'fresh', attempts: 1, durationMs: monotonicNow() - startedAt }
    } catch (error) {
      recordError('default', 'fn-error', sanitizeErrorMessage(error))
      return { ok: false, error, attempts: 1, durationMs: monotonicNow() - startedAt }
    } finally {
      unregisterInflight('default')
      unregisterDrainable('default')
    }
  }

  const meta: RunMeta = { attempts: 1, source: 'fresh' }
  const { controller: rootController, cleanup } = buildRootSignal(options.signal)
  const observability = buildObservability(options.observability, options.traceId)
  // Propagate traceId even when no observability hooks are registered.
  const effectiveTraceId = observability?.traceId ?? options.traceId
  const startedAt = monotonicNow()
  const scope = 'default'

  // registerInflight throws when we hit the global budget; convert to
  // ActFailure so the never-rejects contract holds. cleanup() and the
  // observability/audit/recordError triple mirror every other failure path.
  try {
    registerInflight(scope)
  } catch (e) {
    cleanup()
    const now = monotonicNow()
    const durationMs = now - startedAt
    recordError(scope, 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e))
    if (observability) {
      safeCall(observability.hooks.onFinalFailure, {
        type: 'final-failure',
        key, traceId: observability.traceId, timestamp: Date.now(),
        attempts: 0, durationMs,
        failedBy: 'resource-exhausted', error: e,
      })
    }
    if (options.audit) {
      safeCall(options.audit.log, {
        key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
        ok: false, attempts: 0, failedBy: 'resource-exhausted',
        error: sanitizeError(e),
      })
    }
    return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs }
  }
  registerDrainable(scope)

  if (rootController.signal.aborted) {
    cleanup()
    unregisterInflight(scope)
    unregisterDrainable(scope)
    const error = rootController.signal.reason
    const now = Date.now()
    const durationMs = monotonicNow() - startedAt
    if (observability) {
      safeCall(observability.hooks.onFinalFailure, {
        type: 'final-failure',
        key, traceId: observability.traceId, timestamp: now,
        attempts: 0, durationMs,
        failedBy: 'abort', error,
      })
    }
    if (options.audit) {
      const sanitizedError = sanitizeError(error)
      safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError })
    }
    recordError(scope, 'ACTLY_ABORT', sanitizeErrorMessage(error))
    return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs }
  }

  // buildPolicies is mostly safe, but a buggy constructor could throw.
  // Wrap it so inflight + drainable counters get cleaned up, and surface
  // as ActFailure rather than re-throwing (contract: never rejects).
  let policies: Array<PolicyApplier<T>>
  try {
    policies = buildPolicies<T>(options)
  } catch (e) {
    cleanup()
    unregisterInflight(scope)
    unregisterDrainable(scope)
    const now = Date.now()
    const durationMs = monotonicNow() - startedAt
    recordError(scope, 'ACTLY_VALIDATION', sanitizeErrorMessage(e))
    if (observability) {
      safeCall(observability.hooks.onFinalFailure, {
        type: 'final-failure',
        key, traceId: observability.traceId, timestamp: now,
        attempts: 0, durationMs, failedBy: 'validation', error: e,
      })
    }
    if (options.audit) {
      safeCall(options.audit.log, {
        key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
        ok: false, attempts: 0, failedBy: 'validation',
        error: sanitizeError(e),
      })
    }
    return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs }
  }

  const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1)
  if (observability && !hasRetryPolicy) {
    safeCall(observability.hooks.onAttempt, {
      type: 'attempt', key, traceId: observability.traceId,
      timestamp: Date.now(), attempt: 1,
    })
  }

  // outside-retry (default): one hedge per act() call, regardless of
  // retries. inside-retry: each retry can spawn its own hedge, multiplying
  // downstream load.
  const hedgePlacement = options.hedge?.placement ?? 'outside-retry'
  const hedgeKeepLoser = options.hedge?.keepLoser ?? false
  // inside-retry wraps fn before execute(); outside-retry uses runWithHedge.
  const fnWithHedge = (options.hedge && hedgePlacement === 'inside-retry')
    ? wrapHedge(fn, options.hedge.delayMs, hedgeKeepLoser)
    : fn

  // Skip raceAbort when there's no user signal: the root controller can
  // never abort, so the wrapper's Promise + listener pair is pure overhead.
  const needsRaceAbort = options.signal !== undefined

  try {
    let value: T

    if (options.hedge && hedgePlacement === 'outside-retry') {
      // Each chain gets its own meta so primary/hedge don't race on
      // meta.attempts / meta.source. Winner's meta is copied to the main
      // meta after the race settles.
      const hedgeMeta: RunMeta = { attempts: 1, source: 'fresh' }
      const chainFactory = (signal: AbortSignal, m: RunMeta) => execute({
        key,
        fn: fnWithHedge,
        policies,
        store: defaultStore,
        meta: m,
        signal,
        observability,
      })

      const hedgeResult = needsRaceAbort
        ? await raceAbort(
            Promise.resolve(runWithHedge(
              chainFactory, meta, hedgeMeta,
              rootController.signal, options.hedge.delayMs, hedgeKeepLoser,
            )),
            rootController.signal,
          )
        : await runWithHedge(
            chainFactory, meta, hedgeMeta,
            rootController.signal, options.hedge.delayMs, hedgeKeepLoser,
          )
      // Copy winner's meta so ActResult reflects the winning chain's effort.
      meta.attempts = hedgeResult.winnerMeta.attempts
      meta.source = hedgeResult.winnerMeta.source
      value = hedgeResult.value
    } else {
      // No hedge, or inside-retry placement.
      const execPromise = execute({
        key,
        fn: fnWithHedge,
        policies,
        store: defaultStore,
        meta,
        signal: rootController.signal,
        observability,
      })
      value = needsRaceAbort
        ? await raceAbort(Promise.resolve(execPromise), rootController.signal)
        : await execPromise
    }
    const now = Date.now()
    const durationMs = monotonicNow() - startedAt
    recordSuccess(scope)
    if (observability) {
      safeCall(observability.hooks.onFinalSuccess, {
        type: 'final-success',
        key, traceId: observability.traceId, timestamp: now,
        source: meta.source, attempts: meta.attempts, durationMs,
      })
    }
    if (options.audit) {
      safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts })
    }
    return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
  } catch (error) {
    const durationMs = monotonicNow() - startedAt
    const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error)

    // Fallback: return fallback value instead of failure. Still record the
    // error so monitoring can see downstream failures the fallback masks.
    let errorRecorded = false
    if (options.fallback) {
      recordError(scope, failedBy, sanitizeErrorMessage(error))
      errorRecorded = true
      try {
        const fallbackValue = typeof options.fallback.value === 'function'
          ? await (options.fallback.value as () => T | Promise<T>)()
          : options.fallback.value
        if (observability) {
          safeCall(observability.hooks.onFinalSuccess, {
            type: 'final-success',
            key, traceId: observability.traceId, timestamp: Date.now(),
            source: meta.source, attempts: meta.attempts, durationMs,
          })
        }
        if (options.audit) {
          safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts })
        }
        return { ok: true, value: fallbackValue as T, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
      } catch (fallbackErr) {
        // Fallback itself failed. Surface to console + observability so
        // operators can discover the broken fallback.
        if (observability) {
          safeCall(observability.hooks.onFinalFailure, {
            type: 'final-failure',
            key, traceId: observability.traceId, timestamp: Date.now(),
            attempts: meta.attempts, durationMs,
            failedBy: 'fn-error', error: fallbackErr,
          })
        }
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
          console.warn(
            'Actly: fallback threw — error swallowed, surfacing original fn error.',
            fallbackErr,
          )
        }
      }
    }

    const sanitizedError = options.audit ? sanitizeError(error) : error
    if (!errorRecorded) {
      recordError(scope, failedBy, sanitizeErrorMessage(error))
    }
    if (observability) {
      safeCall(observability.hooks.onFinalFailure, {
        type: 'final-failure',
        key, traceId: observability.traceId, timestamp: Date.now(),
        attempts: meta.attempts, durationMs,
        failedBy, error,
      })
    }
    if (options.audit) {
      safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError })
    }
    return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
  } finally {
    cleanup()
    unregisterInflight(scope)
    unregisterDrainable(scope)
  }
}

// Hedge: send a second call after delayMs, race them, cancel the loser.
//
// Each call gets its own AbortController so we can abort the loser on
// settle. If fn cooperates with the signal, downstream work is cancelled
// too. keepLoser:true skips the abort (rarely what you want: the loser
// keeps eating downstream resources until it settles naturally).
//
// The hedge timeout is a dedicated Error subclass (not a string sentinel)
// so user-thrown errors can't be misclassified as the timer firing.
//
// Re-exported from errors.ts so callers can instanceof-check it. The class
// lives there to share the ActlyError taxonomy.
export { HedgeTimeoutError } from '../errors.js'

function wrapHedge<T>(
  fn: ActFn<T>,
  delayMs: number,
  keepLoser: boolean,
): ActFn<T> {
  return async (parentSignal: AbortSignal) => {
    // Each call gets its own controller so we can cancel the loser. Both
    // link to the parent so caller-cancel / totalTimeout propagates to both.
    const primaryCtl = new AbortController()
    const hedgeCtl = new AbortController()
    const unlinkPrimary = linkSignal(parentSignal, primaryCtl)
    const unlinkHedge = linkSignal(parentSignal, hedgeCtl)

    let timer: ReturnType<typeof setTimeout> | undefined
    let primary: Promise<T> | undefined
    let hedgePromise: Promise<T> | undefined

    try {
      primary = Promise.resolve(fn(primaryCtl.signal))

      const hedgeTimeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new HedgeTimeoutError()), delayMs)
      })

      try {
        // Race primary against the hedge timer. If primary wins, return.
        // If the timer fires first, launch the hedge and race both.
        return await Promise.race([primary, hedgeTimeout])
      } catch (e) {
        if (!(e instanceof HedgeTimeoutError)) {
          // Primary rejected with a real error; propagate. Cancel the
          // (unstarted) hedge controller for cleanliness.
          if (!keepLoser) hedgeCtl.abort(new Error('hedge cancelled: primary rejected'))
          throw e
        }
        // Timer fired; primary is still running. Launch the hedge.
        hedgePromise = Promise.resolve(fn(hedgeCtl.signal))

        // Swallow late rejections from the loser so they don't surface as
        // unhandled rejections.
        primary.catch(() => {})
        hedgePromise.catch(() => {})

        try {
          // Tag each promise so we only abort the LOSER. Aborting both
          // would cancel the winner's downstream side-effects (streaming
          // fetch bodies, DB cursor cleanup) even though it already settled.
          const primaryTagged = primary.then(v => ({ value: v, winner: 'primary' as const }))
          const hedgeTagged = hedgePromise.then(v => ({ value: v, winner: 'hedge' as const }))
          const winner = await Promise.race([primaryTagged, hedgeTagged])
          if (!keepLoser) {
            // Abort only the loser; winner stays alive for downstream cleanup.
            if (winner.winner === 'primary') {
              hedgeCtl.abort(new Error('hedge cancelled: loser'))
            } else {
              primaryCtl.abort(new Error('hedge cancelled: loser'))
            }
          }
          return winner.value
        } catch (err) {
          // One of them rejected. Cancel the other (unless keepLoser).
          if (!keepLoser) {
            primaryCtl.abort(new Error('hedge cancelled: loser rejected'))
            hedgeCtl.abort(new Error('hedge cancelled: loser rejected'))
          }
          throw err
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
      unlinkPrimary()
      unlinkHedge()
    }
  }
}

/**
 * Run a chain with hedge. Each chain (primary + hedge) gets its own
 * RunMeta so they don't race on attempts/source; winner's meta is copied
 * to the caller's main meta after the race settles. Used for
 * hedge.placement: 'outside-retry'.
 */
async function runWithHedge<T>(
  chainFactory: (signal: AbortSignal, meta: RunMeta) => Promise<T>,
  primaryMeta: RunMeta,
  hedgeMeta: RunMeta,
  parentSignal: AbortSignal,
  delayMs: number,
  keepLoser: boolean,
): Promise<{ value: T; winnerMeta: RunMeta }> {
  const primaryCtl = new AbortController()
  const hedgeCtl = new AbortController()
  const unlinkPrimary = linkSignal(parentSignal, primaryCtl)
  const unlinkHedge = linkSignal(parentSignal, hedgeCtl)

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const primary = Promise.resolve(chainFactory(primaryCtl.signal, primaryMeta))

    const hedgeTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HedgeTimeoutError()), delayMs)
    })

    try {
      const value = await Promise.race([primary, hedgeTimeout])
      return { value, winnerMeta: primaryMeta }
    } catch (e) {
      if (!(e instanceof HedgeTimeoutError)) {
        if (!keepLoser) hedgeCtl.abort(new Error('hedge cancelled: primary rejected'))
        throw e
      }

      // Timer fired; launch hedge with its own meta.
      const hedge = Promise.resolve(chainFactory(hedgeCtl.signal, hedgeMeta))
      primary.catch(() => {})
      hedge.catch(() => {})

      // Tag each promise with its meta so we know who won.
      const primaryTagged = primary.then(v => ({ value: v, winnerMeta: primaryMeta }))
      const hedgeTagged = hedge.then(v => ({ value: v, winnerMeta: hedgeMeta }))

      try {
        const winner = await Promise.race([primaryTagged, hedgeTagged])
        if (!keepLoser) {
          primaryCtl.abort(new Error('hedge cancelled: loser'))
          hedgeCtl.abort(new Error('hedge cancelled: loser'))
        }
        return winner
      } catch (err) {
        if (!keepLoser) {
          primaryCtl.abort(new Error('hedge cancelled: loser rejected'))
          hedgeCtl.abort(new Error('hedge cancelled: loser rejected'))
        }
        throw err
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    unlinkPrimary()
    unlinkHedge()
  }
}

/**
 * Invalidate the cached value for `key` on the default store. Only clears
 * the cache slot; in-flight dedupe entries are left to settle on their own.
 * Returns true if a cache entry was removed.
 *
 * @example
 * await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 * // ... user updates their profile ...
 * invalidate('user:42')  // next call re-fetches
 */
export function invalidate(key: string): boolean {
  assertKey(key)
  const cacheKey = CACHE_NS + key
  const existed = defaultStore.has(cacheKey)
  defaultStore.delete(cacheKey)
  return existed
}

// ─── withStore: scoped act() with explicit store ──────────────────────────────

/** Result of `withStore()` for a sync store: `act` + sync `invalidate`. */
export interface ScopedActSync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>
  invalidate(key: string): boolean
  /** The store this scope is bound to. Useful for `store.destroy()` etc. */
  readonly store: AnyStateStore
  /**
   * The internal scope string this scoped `act()` writes health/drain state
   * under. Pass to `createHealthCheck(store, { scope })` for explicit wiring,
   * or rely on auto-resolution via the WeakMap keyed by store instance.
   */
  readonly scope: string
}

/** Result of `withStore()` for an async store: `act` + async `invalidate`. */
export interface ScopedActAsync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>
  invalidate(key: string): Promise<boolean>
  readonly store: AnyStateStore
  /** @see ScopedActSync.scope */
  readonly scope: string
}

/**
 * Create a scoped `act` function bound to an explicit store. Use for SSR
 * request isolation, multi-tenant scenarios, or test isolation.
 *
 * The returned function has the same signature as `act()` plus an
 * `invalidate(key)` method and a `store` reference for cleanup. Sync stores
 * return `boolean` from `invalidate`; async stores return `Promise<boolean>`.
 *
 * @example
 * import { withStore, InMemoryStore } from 'actly'
 *
 * const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true })
 * const act = withStore(store)
 * try {
 *   await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 *   act.invalidate('user:42')  // next call re-fetches
 * } finally {
 *   store.destroy()
 * }
 */
export function withStore(store: SyncStateStore): ScopedActSync
export function withStore(store: AsyncStateStore): ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync {
  // Use crypto.randomUUID when available (Node 20+) for collision-free
  // scope IDs. The 6-char Math.random fallback has a birthday-paradox
  // collision risk (~50% at ~47k scoped stores); per-request SSR or
  // per-tenant patterns would eventually collide and share state.
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const scope = 'scoped:' + (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14))
  // Register the scope so createHealthCheck(store) can resolve it
  // automatically. Without this, withStore(store) + createHealthCheck(store)
  // silently read different scopes: the health check never sees the errors
  // / inflight data the scoped act() records.
  registerStoreScope(store, scope)
  const scopedAct = async <T>(
    key: string,
    fn: ActFn<T>,
    options: ActOptions<T> = {},
  ): Promise<ActResult<T>> => {
    assertKey(key)
    assertOptions(options)

    const meta: RunMeta = { attempts: 1, source: 'fresh' }
    const { controller: rootController, cleanup } = buildRootSignal(options.signal)
    const observability = buildObservability(options.observability, options.traceId)
    // Propagate traceId even without observability hooks.
    const effectiveTraceId = observability?.traceId ?? options.traceId
    const startedAt = monotonicNow()

    // registerInflight can throw under high concurrency; convert to
    // ActFailure (mirrors the main act() path). cleanup() + observability/
    // audit/recordError triple included for parity.
    try {
      registerInflight(scope)
    } catch (e) {
      cleanup()
      const now = monotonicNow()
      const durationMs = now - startedAt
      recordError(scope, 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e))
      if (observability) {
        safeCall(observability.hooks.onFinalFailure, {
          type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
          attempts: 0, durationMs, failedBy: 'resource-exhausted', error: e,
        })
      }
      if (options.audit) {
        safeCall(options.audit.log, {
          key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
          ok: false, attempts: 0, failedBy: 'resource-exhausted',
          error: sanitizeError(e),
        })
      }
      return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs }
    }
    registerDrainable(scope)

    if (rootController.signal.aborted) {
      cleanup()
      unregisterInflight(scope)
      unregisterDrainable(scope)
      const error = rootController.signal.reason
      const now = Date.now()
      const durationMs = now - startedAt
      // Mirror the main act() pre-abort path: record + audit the error.
      recordError(scope, 'ACTLY_ABORT', sanitizeErrorMessage(error))
      if (observability) {
        safeCall(observability.hooks.onFinalFailure, {
          type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
          attempts: 0, durationMs, failedBy: 'abort', error,
        })
      }
      if (options.audit) {
        // Sanitize before logging: signal.reason can carry attacker-controlled
        // markup that would land verbatim in audit logs (log-injection / XSS
        // when rendered in a dashboard).
        const sanitizedError = sanitizeError(error)
        safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError })
      }
      return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs }
    }

    // Mirror the main act()'s try/catch around buildPolicies: a buggy
    // constructor could otherwise leak inflight + drain counters + signal
    // listener and reject (contract violation).
    let policies: Array<PolicyApplier<T>>
  try {
    policies = buildPolicies<T>(options)
  } catch (e) {
    cleanup()
    unregisterInflight(scope)
    unregisterDrainable(scope)
    const now = Date.now()
    const durationMs = monotonicNow() - startedAt
    recordError(scope, 'ACTLY_VALIDATION', sanitizeErrorMessage(e))
    if (observability) {
      safeCall(observability.hooks.onFinalFailure, {
        type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
        attempts: 0, durationMs, failedBy: 'validation', error: e,
      })
    }
    if (options.audit) {
      safeCall(options.audit.log, {
        key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
        ok: false, attempts: 0, failedBy: 'validation',
        error: sanitizeError(e),
      })
    }
    return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs }
  }

    const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1)
    if (observability && !hasRetryPolicy) {
      safeCall(observability.hooks.onAttempt, {
        type: 'attempt', key, traceId: observability.traceId,
        timestamp: Date.now(), attempt: 1,
      })
    }

    const hedgePlacement = options.hedge?.placement ?? 'outside-retry'
    const hedgeKeepLoser = options.hedge?.keepLoser ?? false
    const fnWithHedge = (options.hedge && hedgePlacement === 'inside-retry')
      ? wrapHedge(fn, options.hedge.delayMs, hedgeKeepLoser)
      : fn

    // Skip raceAbort when the root controller can never abort.
    const needsRaceAbort = options.signal !== undefined

    try {
      let value: T

      if (options.hedge && hedgePlacement === 'outside-retry') {
        // outside-retry: each chain gets its own meta to prevent race.
        const hedgeMeta: RunMeta = { attempts: 1, source: 'fresh' }
        const chainFactory = (signal: AbortSignal, m: RunMeta) => execute({
          key,
          fn: fnWithHedge,
          policies,
          store,
          meta: m,
          signal,
          observability,
        })

        const hedgeResult = needsRaceAbort
          ? await raceAbort(
              Promise.resolve(runWithHedge(
                chainFactory, meta, hedgeMeta,
                rootController.signal, options.hedge.delayMs, hedgeKeepLoser,
              )),
              rootController.signal,
            )
          : await runWithHedge(
              chainFactory, meta, hedgeMeta,
              rootController.signal, options.hedge.delayMs, hedgeKeepLoser,
            )
        meta.attempts = hedgeResult.winnerMeta.attempts
        meta.source = hedgeResult.winnerMeta.source
        value = hedgeResult.value
      } else {
        const execPromise = execute({
          key,
          fn: fnWithHedge,
          policies,
          store,
          meta,
          signal: rootController.signal,
          observability,
        })
        value = needsRaceAbort
          ? await raceAbort(Promise.resolve(execPromise), rootController.signal)
          : await execPromise
      }
      const now = Date.now()
      const durationMs = monotonicNow() - startedAt
      recordSuccess(scope)
      if (observability) {
        safeCall(observability.hooks.onFinalSuccess, {
          type: 'final-success', key, traceId: observability.traceId, timestamp: now,
          source: meta.source, attempts: meta.attempts, durationMs,
        })
      }
      if (options.audit) {
        safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts })
      }
      return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
    } catch (error) {
      const now = Date.now()
      const durationMs = monotonicNow() - startedAt
      const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error)

      let errorRecorded = false
      if (options.fallback) {
        recordError(scope, failedBy, sanitizeErrorMessage(error))
        errorRecorded = true
        try {
          const fallbackValue = typeof options.fallback.value === 'function'
            ? await (options.fallback.value as () => T | Promise<T>)()
            : options.fallback.value
          // Emit onFinalSuccess (parity with main act()).
          if (observability) {
            safeCall(observability.hooks.onFinalSuccess, {
              type: 'final-success', key, traceId: observability.traceId, timestamp: Date.now(),
              source: meta.source, attempts: meta.attempts, durationMs,
            })
          }
          // Fresh timestamp: fallback may have taken time.
          if (options.audit) {
            safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts })
          }
          return { ok: true, value: fallbackValue as T, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
        } catch (fallbackErr) {
          // Surface fallback failure to console + observability.
          if (observability) {
            safeCall(observability.hooks.onFinalFailure, {
              type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
              attempts: meta.attempts, durationMs, failedBy: 'fn-error', error: fallbackErr,
            })
          }
          if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
            console.warn(
              'Actly: fallback threw — error swallowed, surfacing original fn error.',
              fallbackErr,
            )
          }
        }
      }

      if (!errorRecorded) {
        recordError(scope, failedBy, sanitizeErrorMessage(error))
      }
      if (observability) {
        safeCall(observability.hooks.onFinalFailure, {
          type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
          attempts: meta.attempts, durationMs, failedBy, error,
        })
      }
      if (options.audit) {
        const sanitizedError = sanitizeError(error)
        safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError })
      }
      return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
    } finally {
      cleanup()
      unregisterInflight(scope)
      unregisterDrainable(scope)
    }
  }

  // The cast through `unknown` is required because TS can't narrow the
  // union return type to match either overload signature individually.
  // Prefer store.deleteIfExists() when available (atomic, TOCTOU-free);
  // fall back to has()+delete(). Sync fallback is safe (no await can
  // interleave); async fallback has a known TOCTOU race.
  const invalidateImpl = (key: string): boolean | Promise<boolean> => {
    assertKey(key)
    const cacheKey = CACHE_NS + key
    if (isSyncStore(store)) {
      // Prefer atomic deleteIfExists when available.
      if (typeof store.deleteIfExists === 'function') {
        return store.deleteIfExists(cacheKey)
      }
      // Sync has()+delete() is safe: no await can interleave.
      const existed = store.has(cacheKey)
      store.delete(cacheKey)
      return existed
    }
    // Async store: prefer atomic deleteIfExists when available.
    if (typeof store.deleteIfExists === 'function') {
      return store.deleteIfExists(cacheKey)
    }
    // Fallback has a TOCTOU race between the awaits; return value is
    // unreliable under concurrency. Implementors should override
    // deleteIfExists for correctness.
    return (async () => {
      const existed = await store.has(cacheKey)
      await store.delete(cacheKey)
      return existed
    })()
  }

  // Object.assign (not mutation) so the types narrow cleanly at the call
  // site. The cast through `unknown` is necessary because the impl
  // signature is wider than either overload.
  return Object.assign(scopedAct, {
    invalidate: invalidateImpl,
    store,
    scope,
  }) as unknown as ScopedActSync | ScopedActAsync
}
