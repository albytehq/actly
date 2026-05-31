import type { PolicyApplier, TimeoutOptions } from '../types/index.js';
export declare class TimeoutError extends Error {
    readonly ms: number;
    constructor(ms: number);
}
/**
 * Thrown when the total budget across all attempts is exceeded.
 * Distinct from TimeoutError (per-attempt) so callers can instanceof-check
 * which deadline fired.
 */
export declare class TotalTimeoutError extends Error {
    readonly ms: number;
    constructor(ms: number);
}
/**
 * Races fn against a hard deadline.
 * Rejects with TimeoutError if the deadline fires first.
 *
 * Place this INSIDE retryPolicy (closer to fn) so each attempt has its own clock.
 */
export declare function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
/**
 * Races the ENTIRE operation (all retry attempts + delays) against a budget.
 * Rejects with TotalTimeoutError if the budget is exhausted.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
export declare function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
//# sourceMappingURL=timeout.d.ts.map