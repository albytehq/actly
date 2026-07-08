// ─── Public surface ────────────────────────────────────────────────────────────

/**
 * The async function ACT wraps.
 *
 * Receives an {@link AbortSignal} that fires when:
 *  - the caller aborts via `options.signal`,
 *  - the per-attempt {@link TimeoutOptions} fires,
 *  - the operation-wide {@link ActOptions.totalTimeout} fires.
 *
 * Cooperative cancellation: pass `signal` through to `fetch`,
 * `AbortController`, database drivers, or any primitive that accepts one.
 * If you ignore it, ACT still returns promptly (the outer promise rejects),
 * but the underlying work keeps running in the background and leaks
 * resources until it settles on its own.
 *
 * `() => Promise<T>` is assignable to this type, so existing call sites
 * keep compiling. They just forgo cancellation.
 *
 * @example
 * // Cooperative
 * act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, { timeout: { ms: 5_000 } })
 *
 * @example
 * // Legacy (signal ignored, still works)
 * act('user:42', () => fetchUser(42))
 */
export type ActFn<T> = (signal: AbortSignal) => Promise<T> | T

/** Where a successful result came from. */
export type ActSource = 'fresh' | 'cache'

export interface ActSuccess<T> {
  ok: true
  value: T
  source: ActSource
  /**
   * Number of attempts made before success.
   *
   * - Fresh success on first try: `1`
   * - Fresh success after N retries: `N`
   * - Cache hit: `0` (no work was performed)
   * - Dedupe joiner: mirrors the originator's attempt count
   */
  attempts: number
  /**
   * Trace ID for correlation across logs/metrics. Present when
   * `options.observability` or `options.traceId` is set; `undefined` otherwise.
   */
  traceId?: string
  /** Wall-clock duration of this act() call in ms. */
  durationMs?: number
}

export interface ActFailure {
  ok: false
  error: unknown
  /**
   * Number of attempts made before final failure.
   * For dedupe joiners: mirrors the originator's attempt count.
   */
  attempts: number
  /**
   * Trace ID for correlation across logs/metrics. Present when
   * `options.observability` or `options.traceId` is set; `undefined` otherwise.
   */
  traceId?: string
  /** Wall-clock duration of this act() call in ms. */
  durationMs?: number
}

export type ActResult<T> = ActSuccess<T> | ActFailure

// ─── Policy options ─────────────────────────────────────────────────────────

export interface RetryOptions {
  /**
   * Total attempts including the first call. Must be an integer >= 1.
   *
   * `attempts: 1` is a no-op (equivalent to omitting `retry`); the policy
   * isn't added to the chain. A policy that never retries is pure overhead.
   */
  attempts: number

  /**
   * Base delay between attempts in milliseconds. Defaults to 0 (no delay).
   * Must be a non-negative finite number.
   */
  delayMs?: number

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
   *
   * For per-attempt dynamic delays (e.g. honoring a `Retry-After` HTTP
   * header), use {@link backoffFn} instead; it overrides this option.
   */
  backoff?: 'none' | 'linear' | 'exponential'

  /**
   * Custom backoff function. Called after each failure to compute the delay
   * before the next attempt. Overrides {@link backoff} and {@link jitter}.
   *
   * The function receives the attempt number, the last error, and an
   * optional state object it can mutate and read back on the next call,
   * useful for carrying per-operation state like a `Retry-After` value
   * parsed from an HTTP response.
   *
   * Return `0` for no delay. Returning a negative number is treated as 0.
   *
   * @example Honor `Retry-After` header
   * ```ts
   * await act('fetch-api', async (signal) => {
   *   const res = await fetch('/api', { signal })
   *   if (!res.ok) {
   *     const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10)
   *     if (retryAfter > 0) {
   *       ;(actState.retryAfter = retryAfter * 1000)  // store for next call
   *     }
   *     throw new Error(`HTTP ${res.status}`)
   *   }
   *   return res
   * }, {
   *   retry: {
   *     attempts: 5,
   *     backoffFn: (attempt, error, state) => state.retryAfter ?? 1000,
   *   },
   * })
   * ```
   *
   * # Cockatiel parity
   *
   * Cockatiel exposes `DelegateBackoff` which can carry state across
   * attempts. This is the equivalent: `state` is passed by reference and
   * persists across attempts within a single `act()` call.
   */
  backoffFn?: (
    attempt: number,
    error: unknown,
    state: Record<string, unknown>,
  ) => number


