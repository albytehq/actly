import type { ActFn, PolicyApplier, PolicyContext, TimeoutOptions } from '../types/index.js'
import { linkSignal } from '../utils/abort.js'
import { safeCall } from '../utils/safeCall.js'
import { TimeoutError, TotalTimeoutError } from '../errors.js'

// TimeoutError / TotalTimeoutError live in src/errors.ts and extend ActlyError.
// Re-exported here for callers using the deep import path.
export { TimeoutError, TotalTimeoutError }

// ─── Policy ───────────────────────────────────────────────────────────────────

/**
 * Build a timeout policy that throws `ErrorCtor` on deadline.
 *
 * Each invocation arms a `setTimeout` that aborts a fresh controller, links
 * the parent signal (so parent abort propagates), then races `fn(childSignal)`
 * against the abort event. The race lets `act()` return promptly even if `fn`
 * ignores the signal; if `fn` cooperates (passes signal to fetch, etc.) the
 * underlying work is cancelled cleanly.
 *
 * If the per-attempt timer fires, throws `ErrorCtor(ms)`. If the parent
 * fires first, throws the parent's reason (`TotalTimeoutError`, AbortError,
 * etc.).
 */
function makeTimeoutPolicy<T>(
  opts: TimeoutOptions,
  errorCtor: new (ms: number, options?: { key?: string }) => Error,
  kind: 'per-attempt' | 'total',
): PolicyApplier<T> {
  // 'race' (default) returns promptly at ms. 'cooperative' waits for fn to
  // settle after the signal aborts - gentler on non-cooperating downstreams
  // but can hang forever if fn never rejects.
  const strategy = opts.strategy ?? 'race'

  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (parentSignal: AbortSignal) => {
      const controller = new AbortController()
      const timerError = new errorCtor(opts.ms, { key: ctx.key })

      // allocate the error once so the stack points here, not at setTimeout's
      // internal callback
      const obs = ctx.observability
      let timedOut = false
      const timer = setTimeout(
        () => {
          timedOut = true
          // emit before aborting so observers can correlate
          if (obs) {
            safeCall(obs.hooks.onTimeout, {
              type: 'timeout', key: ctx.key, traceId: obs.traceId,
              timestamp: Date.now(), kind, ms: opts.ms,
            })
          }
          controller.abort(timerError)
        },
        opts.ms,
      )

      const unlink = linkSignal(parentSignal, controller)

      try {
        if (strategy === 'cooperative') {
          // wait for fn to settle after the signal aborts; if fn settles
          // before the timer, return that. If fn never rejects (ignores
          // signal), we wait forever - the cooperative trade-off.
          // honour a pre-aborted parent up front, matching 'race' behaviour.
          if (parentSignal.aborted) {
            throw parentSignal.reason
          }
          try {
            const value = await fn(controller.signal)
            return value
          } catch (err) {
            // timer fired + fn cooperated: throw the timer error (more
            // informative); otherwise surface fn's actual error
            if (timedOut) throw timerError
            throw err
          }
        }

        // 'race' strategy: race fn against the abort event
        return await new Promise<T>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(controller.signal.reason)
            return
          }

          const onAbort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', onAbort, { once: true })

          Promise.resolve(fn(controller.signal)).then(
            (value) => {
              controller.signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
            (error) => {
              controller.signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
        })
      } finally {
        clearTimeout(timer)
        unlink()
      }
    }
}

/**
 * Per-attempt timeout. Races `fn` against a deadline that resets on retry.
 * Place INSIDE `retryPolicy` so each attempt gets its own clock.
 */
export function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  return makeTimeoutPolicy(opts, TimeoutError, 'per-attempt')
}

/**
 * Operation-wide timeout. Races the whole chain (all retries + delays)
 * against a hard budget that does NOT reset. Place as the OUTERMOST policy.
 */
export function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  return makeTimeoutPolicy(opts, TotalTimeoutError, 'total')
}
