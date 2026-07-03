"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalTimeoutError = exports.TimeoutError = void 0;
exports.timeoutPolicy = timeoutPolicy;
exports.totalTimeoutPolicy = totalTimeoutPolicy;
const abort_js_1 = require("../utils/abort.js");
const errors_js_1 = require("../errors.js");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return errors_js_1.TimeoutError; } });
Object.defineProperty(exports, "TotalTimeoutError", { enumerable: true, get: function () { return errors_js_1.TotalTimeoutError; } });
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
    return (fn, ctx) => async (parentSignal) => {
        const controller = new AbortController();
        // Pass key to the error ctor for better debugging context.
        const timerError = new ErrorCtor(opts.ms, { key: ctx.key });
        // Arm the per-attempt timer. The error object is allocated once so the
        // stack trace points here (the policy frame), not at setTimeout's
        // internal callback.
        const timer = setTimeout(() => controller.abort(timerError), opts.ms);
        // NOTE: do NOT `unref()` this timer. The timeout IS the operation
        // the caller is awaiting. unref'ing would let Node exit the process
        // while a timeout was pending — silently dropping the operation.
        // The timer is cleared in the finally block below.
        // Link parent → child. Capture the unlink function so we can clean
        // up the listener on success path (contract).
        const unlink = (0, abort_js_1.linkSignal)(parentSignal, controller);
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
                const onAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve(fn(controller.signal)).then((value) => {
                    controller.signal.removeEventListener('abort', onAbort);
                    resolve(value);
                }, (error) => {
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(error);
                });
            });
        }
        finally {
            clearTimeout(timer);
            unlink();
        }
    };
}
/**
 * Per-attempt timeout. Races `fn` against a deadline that resets on retry.
 *
 * Place this INSIDE `retryPolicy` (closer to `fn`) so each attempt has its
 * own clock.
 */
function timeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, errors_js_1.TimeoutError);
}
/**
 * Operation-wide timeout. Races the ENTIRE chain (all retry attempts +
 * delays) against a hard budget that does NOT reset.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
function totalTimeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, errors_js_1.TotalTimeoutError);
}
