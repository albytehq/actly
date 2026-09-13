import type { ObservabilityContext, ObservabilityHooks as ObsHooks } from './observability.js'
import type { SyncStateStore, AsyncStateStore } from './stores/contract.js'

export type { ObservabilityContext }

/**
 * The async function `act()` wraps. Receives an `AbortSignal` that fires on
 * caller abort, per-attempt timeout, or totalTimeout. `() => Promise<T>` is
 * assignable, so signal-less call sites keep compiling.
 */
export type ActFn<T> = (signal: AbortSignal) => Promise<T> | T

/** Where a successful result came from. */
export type ActSource = 'fresh' | 'cache'

export interface ActSuccess<T> {
  ok: true
  value: T
  source: ActSource
  /**
   * Attempts made: fresh first try `1`, after N retries `N`, cache hit `0`,
   * dedupe joiner mirrors the originator.
   */
  attempts: number
  /** Present when `options.observability` or `options.traceId` is set. */
  traceId?: string
  /** Wall-clock duration of this act() call in ms. */
  durationMs?: number
}

export interface ActFailure {
  ok: false
  error: unknown
  attempts: number
  traceId?: string
  durationMs?: number
}

export type ActResult<T> = ActSuccess<T> | ActFailure

export interface RetryOptions {
  /**
   * Total attempts including the first call. Must be an integer >= 1.
   * `attempts: 1` is a no-op; the policy is not added to the chain.
   */
  attempts: number
  /** Base delay between attempts in ms. Default 0. */
  delayMs?: number
  /**
   * Delay growth: `'none'` (default) keeps `delayMs`, `'linear'` multiplies
   * by attempt, `'exponential'` doubles per attempt. Capped by `maxDelay`,
   * then jittered.
   */
  backoff?: 'none' | 'linear' | 'exponential'
  /**
   * Custom backoff. Called after each failure with `(attempt, error, state)`;
   * `state` persists across attempts within one call. Overrides `backoff`
   * and `jitter`. Return 0 for no delay.
   */
  backoffFn?: (attempt: number, error: unknown, state: Record<string, unknown>) => number
  /** Hard cap on the computed delay. Default `Infinity`. */
  maxDelay?: number
  /**
   * Jitter: `'none'`, `'full'` (default, best herd prevention), `'equal'`,
   * `'decorrelated'`.
   */
  jitter?: 'none' | 'full' | 'equal' | 'decorrelated'
  /**
   * Predicate after each failure. Return `false` to stop retrying and
   * surface the error. Default: retry everything except aborts and
   * actly timeout codes.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /**
   * Predicate after each SUCCESSFUL attempt. Return `true` to accept the
   * value, `false` to retry it (e.g. `res.ok && res.status < 500`).
   * @param value   The value the attempt returned.
   * @param attempt 1-based number of the attempt that succeeded.
   */
  acceptResult?: <V>(value: V, attempt: number) => boolean
  /**
   * @deprecated since 1.4 — the name reads inverted (returning `true`
   * ACCEPTS the value). Use {@link acceptResult}; behaviour is identical.
   */
  shouldRetryResult?: <V>(value: V, attempt: number) => boolean
  /**
   * Unref retry sleep timers so the process can exit mid-delay. Default
   * `false`. Use for CLIs and tests; a pending retry is silently dropped
   * on exit.
   */
  dangerouslyUnref?: boolean
}

export interface TimeoutOptions {
  /** Abort after this many milliseconds. Must be positive and finite. */
  ms: number
  /**
   * `'race'` (default) returns promptly at `ms`, abandoning a
   * non-cooperating `fn`. `'cooperative'` aborts the signal but waits for
   * `fn` to settle, throwing `TimeoutError` only after it rejects.
   */
  strategy?: 'race' | 'cooperative'
}

export interface DedupeOptions {
  /**
   * Explicit `false` opts out. The object form enables dedupe by default
   * (since 1.4.2, matching every other policy and the standalone
   * `dedupePolicy`); before 1.4.2 an object without `enabled: true` was
   * silently ignored.
   */
  enabled?: boolean
  /**
   * Safety-net TTL for the in-flight entry in ms. If the originator does not
   * settle within this window the entry is dropped so later callers start
   * fresh. Default 5 minutes (`LIMITS.DEFAULT_INFLIGHT_TTL`); pass
   * `Infinity` for no safety net.
   */
  inflightTtl?: number
}

export interface CacheOptions {
  /** Keep a successful result for this many milliseconds. Must be > 0. */
  ttl: number
}

