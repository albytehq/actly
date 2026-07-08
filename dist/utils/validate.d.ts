import type { ActOptions, AuditOptions, BulkheadOptions, CacheOptions, CircuitBreakerOptions, DedupeOptions, HedgeOptions, RateLimitOptions, RetryOptions, TimeoutOptions } from '../types/index.js';
export declare function assertKey(key: string): void;
export declare function assertRetryOptions(opts: RetryOptions): void;
export declare function assertTimeoutOptions(opts: TimeoutOptions, field: string): void;
export declare function assertCacheOptions(opts: CacheOptions): void;
export declare function assertDedupeOptions(opts: DedupeOptions): void;
export declare function assertOptions(options: ActOptions): void;
export declare function assertAuditOptions(opts: AuditOptions): void;
export declare function assertCircuitBreakerOptions(opts: CircuitBreakerOptions): void;
export declare function assertBulkheadOptions(opts: BulkheadOptions): void;
export declare function assertRateLimitOptions(opts: RateLimitOptions): void;
export declare function assertHedgeOptions(opts: HedgeOptions): void;
//# sourceMappingURL=validate.d.ts.map