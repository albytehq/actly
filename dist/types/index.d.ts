/**
 * The async function ACT wraps.
 *
 * Receives an {@link AbortSignal} that fires when:
 *  - the caller aborts via `options.signal`,
 *  - the per-attempt {@link TimeoutOptions} fires,
 *  - the operation-wide {@link ActOptions.totalTimeout} fires.
 *
 * Cooperative cancellation: pass `signal` through to `fetch`, `AbortController`,
 * database drivers, or any primitive that accepts one. If you ignore it, ACT
 * will still return promptly (the outer promise rejects), but the underlying
 * work will keep running in the background — leaking resources until it
 * settles on its own.
 *
 * Backwards compatible: `() => Promise<T>` is assignable to this type, so
 * existing call sites continue to compile and run. They simply forgo
 * cancellation.
 *
 * @example
 * // Cooperative
 * act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, { timeout: { ms: 5_000 } })
 *
 * @example
 * // Legacy (still works, signal ignored)
 * act('user:42', () => fetchUser(42))
 */
export type ActFn<T> = (signal: AbortSignal) => Promise<T> | T;
/** Where a successful result came from. */
export type ActSource = 'fresh' | 'cache';
export interface ActSuccess<T> {
    ok: true;
    value: T;
    source: ActSource;
    /**
     * Number of attempts made before success.
     *
     * - Fresh success on first try: `1`
     * - Fresh success after N retries: `N`
     * - Cache hit: `0` (no work was performed)
     * - Dedupe joiner: mirrors the originator's attempt count
     */
    attempts: number;
    /**
     * Trace ID for correlation across logs/metrics. Present when
     * `options.observability` or `options.traceId` is set; `undefined` otherwise.
     */
    traceId?: string;
    /** Wall-clock duration of this act() call in ms. */
    durationMs?: number;
}
export interface ActFailure {
    ok: false;
    error: unknown;
    /**
     * Number of attempts made before final failure.
     * For dedupe joiners: mirrors the originator's attempt count.
     */
    attempts: number;
    /**
     * Trace ID for correlation across logs/metrics. Present when
     * `options.observability` or `options.traceId` is set; `undefined` otherwise.
     */
    traceId?: string;
    /** Wall-clock duration of this act() call in ms. */
    durationMs?: number;
}
export type ActResult<T> = ActSuccess<T> | ActFailure;
export interface RetryOptions {
    /**
     * Total number of attempts including the first call.
     * Must be an integer >= 1.
     *
     * `attempts: 1` is a no-op (equivalent to omitting `retry`); the policy
     * is not added to the chain. This is intentional — adding a policy that
     * never retries is pure overhead.
     */
    attempts: number;
    /**
     * Base delay between attempts in milliseconds. Defaults to 0 (no delay).
     * Must be a non-negative finite number.
     */
    delayMs?: number;
    /**
     * How the base delay grows per attempt:
     *  - `'none'`        -> always `delayMs`
     *  - `'linear'`      -> `delayMs * attempt`
     *  - `'exponential'` -> `delayMs * 2^(attempt-1)`
     *
     * The computed delay is then capped by {@link maxDelay} and jittered by
     * {@link jitter} before being slept.
     *
     * Defaults to `'none'`.
     */
    backoff?: 'none' | 'linear' | 'exponential';
    /**
     * Hard cap on the computed delay. Defaults to `Infinity`.
     *
     * Without a cap, `exponential` backoff with `delayMs: 1000` and
     * `attempts: 10` would sleep 8.5 minutes between attempts 9 and 10
     * (256 seconds). Set `maxDelay` to something sane (e.g. 30_000) to
     * bound worst-case latency.
     */
    maxDelay?: number;
    /**
     * Jitter strategy applied to the (post-`maxDelay`) delay.
     *
     *  - `'none'`         -> no jitter, return delay as-is
     *  - `'full'`         -> `random() * delay`  (default; best for thundering-herd prevention)
     *  - `'equal'`        -> `delay/2 + random() * delay/2`
     *  - `'decorrelated'` -> `base + random() * (delay - base)`
     *
     * Defaults to `'full'`. Jitter prevents synchronised retry storms when
     * many callers fail at the same instant (e.g. after an upstream outage
     * recovers) — without it, all callers retry on the same tick.
     */
    jitter?: 'none' | 'full' | 'equal' | 'decorrelated';
    /**
     * Predicate called after each failure, before the next attempt.
     * Return `false` to stop retrying immediately and surface the error.
     *
     * Called for every failure including the last attempt (so observers stay
     * informed); the return value is only consulted when there are remaining
     * attempts.
     *
     * Use this to skip retries for errors that are definitively non-recoverable
     * (e.g. HTTP 4xx, AuthError, ValidationError).
     *
     * Default behaviour: retry on every error except `AbortError` (which
     * indicates the caller or a timeout cancelled the operation).
     *
     * @param error   The error thrown by the most recent attempt.
     * @param attempt The 1-based number of the attempt that just failed.
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}
export interface TimeoutOptions {
    /**
     * Abort after this many milliseconds.
     * Must be a positive finite number.
     */
    ms: number;
}
export interface DedupeOptions {
    /**
     * Collapse concurrent calls sharing the same key into one in-flight Promise.
     * Opt-in: be explicit when you want this behaviour.
     */
    enabled: boolean;
    /**
     * Safety-net TTL for the in-flight entry, in milliseconds.
     *
     * If the originator's promise does not settle within this window, the
     * entry is removed from the store so subsequent callers can start fresh.
     * Originator's promise continues in the background until it settles or
     * an outer timeout fires.
     *
     * Default: `Infinity` (no safety net). Pair with `timeout` or
     * `totalTimeout` for proper cancellation in production.
     */
    inflightTtl?: number;
}
export interface CacheOptions {
    /** Keep a successful result for this many milliseconds. Must be > 0. */
    ttl: number;
}
export interface ActOptions<T = unknown> {
    retry?: RetryOptions;
    /** Per-attempt deadline. Each retry gets a fresh clock. */
    timeout?: TimeoutOptions;
    /**
     * Collapse concurrent calls with the same key into one in-flight Promise.
     *
     * Shorthand:  `dedupe: true`
     * Full form:  `dedupe: { enabled: true, inflightTtl: 30_000 }`
     */
    dedupe?: boolean | DedupeOptions;
    cache?: CacheOptions;
    /**
     * Hard budget over the ENTIRE operation — including all retry attempts,
     * delays, and the per-attempt timeout.
     *
     * Distinct from `timeout`, which resets the clock on every attempt.
     * Use both together to express: "each attempt may take at most X ms,
     * but the whole thing must finish within Y ms."
     *
     * Rejects with {@link TotalTimeoutError} if the budget fires.
     */
    totalTimeout?: TimeoutOptions;
    /**
     * Caller-provided cancellation signal.
     *
     * When this signal aborts:
     *  - if the operation has not yet started, it rejects immediately with
     *    the signal's `reason`,
     *  - if it is in progress, the inner {@link ActFn} receives an aborted
     *    signal (cooperative cancellation),
     *  - if it has already settled, the result is returned as normal.
     *
     * Combined with `timeout` / `totalTimeout`, this gives you full control
     * over cancellation from outside `act()`.
     */
    signal?: AbortSignal;
    /**
     * Observability hooks. All optional. When omitted entirely (the
     * common case), zero overhead is incurred on the hot path — no event
     * objects are allocated, no function calls are made.
     *
     * When hooks ARE registered, events are allocated lazily — only when
     * the corresponding event actually fires.
     *
     * @example
     * ```ts
     * await act('user:42', fn, {
     *   retry: { attempts: 3 },
     *   observability: {
     *     onAttempt: (e) => metrics.increment('act.attempt', { key: e.key, attempt: e.attempt }),
     *     onFinalFailure: (e) => logger.error({ key: e.key, traceId: e.traceId, failedBy: e.failedBy }, 'act failed'),
     *     onFinalSuccess: (e) => metrics.histogram('act.duration', e.durationMs),
     *   },
     * })
     * ```
     */
    observability?: ObservabilityHooks;
    /**
     * Trace ID for logs/metrics correlation. Auto-generated via crypto.randomUUID()
     * when omitted. Appears on every observability event and on ActResult.traceId.
     */
    traceId?: string;
    /** Circuit breaker: trips open after N consecutive failures, blocks calls for a cooldown period. */
    circuitBreaker?: CircuitBreakerOptions;
    /** Bulkhead: limits concurrent in-flight calls per key. Excess callers queue or fail fast. */
    bulkhead?: BulkheadOptions;
    /** Rate limiter: limits calls per window per key. Excess callers fail with RateLimitError. */
    rateLimit?: RateLimitOptions;
    /** Hedge: sends a second fn call after delayMs if the first hasn't settled. Races them. */
    hedge?: HedgeOptions;
    /** Fallback: returns this value if all policies fail. Suppresses ActFailure. */
    fallback?: FallbackOptions<T>;
    /** Audit: logs every act() call with key, traceId, result, timestamp. */
    audit?: AuditOptions;
}
export interface CircuitBreakerOptions {
    /** Number of consecutive failures before the breaker opens. Must be >= 1. */
    threshold: number;
    /** How long to stay open before transitioning to half-open (ms). Must be > 0. */
    cooldownMs: number;
    /** Optional: reset failure count after this idle period (ms). Default: Infinity. */
    resetTimeoutMs?: number;
}
export interface BulkheadOptions {
    /** Max concurrent in-flight calls per key. Must be >= 1. */
    maxConcurrent: number;
    /** How long to queue before rejecting with BulkheadOverflowError (ms). Default: 0 (fail fast). */
    queueTimeoutMs?: number;
}
export interface RateLimitOptions {
    /** Max calls per window per key. Must be >= 1. */
    maxCalls: number;
    /** Window size in ms. Must be > 0. */
    windowMs: number;
}
export interface HedgeOptions {
    /** Delay before sending the second (hedge) call (ms). Must be > 0. */
    delayMs: number;
}
export interface FallbackOptions<T> {
    /** Value to return if all retries/policies fail. */
    value: T | (() => T | Promise<T>);
}
export interface AuditOptions {
    /** Called with audit entry after every act() call (success or failure). */
    log: (entry: AuditEntry) => void;
}
export interface AuditEntry {
    key: string;
    traceId: string;
    timestamp: number;
    durationMs: number;
    ok: boolean;
    attempts: number;
    failedBy?: string;
    error?: unknown;
}
/**
 * Mutable bag mutated in-place during execution.
 * Policies annotate it; act() reads the final state to build ActResult.
 *
 * For dedupe joiners: the bag is copied from the originator's bag after the
 * in-flight promise settles (success or failure), so `attempts` reflects
 * the real effort, not the default `1`.
 */
