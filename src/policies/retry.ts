import type { ActFn, PolicyApplier, PolicyContext, RetryOptions } from '../types/index.js'
import { computeDelay } from '../utils/backoff.js'
import { isAbortError, sleep } from '../utils/abort.js'
import { safeCall } from '../utils/safeCall.js'
import { RetryExhaustedError } from '../errors.js'
import { LIMITS } from '../utils/limits.js'

// ─── Default predicate ────────────────────────────────────────────────────────

/**
 * Default `shouldRetry`: retry on any error except aborts and per-attempt
 * `TimeoutError`. Retrying an abort just aborts again; retrying a slow
 * endpoint that always times out multiplies wall-clock latency by `attempts`.
 * Override with `shouldRetry: () => true` to retry on timeouts.
 */
function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  if (isAbortError(error)) return false
  // .code string check survives cross-realm boundary loss
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: string }).code
    if (code === 'ACTLY_TIMEOUT' || code === 'ACTLY_TOTAL_TIMEOUT') return false
  }
  return true
}

// ─── Policy ───────────────────────────────────────────────────────────────────

/**
 * Retry `fn` up to `opts.attempts` times on retryable errors. Writes the
 * live attempt count into `ctx.meta.attempts`.
 *
 * Before each attempt, checks `parentSignal.aborted` so a `totalTimeout`
 * or caller cancel bails immediately. Backoff sleeps are also signal-aware.
 *
 * `shouldRetry` is called after every failure (including the last) so
 * observers see one call per attempt; the return value is only consulted
 * when `attempt < max`. Omitting it uses `defaultShouldRetry`.
 */
export function retryPolicy<T>(opts: RetryOptions): PolicyApplier<T> {
  const max = Math.max(1, Math.floor(opts.attempts))
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry
  const shouldRetryResult = opts.shouldRetryResult
  // unref the sleep timer so CLI/test processes can exit mid-retry
  const dangerouslyUnref = opts.dangerouslyUnref === true
  const sleepOpts = dangerouslyUnref ? { unref: true } : undefined
  // backoffFn overrides backoff + jitter; state persists across attempts
  // in this call only.
  const backoffFn = opts.backoffFn

  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (parentSignal: AbortSignal) => {
      const backoffState: Record<string, unknown> = {}
      // lazy errors[] - happy path allocates nothing
      let errors: unknown[] | undefined
      let retriedAtLeastOnce = false
      const obs = ctx.observability

      for (let attempt = 1; attempt <= max; attempt++) {
        if (parentSignal.aborted) throw parentSignal.reason

        ctx.meta.attempts = attempt
        const attemptStart = Date.now()

        try {
          // emit before the attempt so observers can track in-flight calls
          if (obs) {
            safeCall(obs.hooks.onAttempt, {
              type: 'attempt', key: ctx.key, traceId: obs.traceId,
              timestamp: attemptStart, attempt,
            })
          }
          const value = await fn(parentSignal)

          // shouldRetryResult: inspect a non-throwing return (e.g. fetch 500)
          // and decide whether to retry.
          if (shouldRetryResult) {
            let accept: boolean
            try {
              const raw = shouldRetryResult(value, attempt)
              // an async predicate accidentally returns a Promise (truthy) -
              // treat non-boolean returns as "accept" so predicate bugs
              // surface the original value rather than looping forever.
              accept = typeof raw === 'boolean' ? raw : true
            } catch {
              return value
            }
            if (accept) return value

            const syntheticError = new Error(
              `Actly: shouldRetryResult returned false on attempt ${attempt}`,
            )
            if (errors === undefined) errors = []
            if (errors.length < 10) {
              errors.push(syntheticError)
            } else {
              errors.shift()
              errors.push(syntheticError)
            }

            // Exhausted retries on a predicate-rejected value: return the
            // last value (caller asked to retry, not to throw). Emit onRetry
            // with the synthetic error so dashboards distinguish this from
            // a clean accept.
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

            // backoffFn overrides computeDelay; if it throws, fall back to
            // computeDelay so a buggy fn doesn't mask the original error.
            // NaN poisons Math.min/max - clamp to 0 so a buggy backoffFn
            // can't silently disable backoff.
            let rawDelay: number
            try {
              rawDelay = backoffFn
                ? backoffFn(attempt, syntheticError, backoffState)
                : computeDelay(attempt, opts)
            } catch {
              rawDelay = computeDelay(attempt, opts)
            }
            const safeDelay = Number.isFinite(rawDelay) ? rawDelay : 0
            const delay = Math.min(Math.max(0, safeDelay), LIMITS.MAX_RETRY_DELAY_MS)
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
          if (errors === undefined) errors = []
          // cap at 10 - recent errors are the useful ones
          if (errors.length < 10) {
            errors.push(err)
          } else {
            errors.shift()
            errors.push(err)
          }

          // predicate throws: surface the original fn error, not the bug
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

          // backoffFn overrides computeDelay; if it throws, fall back to
          // computeDelay so a buggy fn doesn't mask the original error.
          // NaN poisons Math.min/max - clamp to 0 so a buggy backoffFn
          // can't silently disable backoff.
          let rawDelay: number
          try {
            rawDelay = backoffFn
              ? backoffFn(attempt, err, backoffState)
              : computeDelay(attempt, opts)
          } catch {
            rawDelay = computeDelay(attempt, opts)
          }
          const safeDelay = Number.isFinite(rawDelay) ? rawDelay : 0
          const delay = Math.min(Math.max(0, safeDelay), LIMITS.MAX_RETRY_DELAY_MS)

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

      // only reachable if max attempts was 0 - validation prevents it
      throw new Error('Actly: retryPolicy reached unreachable state')
    }
}
