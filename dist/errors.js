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
export class ActlyError extends Error {
    /** The key associated with the failure, if applicable. */
    key;
    constructor(message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        if (options?.key !== undefined) {
            Object.defineProperty(this, 'key', { value: options.key, enumerable: true });
        }
        // Restore prototype chain after Error inheritance (TS es2022 target
        // may strip it). This ensures `instanceof` works correctly.
        Object.setPrototypeOf(this, new.target.prototype);
    }
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
export class ActlyAbortError extends ActlyError {
    code = 'ACTLY_ABORT';
    constructor(options) {
        const causeMsg = options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? 'aborted');
        super(`Actly operation aborted: ${causeMsg}`, options);
    }
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
export class TimeoutError extends ActlyError {
    code = 'ACTLY_TIMEOUT';
    ms;
    constructor(ms, options) {
        super(`ACT timed out after ${ms}ms`, options);
        this.ms = ms;
    }
}
/**
 * Thrown when the operation-wide `totalTimeout` budget fires.
 *
 * Distinct from `TimeoutError` (per-attempt) so callers can `instanceof`-check
 * which deadline fired.
 */
export class TotalTimeoutError extends ActlyError {
    code = 'ACTLY_TOTAL_TIMEOUT';
    ms;
    constructor(ms, options) {
        super(`ACT total timeout exceeded after ${ms}ms`, options);
        this.ms = ms;
    }
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
export class RetryExhaustedError extends ActlyError {
    code = 'ACTLY_RETRY_EXHAUSTED';
    attempts;
    lastError;
    errors;
    constructor(options) {
        const lastMsg = options.lastError instanceof Error ? options.lastError.message : String(options.lastError);
        super(`ACT retry exhausted after ${options.attempts} attempts; last error: ${lastMsg}`, { key: options.key, cause: options.lastError });
        this.attempts = options.attempts;
        this.lastError = options.lastError;
        this.errors = options.errors;
    }
}
/**
 * Thrown on invalid option shapes / keys / store contracts. Programmer
 * errors — these surface synchronously, NOT as `ActFailure`, because the
 * caller's code is broken.
 *
 * Wraps the underlying `TypeError` / `RangeError` so consumers catching
 * `ActlyError` get a consistent type for all actly-thrown errors.
 */
export class ValidationError extends ActlyError {
    code = 'ACTLY_VALIDATION';
    constructor(message, options) {
        super(message);
        if (options?.field !== undefined) {
            Object.defineProperty(this, 'field', { value: options.field, enumerable: true });
        }
    }
    field;
}
// ─── Hardening error classes ─────────────────────────────────────────────────
/** Thrown when a circuit breaker is open and blocks the call. */
export class CircuitBreakerOpenError extends ActlyError {
    code = 'ACTLY_CIRCUIT_OPEN';
    key;
    constructor(key, ms) {
        super(`Circuit breaker open for key "${key}" — retry after ${ms}ms`);
        this.key = key;
    }
}
/** Thrown when a bulkhead is full (maxConcurrent reached, queue timed out). */
export class BulkheadOverflowError extends ActlyError {
    code = 'ACTLY_BULKHEAD_FULL';
    key;
    constructor(key, maxConcurrent) {
        super(`Bulkhead full for key "${key}" — maxConcurrent ${maxConcurrent} reached`);
        this.key = key;
    }
}
/** Thrown when a rate limit is exceeded. */
export class RateLimitError extends ActlyError {
    code = 'ACTLY_RATE_LIMIT';
    key;
    constructor(key, maxCalls, windowMs) {
        super(`Rate limit exceeded for key "${key}" — ${maxCalls} calls per ${windowMs}ms`);
        this.key = key;
    }
}
//# sourceMappingURL=errors.js.map