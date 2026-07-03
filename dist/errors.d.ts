/**
 * Actly error taxonomy.
 *
 * Six classes (one abstract base + five concrete). Each carries a stable
 * `code` field so consumers can switch on strings instead of brittle
 * `instanceof` chains across realm boundaries (e.g. errors serialised
 * over IPC).
 *
 * # Why these six?
 *
 *  - `ActlyError`         — abstract base for `instanceof ActlyError` checks
 *  - `ActlyAbortError`    — caller / signal cancellation
 *  - `TimeoutError`       — per-attempt deadline
 *  - `TotalTimeoutError`  — operation-wide budget
 *  - `RetryExhaustedError`— last attempt's error wrapped with context
 *  - `ValidationError`    — programmer error (invalid options)
 *
 * NO circuit/bulkhead/rate-limit errors — those policies don't exist in
 * core. Adding orphan error classes violates the "every feature must map
 * to a real runtime failure mode" rule.
 *
 * # `code` field
 *
 * Stable string identifier. Use this for switch statements and telemetry
 * tags. The class name can change across versions; `code` won't.
 */
/** Base class for all actly errors. Enables `instanceof ActlyError` checks. */
export declare abstract class ActlyError extends Error {
    /** Stable string identifier. Use for telemetry / switch statements. */
    abstract readonly code: string;
    /** The key associated with the failure, if applicable. */
    readonly key?: string;
    constructor(message: string, options?: {
        key?: string;
        cause?: unknown;
    });
}
/**
 * Thrown when the caller's signal, per-attempt timeout, or total timeout
 * aborts the operation.
 *
 * `cause` carries the original abort reason (e.g. user-supplied
 * `controller.abort(new Error('user-cancelled'))` → cause.message is
 * 'user-cancelled').
 *
 * Wraps the raw abort reason in a typed error so consumers can
 * `instanceof`-check it consistently across all abort sources.
 */
export declare class ActlyAbortError extends ActlyError {
    readonly code: "ACTLY_ABORT";
    constructor(options?: {
        key?: string;
        cause?: unknown;
    });
}
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
export declare class TimeoutError extends ActlyError {
    readonly code: "ACTLY_TIMEOUT";
    readonly ms: number;
    constructor(ms: number, options?: {
        key?: string;
    });
}
/**
 * Thrown when the operation-wide `totalTimeout` budget fires.
 *
 * Distinct from `TimeoutError` (per-attempt) so callers can `instanceof`-check
 * which deadline fired.
 */
export declare class TotalTimeoutError extends ActlyError {
    readonly code: "ACTLY_TOTAL_TIMEOUT";
    readonly ms: number;
    constructor(ms: number, options?: {
        key?: string;
    });
}
/**
 * Thrown when all retry attempts are exhausted. The `lastError` is the
 * final attempt's error; `errors` is the array of all attempt errors
 * (useful for debugging patterns across retries).
 *
 * Wraps retry exhaustion with context so consumers can distinguish "single
 * fn error" from "retry exhausted after N attempts".
 *
 * # When is this thrown vs the raw error?
 *
 * `retryPolicy` throws `RetryExhaustedError` when:
 *  - `attempts > 1` AND
 *  - all attempts failed AND
 *  - the default `shouldRetry` (or user-supplied predicate) returned `true`
 *    for at least one failure
 *
 * If the user's `shouldRetry` returns `false` on the first attempt, the
 * raw error is thrown (no retries happened — not "exhausted").
 */
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
/**
 * Thrown on invalid option shapes / keys / store contracts. Programmer
 * errors — these surface synchronously, NOT as `ActFailure`, because the
 * caller's code is broken.
 *
 * Wraps the underlying `TypeError` / `RangeError` so consumers catching
 * `ActlyError` get a consistent type for all actly-thrown errors.
 */
export declare class ValidationError extends ActlyError {
    readonly code: "ACTLY_VALIDATION";
    constructor(message: string, options?: {
        field?: string;
    });
    readonly field?: string;
}
/** Thrown when a circuit breaker is open and blocks the call. */
export declare class CircuitBreakerOpenError extends ActlyError {
    readonly code: "ACTLY_CIRCUIT_OPEN";
    readonly key: string;
    constructor(key: string, ms: number);
}
/** Thrown when a bulkhead is full (maxConcurrent reached, queue timed out). */
export declare class BulkheadOverflowError extends ActlyError {
    readonly code: "ACTLY_BULKHEAD_FULL";
    readonly key: string;
    constructor(key: string, maxConcurrent: number);
}
/** Thrown when a rate limit is exceeded. */
export declare class RateLimitError extends ActlyError {
    readonly code: "ACTLY_RATE_LIMIT";
    readonly key: string;
    constructor(key: string, maxCalls: number, windowMs: number);
}
//# sourceMappingURL=errors.d.ts.map