import type { ActFn, PolicyApplier, PolicyContext, TimeoutOptions } from '../types.js'
import { linkSignal } from '../abort.js'
import { safeCall } from '../safeCall.js'
import { assertTimeoutOptions } from '../validate.js'
import { TimeoutError, TotalTimeoutError } from '../errors.js'

export { TimeoutError, TotalTimeoutError }

/**
 * Per-attempt timeout: races `fn(childSignal)` against a deadline.
 * `'race'` (default) rejects at `ms` even if `fn` ignores the signal;
 * `'cooperative'` aborts the signal but waits for `fn` to settle.
 * Parent aborts propagate to the child signal.
 */
function makeTimeoutPolicy<T>(
  opts: TimeoutOptions,
  errorCtor: new (ms: number, options?: { key?: string }) => Error,
  kind: 'per-attempt' | 'total',
): PolicyApplier<T> {
  const strategy = opts.strategy ?? 'race'

  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (parentSignal: AbortSignal) => {
      const controller = new AbortController()
      let timedOut = false
      let timerError: Error | undefined
      const obs = ctx.observability

      // The error is created lazily inside the timer so the happy path
      // (deadline never fires) pays no Error allocation or stack capture.
      const timer = setTimeout(() => {
        timedOut = true
        timerError = new errorCtor(opts.ms, { key: ctx.key })
        if (obs) {
          safeCall(obs.hooks.onTimeout, {
            type: 'timeout', key: ctx.key, traceId: obs.traceId,
            timestamp: Date.now(), kind, ms: opts.ms,
          })
        }
        controller.abort(timerError)
      }, opts.ms)

      const unlink = linkSignal(parentSignal, controller)

      try {
        if (strategy === 'cooperative') {
          if (parentSignal.aborted) {
            throw parentSignal.reason
          }
          try {
            return await fn(controller.signal)
          } catch (err) {
            // timer fired + fn cooperated: prefer the timer error
            if (timedOut) throw timerError ?? new errorCtor(opts.ms, { key: ctx.key })
            throw err
          }
        }

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
 * Per-attempt timeout. Place INSIDE `retryPolicy` so each attempt gets its own clock.
 * Options are validated at construction: `ms: Infinity` would otherwise
 * reach `setTimeout`, which clamps it to a 1 ms fire (Node) — a timeout
 * that times out everything almost immediately.
 */
export function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  assertTimeoutOptions(opts, 'timeout')
  return makeTimeoutPolicy(opts, TimeoutError, 'per-attempt')
}

/** Operation-wide timeout. Place as the OUTERMOST policy. Same construction validation. */
export function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  assertTimeoutOptions(opts, 'totalTimeout')
  return makeTimeoutPolicy(opts, TotalTimeoutError, 'total')
}