export interface RunMeta {
    attempts: number;
    source: ActSource;
}
export interface ObservabilityContext {
    traceId: string;
    hooks: ObservabilityHooks;
    joinerCounter: number;
}
/** User-supplied observability hooks. See `observability.ts` for full shape. */
export interface ObservabilityHooks {
    onAttempt?: (event: {
        readonly type: 'attempt';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly attempt: number;
        readonly durationMs?: number;
        readonly error?: unknown;
    }) => void;
    onRetry?: (event: {
        readonly type: 'retry';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly attempt: number;
        readonly delayMs: number;
        readonly error: unknown;
    }) => void;
    onCacheHit?: (event: {
        readonly type: 'cache-hit';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly ageMs: number;
    }) => void;
    onCacheMiss?: (event: {
        readonly type: 'cache-miss';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
    }) => void;
    onDedupeJoin?: (event: {
        readonly type: 'dedupe-join';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly joinerPosition: number;
    }) => void;
    onTimeout?: (event: {
        readonly type: 'timeout';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly kind: 'per-attempt' | 'total';
        readonly ms: number;
    }) => void;
    onFinalSuccess?: (event: {
        readonly type: 'final-success';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly source: ActSource;
        readonly attempts: number;
        readonly durationMs: number;
    }) => void;
    onFinalFailure?: (event: {
        readonly type: 'final-failure';
        readonly key: string;
        readonly traceId: string;
        readonly timestamp: number;
        readonly attempts: number;
        readonly durationMs: number;
        readonly failedBy: 'abort' | 'timeout' | 'total-timeout' | 'retry-exhausted' | 'fn-error' | 'validation';
        readonly error: unknown;
    }) => void;
}
/** Everything a policy receives about the current run. */
export interface PolicyContext {
    key: string;
    store: AnyStateStore;
    meta: RunMeta;
    /**
     * Observability context. Present only when the caller supplied
     * `options.observability` hooks. Policies check `ctx.observability != null`
     * before allocating event objects — no overhead when absent.
     */
    observability?: ObservabilityContext;
}
/**
 * The ONLY shape the executor knows about policies.
 *
 * A policy wraps `ActFn<T>` and returns a new `ActFn<T>`. It may intercept
 * before, after, or instead of the inner call. The executor never imports
 * a concrete policy — only this type.
 */
export type PolicyApplier<T> = (fn: ActFn<T>, ctx: PolicyContext) => ActFn<T>;
import type { SyncStateStore, AsyncStateStore } from '../stores/base.js';
export type { SyncStateStore, AsyncStateStore };
/**
 * Public store type. Alias for `SyncStateStore` (backwards compat).
 *
 * Kept for backwards compatibility — consumers typed against
 * `StateStore` continues to compile without changes. A future major version
 * may widen this to `SyncStateStore | AsyncStateStore`.
 */
export type StateStore = SyncStateStore;
/**
 * Union of sync and async stores. Used internally by `PolicyContext` and
 * exported for consumers building custom policy chains or store adapters.
 */
export type AnyStateStore = SyncStateStore | AsyncStateStore;
//# sourceMappingURL=index.d.ts.map