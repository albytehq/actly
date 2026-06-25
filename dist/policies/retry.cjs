"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryPolicy = retryPolicy;
const backoff_js_1 = require("../utils/backoff.js");
const abort_js_1 = require("../utils/abort.js");
// ─── Default predicate ────────────────────────────────────────────────────────
/**
 * Default `shouldRetry`: retry on any error EXCEPT abort errors.
 *
 * Abort errors indicate the caller or a timeout cancelled the operation —
 * retrying would just abort again on the next attempt, wasting delay budget.
 *
 * User-supplied `shouldRetry` overrides this entirely.
 */
function defaultShouldRetry(error, _attempt) {
    return !(0, abort_js_1.isAbortError)(error);
}
// ─── Policy ───────────────────────────────────────────────────────────────────
/**
 * Retry `fn` up to `opts.attempts` times on retryable errors.
 *
 * Writes the live attempt count into `ctx.meta.attempts` so `act()` can
 * report it in the final `ActResult`.
 *
 * # Signal awareness
 *
 * - Before each attempt, checks `parentSignal.aborted`. If the parent (e.g.
 *   `totalTimeout` or caller) has aborted, throws the parent's reason
 *   immediately — no more attempts.
 * - Sleeps between attempts use `sleep(delay, parentSignal)`. If the parent
 *   aborts mid-delay, the sleep rejects immediately instead of blocking
 *   the loop until the timer would have elapsed.
 *
 * # `shouldRetry` invocation
 *
 * Called after EVERY failure, including the last attempt. This preserves the
 * predicate's contract for observers / metrics that rely on it being called
 * per-attempt. The return value is only consulted when `attempt < max`.
 *
 * # Default predicate
 *
 * If `shouldRetry` is omitted, uses `defaultShouldRetry` which retries on
 * every error EXCEPT abort errors (so timeouts and caller cancellations
 * don't waste retry budget).
 */
function retryPolicy(opts) {
    const max = Math.max(1, Math.floor(opts.attempts));
    const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
    return (fn, ctx) => async (parentSignal) => {
        let lastErr;
        for (let attempt = 1; attempt <= max; attempt++) {
            // Parent (totalTimeout or caller signal) already aborted — bail.
            if (parentSignal.aborted)
                throw parentSignal.reason;
            ctx.meta.attempts = attempt;
            try {
                return await fn(parentSignal);
            }
            catch (err) {
                lastErr = err;
                // Always invoke shouldRetry so observers see every failure.
                // The return value only matters when there are attempts left.
                const retryable = shouldRetry(err, attempt);
                if (attempt >= max) {
                    // Last attempt — surface the error regardless of retryable.
                    throw err;
                }
                if (!retryable) {
                    // Non-retryable error — bail immediately without consuming
                    // remaining attempts. The error surfaces exactly as-is.
                    throw err;
                }
                // Parent aborted mid-attempt — don't sleep, bail.
                if (parentSignal.aborted)
                    throw parentSignal.reason;
                const delay = (0, backoff_js_1.computeDelay)(attempt, opts);
                if (delay > 0) {
                    // Sleep is signal-aware: rejects immediately if parent aborts.
                    await (0, abort_js_1.sleep)(delay, parentSignal);
                }
            }
        }
        // Unreachable: the loop either returns or throws on every iteration.
        // The cast satisfies the type checker without a `throw` after the loop.
        throw lastErr;
    };
}
