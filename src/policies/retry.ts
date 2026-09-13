import type { ActFn, PolicyApplier, PolicyContext, RetryOptions } from '../types.js'
import { computeDelay } from '../backoff.js'
import { isAbortError, sleep } from '../abort.js'
import { safeCall } from '../safeCall.js'
import { fillAttemptOutcome, type AttemptEvent } from '../observability.js'
import { assertRetryOptions } from '../validate.js'
import { RetryExhaustedError } from '../errors.js'
import { LIMITS } from '../limits.js'

/**
 * Default `shouldRetry`: retry every error except aborts and actly timeout
 * codes. Retrying an abort re-aborts; retrying a per-attempt timeout
 * multiplies wall-clock latency by `attempts`. Override with
 * `shouldRetry: () => true` to retry timeouts.
 */
function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  if (isAbortError(error)) return false
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: string }).code
    if (code === 'ACTLY_TIMEOUT' || code === 'ACTLY_TOTAL_TIMEOUT') return false
  }
  return true
}

/**
 * Retry `fn` up to `opts.attempts` times on retryable errors; writes the
 * live attempt count into `ctx.meta.attempts`. Checks `parentSignal.aborted`
 * before each attempt so totalTimeout or caller cancel bails immediately;
 * backoff sleeps are signal-aware.
 *
 * `shouldRetry` runs after every failure (including the last) so observers
 * see one call per attempt; the return value is only consulted when another
 * attempt remains.
 *
 * Options are validated at construction (since 1.4) — the same rules as
 * `act()` — so direct `execute()` users cannot silently get `attempts: 0`
 * coerced to 1.
 */
export function retryPolicy<T>(opts: RetryOptions): PolicyApplier<T> {
  assertRetryOptions(opts)
  const max = opts.attempts
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry
  const acceptResult = opts.acceptResult ?? opts.shouldRetryResult
  const dangerouslyUnref = opts.dangerouslyUnref === true
  const sleepOpts = dangerouslyUnref ? { unref: true } : undefined
  const backoffFn = opts.backoffFn

  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (parentSignal: AbortSignal) => {
      const backoffState: Record<string, unknown> = {}
      let errors: unknown[] | undefined
      let retriedAtLeastOnce = false
      const obs = ctx.observability

      for (let attempt = 1; attempt <= max; attempt++) {
        if (parentSignal.aborted) throw parentSignal.reason

        ctx.meta.attempts = attempt

        // Filled after the attempt settles (durationMs, error on failure).
        let attemptEvent: AttemptEvent | undefined
        if (obs) {
          attemptEvent = {
            type: 'attempt', key: ctx.key, traceId: obs.traceId,
            timestamp: Date.now(), attempt,
          }
          safeCall(obs.hooks.onAttempt, attemptEvent)
        }
        const attemptStart = attemptEvent !== undefined ? attemptEvent.timestamp : 0

        try {
          const value = await fn(parentSignal)

          if (attemptEvent !== undefined) {
            fillAttemptOutcome(attemptEvent, Date.now() - attemptStart, undefined)
          }

          if (acceptResult) {
            let accept: boolean
            try {
              const raw = acceptResult(value, attempt)
              // non-boolean returns (e.g. an async predicate leaking a
              // Promise) count as accept so the value surfaces, not a loop
              accept = typeof raw === 'boolean' ? raw : true
            } catch {
              return value
            }
            if (accept) return value

            const syntheticError = new Error(
              `Actly: acceptResult returned false on attempt ${attempt}`,
            )
            if (errors === undefined) errors = []
            if (errors.length < 10) errors.push(syntheticError)
            else { errors.shift(); errors.push(syntheticError) }

            if (attempt >= max) {
              if (obs) {
                safeCall(obs.hooks.onRetry, {
                  type: 'retry', key: ctx.key, traceId: obs.traceId,
                  timestamp: Date.now(), attempt, delayMs: 0,
                  error: syntheticError,
                })
              }
              return value
            }

            retriedAtLeastOnce = true
            if (parentSignal.aborted) throw parentSignal.reason

            const delay = computeSafeDelay(() =>
              backoffFn ? backoffFn(attempt, syntheticError, backoffState) : computeDelay(attempt, opts))
            if (obs) {
              safeCall(obs.hooks.onRetry, {
                type: 'retry', key: ctx.key, traceId: obs.traceId,
                timestamp: Date.now(), attempt, delayMs: delay,
                error: syntheticError,
              })
            }
            if (delay > 0) await sleep(delay, parentSignal, sleepOpts)
            continue
          }

          return value
        } catch (err) {
          if (attemptEvent !== undefined) {
            fillAttemptOutcome(attemptEvent, Date.now() - attemptStart, err)
          }
          if (errors === undefined) errors = []
          if (errors.length < 10) errors.push(err)
          else { errors.shift(); errors.push(err) }

          let retryable: boolean
          try {
            retryable = shouldRetry(err, attempt)
          } catch {
            throw err
          }

          if (attempt >= max) {
            if (retriedAtLeastOnce) {
              throw new RetryExhaustedError({
                key: ctx.key,
                attempts: attempt,
                lastError: err,
                errors: errors ?? [],
              })
            }
            throw err
          }

          if (!retryable) throw err

          retriedAtLeastOnce = true

          if (parentSignal.aborted) throw parentSignal.reason

          const delay = computeSafeDelay(() =>
            backoffFn ? backoffFn(attempt, err, backoffState) : computeDelay(attempt, opts))
          if (obs) {
            safeCall(obs.hooks.onRetry, {
              type: 'retry', key: ctx.key, traceId: obs.traceId,
              timestamp: Date.now(), attempt, delayMs: delay, error: err,
            })
          }

          if (delay > 0) {
            await sleep(delay, parentSignal, sleepOpts)
          }
        }
      }

      // unreachable: validation guarantees attempts >= 1
      throw new Error('Actly: retryPolicy reached unreachable state')
    }
}

// NaN poisons Math.min/max and a buggy backoffFn must not disable backoff:
// clamp non-finite results to 0, cap at MAX_RETRY_DELAY_MS.
function computeSafeDelay(compute: () => number): number {
  let rawDelay: number
  try {
    rawDelay = compute()
  } catch {
    rawDelay = 0
  }
  const safeDelay = Number.isFinite(rawDelay) ? rawDelay : 0
  return Math.min(Math.max(0, safeDelay), LIMITS.MAX_RETRY_DELAY_MS)
}
