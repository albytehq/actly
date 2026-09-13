import type {
  ActFn,
  ActOptions,
  ActResult,
  PolicyApplier,
  RunMeta,
  AnyStateStore,
  ObservabilityContext,
} from '../types.js'
import { fillAttemptOutcome, type AttemptEvent, type ObservabilityHooks } from '../observability.js'
import { execute } from './executor.js'
import { hasAnyOption, buildPolicies } from './chain.js'
import { runWithHedge, wrapHedge } from './hedge.js'
import {
  classifyFailure, reportFailure, reportFailureNoRecord,
  reportSuccess, reportFallbackSuccess, type ReportContext,
} from './outcome.js'
import { registerInflight, unregisterInflight, recordError, recordSuccess } from './health.js'
import { registerDrainable, unregisterDrainable } from './shutdown.js'
import { linkSignal, raceAbort } from '../abort.js'
import { sanitizeErrorMessage } from '../errors.js'
import { safeCall, LOG_HOOK_ERRORS } from '../safeCall.js'
import { generateTraceId, monotonicNow } from './time.js'

// Shared, never-aborted signal for the fast path: zero allocation per call
// and identical observable semantics to a fresh controller that nothing
// can abort (no timeout, signal, or hedge exists on this path).
const FAST_SIGNAL = new AbortController().signal

/**
 * Build the observability context, or undefined when there are no hooks.
 * Shared via PolicyContext.observability so every policy sees the same
 * traceId + hooks.
 */
