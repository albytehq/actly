import type { PolicyApplier, TimeoutOptions } from '../types/index.js';
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
export declare class TimeoutError extends Error {
    readonly ms: number;
    constructor(ms: number);
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
export declare class TotalTimeoutError extends Error {
    readonly ms: number;
    constructor(ms: number);
}
/**
 * Per-attempt timeout. Races `fn` against a deadline that resets on retry.
 *
 * Place this INSIDE `retryPolicy` (closer to `fn`) so each attempt has its
 * own clock.
 */
export declare function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
/**
 * Operation-wide timeout. Races the ENTIRE chain (all retry attempts +
 * delays) against a hard budget that does NOT reset.
 *
 * Place this as the OUTERMOST policy so the clock starts before any other
 * policy runs and stops regardless of what the inner chain is doing.
 */
export declare function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
//# sourceMappingURL=timeout.d.ts.map