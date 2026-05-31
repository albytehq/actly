/** The async function ACT wraps */
export type ActFn<T> = () => Promise<T>;
/** Where a successful result came from */
export type ActSource = 'fresh' | 'cache';
export interface ActSuccess<T> {
    ok: true;
    value: T;
    source: ActSource;
    /** Number of attempts made before success */
    attempts: number;
}
export interface ActFailure {
    ok: false;
    error: unknown;
    /** Number of attempts made before final failure */
    attempts: number;
}
export type ActResult<T> = ActSuccess<T> | ActFailure;
export interface RetryOptions {
    /** Total number of attempts including the first call. Must be >= 1. */
    attempts: number;
    /** Base delay between attempts in ms. 0 = no delay. */
    delayMs?: number;
    /**
     * How the base delay grows per attempt:
     *  - 'none'        -> always delayMs
     *  - 'linear'      -> delayMs * attempt
     *  - 'exponential' -> delayMs * 2^(attempt-1)
     */
    backoff?: 'none' | 'linear' | 'exponential';
    /**
     * Predicate called after each failure, before the next attempt.
     * Return false to stop retrying immediately and surface the error.
     *
     * Use this to skip retries for errors that are definitively non-recoverable
     * (e.g. HTTP 4xx, AuthError, ValidationError).
     *
     * @param error   The error thrown by the most recent attempt.
     * @param attempt The 1-based number of the attempt that just failed.
     *
     * @example
     * shouldRetry: (err, attempt) =>
     *   !(err instanceof HttpError && err.status < 500)
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}
export interface TimeoutOptions {
    /** Abort after this many ms */
    ms: number;
}
export interface DedupeOptions {
    /**
     * Collapse concurrent calls sharing the same key into one in-flight Promise.
     * Opt-in: be explicit when you want this behaviour.
     */
    enabled: boolean;
}
export interface CacheOptions {
    /** Keep a successful result for this many ms */
    ttl: number;
}
export interface ActOptions {
    retry?: RetryOptions;
    timeout?: TimeoutOptions;
    /**
     * Collapse concurrent calls with the same key into one in-flight Promise.
     *
     * Shorthand:  `dedupe: true`
     * Full form:  `dedupe: { enabled: true }`
     *
     * Both are equivalent. The object form exists for forward compatibility.
     */
    dedupe?: boolean | DedupeOptions;
    cache?: CacheOptions;
    /**
     * Hard budget over the ENTIRE operation — including all retry attempts,
     * delays, and the timeout per attempt.
     *
     * Distinct from `timeout`, which resets the clock on every attempt.
     * Use both together to express: "each attempt may take at most X ms,
     * but the whole thing must finish within Y ms."
     *
     * Rejects with TotalTimeoutError if the deadline fires.
     */
    totalTimeout?: TimeoutOptions;
}
/**
 * Mutable bag mutated in-place during execution.
 * Policies annotate it; act() reads the final state to build ActResult.
 */
export interface RunMeta {
    attempts: number;
    source: ActSource;
}
/** Everything a policy receives about the current run */
export interface PolicyContext {
    key: string;
    store: StateStore;
    meta: RunMeta;
}
/**
 * The ONLY shape the executor knows about policies.
 *
 * A policy wraps ActFn<T> and returns a new ActFn<T>.
 * It may intercept before, after, or instead of the inner call.
 * The executor never imports a concrete policy — only this type.
 */
export type PolicyApplier<T> = (fn: ActFn<T>, ctx: PolicyContext) => ActFn<T>;
/** Minimal key-value contract used by dedupe and cache policies */
export interface StateStore {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
}
//# sourceMappingURL=index.d.ts.map