  /**
   * Hard cap on the computed delay. Defaults to `Infinity`.
   *
   * Without a cap, `exponential` backoff with `delayMs: 1000` and
   * `attempts: 10` would sleep 8.5 minutes between attempts 9 and 10
   * (256 seconds). Set `maxDelay` to something sane (e.g. 30_000) to
   * bound worst-case latency.
   */
  maxDelay?: number

  /**
   * Jitter strategy applied to the (post-`maxDelay`) delay.
   *
   *  - `'none'`         -> no jitter, return delay as-is
   *  - `'full'`         -> `random() * delay`  (default; best for thundering-herd prevention)
   *  - `'equal'`        -> `delay/2 + random() * delay/2`
   *  - `'decorrelated'` -> `base + random() * (delay - base)`
   *
   * Defaults to `'full'`. Jitter breaks synchronized retry storms when
   * many callers fail at the same instant (e.g. after an upstream outage
   * recovers); without it, everyone retries on the same tick.
   */
  jitter?: 'none' | 'full' | 'equal' | 'decorrelated'

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
  shouldRetry?: (error: unknown, attempt: number) => boolean

  /**
   * Predicate called after each SUCCESSFUL attempt. Return `false` to treat
   * the value as a failure (and trigger a retry), `true` to accept it.
   *
   * Use this to retry on "successful" responses that are semantically
   * failures; the most common pattern is HTTP:
   *
   * ```ts
   * await act('fetch-user', async (signal) => {
   *   const res = await fetch('/api/user', { signal })
   *   return res
   * }, {
   *   retry: {
   *     attempts: 3,
   *     delayMs: 200,
   *     shouldRetryResult: (res) => res.ok && res.status < 500,
   *   },
   * })
   * ```
   *
   * Without `shouldRetryResult`, retry only inspects errors. A 500 response
   * from `fetch` (which doesn't throw) would NOT be retried. With
   * `shouldRetryResult`, the retry policy can inspect the returned value
   * and decide whether to retry.
   *
   * If both `shouldRetry` and `shouldRetryResult` are set, both are
   * consulted: `shouldRetry` on error, `shouldRetryResult` on success.
   *
   * Default: accept every successful value (no result-based retry).
   *
   * @param value   The value returned by the most recent attempt.
   * @param attempt The 1-based number of the attempt that just succeeded.
   */
  shouldRetryResult?: <V>(value: V, attempt: number) => boolean

  /**
   * If `true`, the sleep between retry attempts calls `unref()` on its
   * internal timer so the Node.js process can exit immediately (e.g. on
   * SIGINT) even if a retry delay is pending, instead of waiting for the
   * full `delayMs` to elapse.
   *
   * Default: `false` (the sleep timer keeps the event loop alive). Safe
   * for long-running servers where the operation MUST complete (e.g. a
   * payment retry that should not be dropped on shutdown).
   *
   * Set `dangerouslyUnref: true` for:
   *  - CLI tools and scripts where the process should exit promptly on
   *    Ctrl+C, even if a retry is mid-delay.
   *  - Test suites where pending retry timers would prevent the test
   *    runner from exiting cleanly.
   *  - Background jobs that should NOT block process shutdown.
   *
   * If the process exits while a retry is pending, the operation is
   * silently dropped and the caller never gets a result. Use only when
   * that's acceptable (CLI scripts, tests).
   *
   * # Cockatiel parity
   *
   * Cockatiel exposes `dangerouslyUnref()` on retry and timeout policies.
   * This is the equivalent, exposed as an option.
   */
  dangerouslyUnref?: boolean
}

export interface TimeoutOptions {
  /**
   * Abort after this many milliseconds.
   * Must be a positive finite number.
   */
  ms: number

