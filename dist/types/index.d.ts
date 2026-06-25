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
}
export interface ActFailure {
    ok: false;
    error: unknown;
    /**
     * Number of attempts made before final failure.
     * For dedupe joiners: mirrors the originator's attempt count.
     */
    attempts: number;
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
export interface ActOptions {
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
/** Everything a policy receives about the current run. */
export interface PolicyContext {
    key: string;
    store: AnyStateStore;
    meta: RunMeta;
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
 * Public store type. v1.1+: alias for `SyncStateStore`.
 *
 * Kept for backwards compatibility — every v1.0 consumer typed against
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