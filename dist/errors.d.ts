export declare abstract class ActlyError extends Error {
    abstract readonly code: string;
    readonly key?: string;
    constructor(message: string, options?: {
        key?: string;
        cause?: unknown;
    });
    toJSON(opts?: {
        redact?: boolean;
    }): Record<string, unknown>;
}
export declare function isActlyError(e: unknown): e is ActlyError;
export declare class ActlyAbortError extends ActlyError {
    readonly code: "ACTLY_ABORT";
    constructor(options?: {
        key?: string;
        cause?: unknown;
    });
}
export declare class TimeoutError extends ActlyError {
    readonly code: "ACTLY_TIMEOUT";
    readonly ms: number;
    constructor(ms: number, options?: {
        key?: string;
        cause?: unknown;
    });
}
export declare class TotalTimeoutError extends ActlyError {
    readonly code: "ACTLY_TOTAL_TIMEOUT";
    readonly ms: number;
    constructor(ms: number, options?: {
        key?: string;
        cause?: unknown;
    });
}
export declare class RetryExhaustedError extends ActlyError {
    readonly code: "ACTLY_RETRY_EXHAUSTED";
    readonly attempts: number;
    readonly lastError: unknown;
    readonly errors: readonly unknown[];
    constructor(options: {
        key?: string;
        attempts: number;
        lastError: unknown;
        errors: readonly unknown[];
    });
}
export declare class ValidationError extends ActlyError {
    readonly code: "ACTLY_VALIDATION";
    constructor(message: string, options?: {
        field?: string;
        cause?: unknown;
    });
    readonly field?: string;
}
export declare class CircuitBreakerOpenError extends ActlyError {
    readonly code: "ACTLY_CIRCUIT_OPEN";
    readonly key: string;
    constructor(key: string, ms: number, options?: {
        cause?: unknown;
    });
}
export declare class BulkheadOverflowError extends ActlyError {
    readonly code: "ACTLY_BULKHEAD_FULL";
    readonly key: string;
    constructor(key: string, maxConcurrent: number, options?: {
        cause?: unknown;
    });
}
export declare class RateLimitError extends ActlyError {
    readonly code: "ACTLY_RATE_LIMIT";
    readonly key: string;
    constructor(key: string, maxCalls: number, windowMs: number, options?: {
        cause?: unknown;
    });
}
export declare class ResourceExhaustedError extends ActlyError {
    readonly code: "ACTLY_RESOURCE_EXHAUSTED";
    readonly current: number;
    readonly limit: number;
    constructor(current: number, limit: number, options?: {
        cause?: unknown;
    });
}
export declare class HedgeTimeoutError extends ActlyError {
    readonly code: "ACTLY_HEDGE_TIMEOUT";
    readonly delayMs: number;
    constructor(options?: {
        key?: string;
        delayMs?: number;
        cause?: unknown;
    });
}
//# sourceMappingURL=errors.d.ts.map