  /**
   * How the timeout interacts with `fn`.
   *
   *  - `'race'` (default): races `fn(signal)` against the abort event. If
   *    the timer fires first, throws `TimeoutError` immediately. The
   *    underlying `fn` may keep running in the background (resource leak)
   *    unless it cooperates with the signal.
   *
   *  - `'cooperative'`: aborts the signal but WAITS for `fn` to settle
   *    naturally. Throws `TimeoutError` only after `fn` actually rejects
   *    (or settles with a value, in which case the value is returned).
   *    Gentler on downstream resources that don't cooperate with
   *    AbortSignal: they get a chance to clean up properly instead of
   *    being abandoned mid-flight.
   *
   *    Trade-off: `cooperative` can wait longer than `ms` if `fn` is slow
   *    to reject after the signal aborts. Use `race` when you need hard
   *    latency bounds; use `cooperative` when `fn` doesn't cooperate with
   *    signals and you'd rather not leak resources.
   *
   * Both strategies abort the signal at `ms`; the difference is whether
   * `act()` returns at `ms` (race) or waits for `fn` to notice the abort
   * (cooperative).
   *
   * # Cockatiel parity
   *
   * Cockatiel exposes `TimeoutStrategy.Cooperative` and `TimeoutStrategy.Aggressive`
   * (which is our `race`). This is the equivalent.
   */
  strategy?: 'race' | 'cooperative'
}

export interface DedupeOptions {
  /**
   * Collapse concurrent calls sharing the same key into one in-flight Promise.
   * Opt-in: be explicit when you want this behaviour.
   */
  enabled: boolean

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
  inflightTtl?: number
}

export interface CacheOptions {
  /** Keep a successful result for this many milliseconds. Must be > 0. */
  ttl: number
}

export interface ActOptions<T = unknown> {
  retry?:        RetryOptions
  /** Per-attempt deadline. Each retry gets a fresh clock. */
  timeout?:      TimeoutOptions
  /**
   * Collapse concurrent calls with the same key into one in-flight Promise.
   *
   * Shorthand:  `dedupe: true`
   * Full form:  `dedupe: { enabled: true, inflightTtl: 30_000 }`
   */
  dedupe?:       boolean | DedupeOptions
  cache?:        CacheOptions
  /**
   * Hard budget over the ENTIRE operation, including all retry attempts,
   * delays, and the per-attempt timeout.
   *
   * Distinct from `timeout`, which resets the clock on every attempt.
   * Use both together to express: "each attempt may take at most X ms,
   * but the whole thing must finish within Y ms."
   *
   * Rejects with {@link TotalTimeoutError} if the budget fires.
   */
  totalTimeout?: TimeoutOptions

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
  signal?:       AbortSignal

  /**
   * Observability hooks. All optional. When omitted entirely (the common
   * case), zero overhead on the hot path: no event objects allocated, no
   * function calls made.
   *
   * When hooks are registered, events are allocated lazily, only when the
   * corresponding event actually fires.
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
  observability?: ObservabilityHooks

  /**
   * Trace ID for logs/metrics correlation. Auto-generated via crypto.randomUUID()
   * when omitted. Appears on every observability event and on ActResult.traceId.
   */
  traceId?:      string

  // ─── Hardening options (additive, backwards compatible) ───────────────────

  /** Circuit breaker: trips open after N consecutive failures, blocks calls for a cooldown period. */
  circuitBreaker?: CircuitBreakerOptions

  /** Bulkhead: limits concurrent in-flight calls per key. Excess callers queue or fail fast. */
  bulkhead?: BulkheadOptions

  /** Rate limiter: limits calls per window per key. Excess callers fail with RateLimitError. */
  rateLimit?: RateLimitOptions

  /** Hedge: sends a second fn call after delayMs if the first hasn't settled. Races them. */
  hedge?: HedgeOptions

  /** Fallback: returns this value if all policies fail. Suppresses ActFailure. */
  fallback?: FallbackOptions<T>

  /** Audit: logs every act() call with key, traceId, result, timestamp. */
  audit?: AuditOptions
}