function buildObservability(
  hooks: ObservabilityHooks | undefined,
  traceId: string | undefined,
): ObservabilityContext | undefined {
  if (!hooks) return undefined
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
 * THE execution engine, shared by `act()` (default store, 'default' scope)
 * and `withStore()` scoped calls. The v1.3 layout duplicated this entire
 * flow in two places and the copies had drifted — the hedge regression
 * (BUG-CORE-015) shipped exactly that way. There is one copy now.
 *
 * Validation of key/options happens in the public wrappers (synchronously,
 * before any work starts). Runtime failures always resolve to
 * `ActResult`; this function never rejects.
 */
export async function runAct<T>(
  store: AnyStateStore,
  scope: string,
  key: string,
  fn: ActFn<T>,
  options: ActOptions<T>,
): Promise<ActResult<T>> {
  if (!hasAnyOption(options)) {
    return runFastPath(scope, fn)
  }
  return runFull(store, scope, key, fn, options)
}

async function runFastPath<T>(
  scope: string,
  fn: ActFn<T>,
): Promise<ActResult<T>> {
  const startedAt = monotonicNow()
  try {
    // registerInflight throws at the global in-flight budget; convert to
    // ActFailure so the never-rejects contract holds on the fast path too
    registerInflight(scope)
  } catch (e) {
    recordError(scope, 'resource-exhausted', sanitizeErrorMessage(e))
    return { ok: false, error: e, attempts: 0, durationMs: monotonicNow() - startedAt }
  }
  registerDrainable(scope)
  try {
    const value = await fn(FAST_SIGNAL)
    recordSuccess(scope)
    return { ok: true, value, source: 'fresh', attempts: 1, durationMs: monotonicNow() - startedAt }
  } catch (error) {
    recordError(scope, 'fn-error', sanitizeErrorMessage(error))
    return { ok: false, error, attempts: 1, durationMs: monotonicNow() - startedAt }
  } finally {
    unregisterInflight(scope)
    unregisterDrainable(scope)
  }
}

async function runFull<T>(
  store: AnyStateStore,
  scope: string,
  key: string,
  fn: ActFn<T>,
  options: ActOptions<T>,
): Promise<ActResult<T>> {
  const meta: RunMeta = { attempts: 1, source: 'fresh' }

  const rootController = new AbortController()
  const cleanup = options.signal !== undefined ? linkSignal(options.signal, rootController) : undefined

  const observability = buildObservability(options.observability, options.traceId)
  const effectiveTraceId = observability?.traceId ?? options.traceId
  const rc: ReportContext = { scope, key, observability, effectiveTraceId, audit: options.audit }

  const startedAt = monotonicNow()

  // The retry policy emits its own attempt events; the engine emits one
  // only when nothing else will, and fills its post-settle fields in both
  // the success and failure exits. Declared outside the try so the catch
  // can still fill it.
  let attemptEvent: AttemptEvent | undefined

  try {
    try {
      registerInflight(scope)
    } catch (e) {
      reportFailure(rc, 'resource-exhausted', e, 0, monotonicNow() - startedAt)
      return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs: monotonicNow() - startedAt }
    }
    registerDrainable(scope)

    if (rootController.signal.aborted) {
      const error = rootController.signal.reason
      reportFailure(rc, 'abort', error, 0, monotonicNow() - startedAt)
      return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs: monotonicNow() - startedAt }
    }

    // A buggy policy constructor must not reject (contract) or leak counters
    let policies: ReadonlyArray<PolicyApplier<T>>
    try {
      policies = buildPolicies<T>(options)
    } catch (e) {
      reportFailure(rc, 'validation', e, 0, monotonicNow() - startedAt)
      return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs: monotonicNow() - startedAt }
    }

    const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1)
    if (observability && !hasRetryPolicy) {
      attemptEvent = {
        type: 'attempt', key, traceId: observability.traceId,
        timestamp: Date.now(), attempt: 1,
      }
      safeCall(observability.hooks.onAttempt, attemptEvent)
    }

    const hedgePlacement = options.hedge?.placement ?? 'outside-retry'
    const hedgeKeepLoser = options.hedge?.keepLoser ?? false
    const fnWithHedge = (options.hedge && hedgePlacement === 'inside-retry')
      ? wrapHedge(fn, options.hedge.delayMs, hedgeKeepLoser)
      : fn

    // raceAbort is pure overhead when no user signal exists: the root
    // controller can never abort on its own
    const needsRaceAbort = options.signal !== undefined

    let value: T
    if (options.hedge && hedgePlacement === 'outside-retry') {
      // separate meta per chain so primary/hedge do not race on it; the
      // winner's meta is copied back after the race settles
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

      const hedgePromise = runWithHedge(
        chainFactory, meta, hedgeMeta,
        rootController.signal, options.hedge.delayMs, hedgeKeepLoser,
      )
      const hedgeResult = needsRaceAbort
        ? await raceAbort(hedgePromise, rootController.signal)
        : await hedgePromise
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
        ? await raceAbort(execPromise, rootController.signal)
        : await execPromise
    }

    const durationMs = monotonicNow() - startedAt
    if (attemptEvent !== undefined) {
      fillAttemptOutcome(attemptEvent, durationMs, undefined)
    }
    reportSuccess(rc, meta.source, meta.attempts, durationMs)
    return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
  } catch (error) {
    const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error)
    if (attemptEvent !== undefined) {
      fillAttemptOutcome(attemptEvent, monotonicNow() - startedAt, error)
    }

    if (options.fallback) {
      // record the masked downstream failure so monitoring can see it
      recordError(scope, failedBy, sanitizeErrorMessage(error))
      try {
        const fallbackValue = typeof options.fallback.value === 'function'
          ? await (options.fallback.value as () => T | Promise<T>)()
          : options.fallback.value
        // the fallback's own runtime is part of the call's duration
        const totalMs = monotonicNow() - startedAt
        reportFallbackSuccess(rc, meta.source, meta.attempts, totalMs)
        return { ok: true, value: fallbackValue as T, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs: totalMs }
      } catch (fallbackErr) {
        if (LOG_HOOK_ERRORS) {
          console.warn(
            'Actly: fallback threw — error swallowed, surfacing original fn error.',
            fallbackErr,
          )
        }
        // exactly one final-failure event: the ORIGINAL error is the
        // outcome; the fallback failure rides along as fallbackError
        const totalMs = monotonicNow() - startedAt
        reportFailureNoRecord(rc, failedBy, error, meta.attempts, totalMs, fallbackErr)
        return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs: totalMs }
      }
    }

    const durationMs = monotonicNow() - startedAt
    reportFailure(rc, failedBy, error, meta.attempts, durationMs)
    return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs }
  } finally {
    cleanup?.()
    unregisterInflight(scope)
    unregisterDrainable(scope)
  }
}
