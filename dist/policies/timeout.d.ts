import type { PolicyApplier, TimeoutOptions } from '../types/index.js';
import { TimeoutError, TotalTimeoutError } from '../errors.js';
export { TimeoutError, TotalTimeoutError };
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