export interface ActOptions<T = unknown> {
  retry?: RetryOptions
  /** Per-attempt deadline; each retry gets a fresh clock. */
  timeout?: TimeoutOptions
  /** Collapse concurrent callers: `true` or `{ enabled, inflightTtl }`. */
  dedupe?: boolean | DedupeOptions
  cache?: CacheOptions
  /**
   * Hard budget over the ENTIRE operation including retries and delays.
   * Rejects with `TotalTimeoutError` when it fires.
   */
  totalTimeout?: TimeoutOptions
  /** Caller-provided cancellation signal. */
  signal?: AbortSignal
  /**
   * Observability hooks. Zero overhead when omitted. Unknown hook names
   * throw at call time (since 1.4) so typos cannot silently drop
   * telemetry.
   */
  observability?: ObservabilityHooks
  /** Trace ID for correlation; auto-generated via `crypto.randomUUID()` when omitted. */
  traceId?: string
  /** Circuit breaker: trips open after failures, blocks calls for a cooldown. */
  circuitBreaker?: CircuitBreakerOptions
  /** Bulkhead: caps concurrent calls per key. Default fail-fast. */
  bulkhead?: BulkheadOptions
  /** Rate limiter: caps calls per window per key. */
  rateLimit?: RateLimitOptions
  /** Hedge: sends a second call after `delayMs` and races them. */
  hedge?: HedgeOptions
  /** Fallback: return this value if all policies fail. */
  fallback?: FallbackOptions<T>
  /** Audit: log every act() call outcome. */
  audit?: AuditOptions
}

export interface CircuitBreakerOptions {
  /**
   * Consecutive failures before opening (default strategy), or the minimum
   * call volume for the `'count'` strategy.
   */
  threshold: number
  /** Open-state duration before a half-open probe (ms). Must be > 0. */
  cooldownMs: number
  /** Reset failure state after this idle period (ms). Default `Infinity`. */
  resetTimeoutMs?: number
  /**
   * `'consecutive'` (default) opens after N consecutive failures.
   * `'count'` opens when the failure rate over `countSize` calls exceeds
   * `countThreshold` with at least `countMinimumCalls` recorded.
   */
  strategy?: 'consecutive' | 'count'
  /** `'count'` strategy: sliding-window size. Default 100. */
  countSize?: number
  /** `'count'` strategy: failure-rate threshold (0-1). Default 0.5. */
  countThreshold?: number
  /** `'count'` strategy: minimum calls before tripping. Default `countSize`. */
  countMinimumCalls?: number
}

export interface BulkheadOptions {
  /** Max concurrent in-flight calls per key. Must be >= 1. */
  maxConcurrent: number
  /**
   * How long excess callers wait for a slot before rejecting with
   * `BulkheadOverflowError` (ms). Default `0`: fail fast, no queue.
   */
  queueTimeoutMs?: number
  /**
   * Max callers waiting for a slot. Default `Infinity` (unbounded). When
   * full, excess callers reject immediately.
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
  /** Delay before sending the hedge call (ms). Must be > 0. */
  delayMs: number
  /**
   * `'outside-retry'` (default): one hedge per `act()` call, wrapping the
   * whole chain. `'inside-retry'`: each attempt can spawn its own hedge.
   */
  placement?: 'outside-retry' | 'inside-retry'
  /**
   * Keep the losing call running instead of aborting it. Default `false`.
   * The winner's controller is never aborted either way.
   */
  keepLoser?: boolean
}

export interface FallbackOptions<T> {
  value: T | (() => T | Promise<T>)
}

export interface AuditOptions {
  log: (entry: AuditEntry) => void
}

export interface AuditEntry {
  key: string
  traceId: string
  timestamp: number
  durationMs: number
  ok: boolean
  attempts: number
  failedBy?: ActlyFailedBy
  error?: unknown
}

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

export interface RunMeta {
  attempts: number
  source: ActSource
}

export interface PolicyContext {
  key: string
  store: AnyStateStore
  meta: RunMeta
  observability?: ObservabilityContext
}

/**
 * The only shape the executor knows: wrap an `ActFn`, return a new `ActFn`.
 */
export type PolicyApplier<T> = (fn: ActFn<T>, ctx: PolicyContext) => ActFn<T>

export type { SyncStateStore, AsyncStateStore }
export type ObservabilityHooks = ObsHooks

/** Alias for `SyncStateStore` (backwards compatibility). */
export type StateStore = SyncStateStore

export type AnyStateStore = SyncStateStore | AsyncStateStore