// ─── Hardening policy option types ──────────────────────────────────────────

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures before the breaker opens. Must be >= 1.
   *
   * Used as the threshold for the default 'consecutive' strategy. For the
   * 'count' strategy (sliding-window ratio), this is the minimum number
   * of calls in the window before the breaker can trip.
   */
  threshold: number
  /** How long to stay open before transitioning to half-open (ms). Must be > 0. */
  cooldownMs: number
  /** Optional: reset failure count after this idle period (ms). Default: Infinity. */
  resetTimeoutMs?: number

  /**
   * Strategy for tripping the breaker.
   *
   *  - `'consecutive'` (default): opens after `threshold` CONSECUTIVE
   *    failures. Resets the count on any success. Simple and predictable.
   *    Good for "downstream is fully down" detection.
   *
   *  - `'count'`: sliding-window ratio breaker. Trips when the failure
   *    RATE in the last `countSize` calls exceeds `countThreshold` (a
   *    fraction 0-1). Use this for "downstream is degraded but not fully
   *    down" detection, e.g. trip when >30% of the last 100 calls fail.
   *    Requires `countSize` and `countThreshold` options.
   *
   * # Cockatiel parity
   *
   * Cockatiel exposes `ConsecutiveBreaker`, `CountBreaker`, and
   * `SamplingBreaker`. This is the equivalent, exposed as a strategy
   * option on a single circuitBreaker config.
   */
  strategy?: 'consecutive' | 'count'

  /**
   * For `strategy: 'count'` only: the size of the sliding window
   * (number of recent calls tracked). Must be >= 1.
   *
   * Default: 100. Larger windows are more accurate but use more memory
   * (one boolean per call, 100 bytes for size 100).
   */
  countSize?: number

  /**
   * For `strategy: 'count'` only: the failure-rate threshold (0-1) that
   * trips the breaker. E.g. `0.3` = trip when >30% of the last `countSize`
   * calls failed.
   *
   * Must be > 0 and <= 1. Default: 0.5 (50%).
   *
   * The breaker only trips after `countMinimumCalls` have been recorded,
   * otherwise the first failure (100% rate) would trip immediately.
   */
  countThreshold?: number

  /**
   * For `strategy: 'count'` only: minimum number of calls that must be
   * recorded before the breaker can trip. Prevents false trips on low
   * volume. Default: same as `countSize`.
   */
  countMinimumCalls?: number
}

export interface BulkheadOptions {
  /** Max concurrent in-flight calls per key. Must be >= 1. */
  maxConcurrent: number
  /** How long to queue before rejecting with BulkheadOverflowError (ms). Default: 0 (fail fast). */
  queueTimeoutMs?: number
  /**
   * Maximum number of callers that can be queued waiting for a slot.
   * Default: `Infinity` (unbounded, risky under stampede: a 100k-caller
   * spike with `maxConcurrent: 10` would queue 99990 callers, each holding
   * a Promise resolver + timer + abort listener closure).
   *
   * Set a finite cap to bound memory under stampede. When the queue is
   * full, excess callers reject immediately with `BulkheadOverflowError`,
   * same as if `queueTimeoutMs` had fired.
   */
  maxQueueSize?: number
}

export interface RateLimitOptions {
  /** Max calls per window per key. Must be >= 1. */
  maxCalls: number
  /** Window size in ms. Must be > 0. */
  windowMs: number
}

export interface HedgeOptions {
  /** Delay before sending the second (hedge) call (ms). Must be > 0. */
  delayMs: number
  /**
   * Where in the policy chain the hedge fires.
   *
   * - `'outside-retry'` (default): hedge wraps the entire retry+timeout
   *   chain. ONE hedge fires per `act()` call, regardless of retry count.
   *   This is the intuitive behavior ("if the first attempt is slow, send
   *   a backup") and avoids N-tupling downstream load when retry+hedge
   *   are composed.
   *
   * - `'inside-retry'`: hedge wraps `fn` directly, inside the retry loop.
   *   Each retry attempt can spawn its own hedge. With `retry.attempts: 5`
   *   and a slow endpoint, this can produce up to 10 fn invocations
   *   (5 primaries + 5 hedges). Use only when you genuinely want a hedge
   *   per attempt.
   */
  placement?: 'outside-retry' | 'inside-retry'
  /**
   * If `true`, the losing promise is NOT cancelled: it keeps running to
   * completion. Default is `false` (loser is cancelled via AbortController).
   *
   * Pass `true` only if you rely on the loser's side effects (rare, usually
   * a code smell). Cancellation requires `fn` to cooperate with the
   * `signal` parameter (pass it to `fetch`, database drivers, etc.). If
   * `fn` ignores the signal, the loser keeps running regardless of this
   * option.
   */
  keepLoser?: boolean
}

