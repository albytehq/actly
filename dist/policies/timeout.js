import { linkSignal } from '../utils/abort.js';
// ─── Errors ───────────────────────────────────────────────────────────────────
/**
 * Thrown when a per-attempt `timeout` deadline fires.
 *
 * Carries the configured `ms` so callers can log/alert precisely:
 *
 * ```ts
 * if (!result.ok && result.error instanceof TimeoutError) {
 *   console.log(`attempt timed out after ${result.error.ms}ms`)
 * }
 * ```
 */
export class TimeoutError extends Error {
    ms;
    constructor(ms) {
        super(`ACT timed out after ${ms}ms`);
        this.name = 'TimeoutError';
        this.ms = ms;
    }
}
/**
 * Thrown when the operation-wide `totalTimeout` budget fires.
 *
 * Distinct from `TimeoutError` (per-attempt) so callers can `instanceof`-check
 * which deadline fired:
 *
 * ```ts
 * if (result.error instanceof TotalTimeoutError) {
 *   // whole operation budget exhausted
 * } else if (result.error instanceof TimeoutError) {
 *   // last attempt's per-attempt deadline fired
 * }
 * ```
 */
export class TotalTimeoutError extends Error {
    ms;
    constructor(ms) {
        super(`ACT total timeout exceeded after ${ms}ms`);
        this.name = 'TotalTimeoutError';
        this.ms = ms;
    }
}
// ─── Policy ───────────────────────────────────────────────────────────────────
/**
 * Build a timeout policy that throws `ErrorCtor` on deadline.
 *
 * # Cancellation contract
 *
 * Each invocation:
 *   1. Creates a fresh `AbortController` for this attempt.
 *   2. Arms a `setTimeout` that aborts the controller with a fresh `ErrorCtor(ms)`.
 *   3. Links the parent signal: if the parent aborts (e.g. `totalTimeout` or
 *      caller cancellation), the child aborts with the parent's reason.
 *   4. Races `fn(childSignal)` against the abort event.
 *
 * The race is critical: it ensures `act()` returns promptly even if `fn`
 * ignores the signal. The underlying `fn` may keep running in the background
 * (resource leak), but the caller is unblocked. This is the best JavaScript
 * can do without cooperation from `fn`.
 *
 * If `fn` cooperates (passes `signal` to `fetch`, `AbortController`, etc.),
 * the underlying work is cancelled properly — no leak.
 *
 * # Error attribution
 *
 * If the per-attempt timer fires, we throw `ErrorCtor(ms)` regardless of
 * what `fn` does. If the parent signal fires first, we throw the parent's
 * reason (could be `TotalTimeoutError`, an `AbortError`, or anything else).
 */
function makeTimeoutPolicy(opts, ErrorCtor) {
    return (fn, _ctx) => async (parentSignal) => {
        const controller = new AbortController();
        const timerError = new ErrorCtor(opts.ms);
        // Arm the per-attempt timer. The error object is allocated once so the
        // stack trace points here (the policy frame), not at setTimeout's
        // internal callback.
        const timer = setTimeout(() => controller.abort(timerError), opts.ms);
        // Link parent -> child. If parent is already aborted, child aborts
        // synchronously with parent's reason.
        linkSignal(parentSignal, controller);
        try {
            // Race fn against the abort event. If fn settles first, we get its
            // result/error. If the signal aborts first, we reject with reason.
            //
            // We do NOT use AbortSignal.timeout() here because we need to throw
            // our own ErrorCtor, not a DOMException named "TimeoutError".
            return await new Promise((resolve, reject) => {
                if (controller.signal.aborted) {
                    reject(controller.signal.reason);
                    return;
                }
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
                Promise.resolve(fn(controller.signal)).then((value) => resolve(value), (error) => reject(error));
            });
        }
        finally {
            clearTimeout(timer);
        }
    };
}
/**
 * Per-attempt timeout. Races `fn` against a deadline that resets on retry.
 *
 * Place this INSIDE `retryPolicy` (closer to `fn`) so each attempt has its
 * own clock.
 */
export function timeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TimeoutError);
}
/**
 * Operation-wide timeout. Races the ENTIRE chain (all retry attempts +
 * delays) against a hard budget that does NOT reset.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
export function totalTimeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TotalTimeoutError);
}
//# sourceMappingURL=timeout.js.map