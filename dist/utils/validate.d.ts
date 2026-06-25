import type { ActOptions, CacheOptions, DedupeOptions, RetryOptions, TimeoutOptions } from '../types/index.js';
/**
 * Validate user-facing option shapes. Throws `RangeError` / `TypeError` on
 * invalid input — these are programmer errors, not runtime failures, so
 * throwing (rather than returning an `ActFailure`) is the right call.
 *
 * Called once at the top of `act()` so policies can assume well-formed input.
 */
export declare function assertKey(key: string): void;
export declare function assertRetryOptions(opts: RetryOptions): void;
export declare function assertTimeoutOptions(opts: TimeoutOptions, field: string): void;
export declare function assertCacheOptions(opts: CacheOptions): void;
export declare function assertDedupeOptions(opts: DedupeOptions): void;
export declare function assertOptions(options: ActOptions): void;
//# sourceMappingURL=validate.d.ts.map