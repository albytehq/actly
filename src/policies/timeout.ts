import type { ActFn, PolicyApplier, PolicyContext, TimeoutOptions } from '../types/index.js'

// ─── Errors ───────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  readonly ms: number

  constructor(ms: number) {
    super(`ACT timed out after ${ms}ms`)
    this.name = 'TimeoutError'
    this.ms = ms
  }
}

/**
 * Thrown when the total budget across all attempts is exceeded.
 * Distinct from TimeoutError (per-attempt) so callers can instanceof-check
 * which deadline fired.
 */
export class TotalTimeoutError extends Error {
  readonly ms: number

  constructor(ms: number) {
    super(`ACT total timeout exceeded after ${ms}ms`)
    this.name = 'TotalTimeoutError'
    this.ms = ms
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Shared race-against-a-timer logic. ErrorCtor lets callers pick the error type. */
function makeTimeoutPolicy<T>(
  opts: TimeoutOptions,
  ErrorCtor: new (ms: number) => Error,
): PolicyApplier<T> {
  return (fn: ActFn<T>, _ctx: PolicyContext): ActFn<T> =>
    () =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new ErrorCtor(opts.ms)),
          opts.ms
        )

        fn()
          .then((v: T)        => { clearTimeout(timer); resolve(v) })
          .catch((e: unknown) => { clearTimeout(timer); reject(e)  })
      })
}

// ─── Policies ─────────────────────────────────────────────────────────────────

/**
 * Races fn against a hard deadline.
 * Rejects with TimeoutError if the deadline fires first.
 *
 * Place this INSIDE retryPolicy (closer to fn) so each attempt has its own clock.
 */
export function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  return makeTimeoutPolicy(opts, TimeoutError)
}

/**
 * Races the ENTIRE operation (all retry attempts + delays) against a budget.
 * Rejects with TotalTimeoutError if the budget is exhausted.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
export function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T> {
  return makeTimeoutPolicy(opts, TotalTimeoutError)
}
