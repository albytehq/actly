import type { ActOptions, CacheOptions, DedupeOptions, RetryOptions, TimeoutOptions } from '../types/index.js';
/**
 * Validate user-facing option shapes. Throws `RangeError` / `TypeError` on
 * invalid input — these are programmer errors, not runtime failures, so
 * throwing (rather than returning an `ActFailure`) is the right call.
 *
 * Called once at the top of `act()` so policies can assume well-formed input.
 *
 * # Caps
 *
 * Every numeric input is bounded by {@link LIMITS}. This prevents memory
 * exhaustion (huge TTLs), CPU exhaustion (huge retry counts), and timer
 * overflow (huge delays). See `limits.ts` for rationale.
 */
export declare function assertKey(key: string): void;
export declare function assertRetryOptions(opts: RetryOptions): void;
export declare function assertTimeoutOptions(opts: TimeoutOptions, field: string): void;
export declare function assertCacheOptions(opts: CacheOptions): void;
export declare function assertDedupeOptions(opts: DedupeOptions): void;
export declare function assertOptions(options: ActOptions): void;
export declare function assertAuditOptions(opts: import('../types/index.js').AuditOptions): void;
export declare function assertCircuitBreakerOptions(opts: import('../types/index.js').CircuitBreakerOptions): void;
export declare function assertBulkheadOptions(opts: import('../types/index.js').BulkheadOptions): void;
export declare function assertRateLimitOptions(opts: import('../types/index.js').RateLimitOptions): void;
export declare function assertHedgeOptions(opts: import('../types/index.js').HedgeOptions): void;
//# sourceMappingURL=validate.d.ts.map