export interface FallbackOptions<T> {
  /** Value to return if all retries/policies fail. */
  value: T | (() => T | Promise<T>)
}

export interface AuditOptions {
  /** Called with audit entry after every act() call (success or failure). */
  log: (entry: AuditEntry) => void
}

export interface AuditEntry {
  key: string
  traceId: string
  timestamp: number
  durationMs: number
  ok: boolean
  attempts: number
  // Literal union so callers can do exhaustive `switch` on `failedBy`.
  // Runtime value is one of these 11 literals (produced by `classifyFailure()` in act.ts).
  failedBy?: ActlyFailedBy
  error?: unknown
}

/**
 * Literal union for the `failedBy` discriminator. Shared by
 * `AuditEntry.failedBy` (here) and `FinalFailureEvent.failedBy`
 * (in observability.ts) so the two can't diverge.
 */
export type ActlyFailedBy =
  | 'abort'
  | 'timeout'
  | 'total-timeout'
  | 'retry-exhausted'
  | 'fn-error'
  | 'validation'
  | 'circuit-open'
  | 'bulkhead-full'
  | 'rate-limited'
  | 'resource-exhausted'
  | 'hedge-timeout'

// ─── Internal contracts ──────────────────────────────────────────────────────

/**
 * Mutable bag mutated in-place during execution.
 * Policies annotate it; act() reads the final state to build ActResult.
 *
 * For dedupe joiners: the bag is copied from the originator's bag after the
 * in-flight promise settles (success or failure), so `attempts` reflects
 * the real effort, not the default `1`.
 */
export interface RunMeta {
  attempts: number
  source:   ActSource
}

// Re-export to avoid duplicate declarations going stale.
export type { ObservabilityContext } from '../observability.js'
import type { ObservabilityContext } from '../observability.js'

/** Everything a policy receives about the current run. */
export interface PolicyContext {
  key:   string
  store: AnyStateStore
  meta:  RunMeta
  /**
   * Observability context. Present only when the caller supplied
   * `options.observability` hooks. Policies null-check before allocating
   * event objects, so no overhead when absent.
   */
  observability?: ObservabilityContext
}

/**
 * The ONLY shape the executor knows about policies.
 *
 * A policy wraps `ActFn<T>` and returns a new `ActFn<T>`. It may intercept
 * before, after, or instead of the inner call. The executor never imports
 * a concrete policy, only this type.
 */
export type PolicyApplier<T> = (fn: ActFn<T>, ctx: PolicyContext) => ActFn<T>

// ─── State store ─────────────────────────────────────────────────────────────

import type { SyncStateStore, AsyncStateStore } from '../stores/base.js'
export type { SyncStateStore, AsyncStateStore }

// ─── Observability (re-export to avoid circular import) ─────────────────────

import type { ObservabilityHooks as ObsHooks } from '../observability.js'
/**
 * User-supplied observability hooks. Re-exported from `observability.ts`
 * for a single source of truth.
 */
export type ObservabilityHooks = ObsHooks

/**
 * Public store type. Alias for `SyncStateStore` (backwards compat) so
 * consumers typed against `StateStore` keep compiling. A future major
 * version may widen this to `SyncStateStore | AsyncStateStore`.
 */
export type StateStore = SyncStateStore

/**
 * Union of sync and async stores. Used internally by `PolicyContext` and
 * exported for consumers building custom policy chains or store adapters.
 */
export type AnyStateStore = SyncStateStore | AsyncStateStore
