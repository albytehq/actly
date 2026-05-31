"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalTimeoutError = exports.TimeoutError = void 0;
exports.timeoutPolicy = timeoutPolicy;
exports.totalTimeoutPolicy = totalTimeoutPolicy;
// ─── Errors ───────────────────────────────────────────────────────────────────
class TimeoutError extends Error {
    constructor(ms) {
        super(`ACT timed out after ${ms}ms`);
        this.name = 'TimeoutError';
        this.ms = ms;
    }
}
exports.TimeoutError = TimeoutError;
/**
 * Thrown when the total budget across all attempts is exceeded.
 * Distinct from TimeoutError (per-attempt) so callers can instanceof-check
 * which deadline fired.
 */
class TotalTimeoutError extends Error {
    constructor(ms) {
        super(`ACT total timeout exceeded after ${ms}ms`);
        this.name = 'TotalTimeoutError';
        this.ms = ms;
    }
}
exports.TotalTimeoutError = TotalTimeoutError;
// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Shared race-against-a-timer logic. ErrorCtor lets callers pick the error type. */
function makeTimeoutPolicy(opts, ErrorCtor) {
    return (fn, _ctx) => () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ErrorCtor(opts.ms)), opts.ms);
        fn()
            .then((v) => { clearTimeout(timer); resolve(v); })
            .catch((e) => { clearTimeout(timer); reject(e); });
    });
}
// ─── Policies ─────────────────────────────────────────────────────────────────
/**
 * Races fn against a hard deadline.
 * Rejects with TimeoutError if the deadline fires first.
 *
 * Place this INSIDE retryPolicy (closer to fn) so each attempt has its own clock.
 */
function timeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TimeoutError);
}
/**
 * Races the ENTIRE operation (all retry attempts + delays) against a budget.
 * Rejects with TotalTimeoutError if the budget is exhausted.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
function totalTimeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TotalTimeoutError);
}
