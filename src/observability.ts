/**
 * Observability hooks for the `act()` lifecycle.
 *
 * When `options.observability` is null/undefined the hot path is just a
 * null-check per policy decision - no event objects, no calls. When hooks
 * are registered, events are allocated lazily, only when they actually
 * fire (a cache hit never allocates an `onRetry` event, for example).
 *
 * Every event carries `key`, `traceId`, `timestamp` for correlation;
 * event-specific fields sit on the same object so user code can destructure
 * flat.
 *
 * # Ordering
 *
 * Fresh call with retries:
 *   onAttempt(1) -> onRetry(1->2) -> onAttempt(2) -> onRetry(2->3) -> onAttempt(3) -> onFinalSuccess
 *
 * Cache hit:    onCacheHit -> onFinalSuccess
 * Dedupe join:  onDedupeJoin -> onFinalSuccess (or onFinalFailure)
 * Timeout:      onAttempt -> onTimeout -> onFinalFailure
 */

import type { ActSource, ActlyFailedBy } from './types/index.js'

/** Stable discriminator for telemetry. */
export type ActlyEventType =
  | 'attempt'
  | 'retry'
  | 'cache-hit'
  | 'cache-miss'
  | 'dedupe-join'
  | 'timeout'
  | 'final-success'
  | 'final-failure'
  | 'backpressure'
  | 'watchdog'

/** Common fields on every event. */
export interface ActlyEventBase {
  /** The `key` passed to `act()`. */
  readonly key: string
  /** Auto-generated trace ID (or user-supplied via `options.traceId`). */
  readonly traceId: string
  /** Event timestamp (ms since epoch). */
  readonly timestamp: number
  /** Discriminator for switch statements. */
  readonly type: ActlyEventType
}

export interface AttemptEvent extends ActlyEventBase {
  readonly type: 'attempt'
  /** 1-based attempt number. */
  readonly attempt: number
  /** Duration of this attempt in ms (set after attempt settles). */
  readonly durationMs?: number
  /** Error from this attempt, if it failed. */
  readonly error?: unknown
}

export interface RetryEvent extends ActlyEventBase {
  readonly type: 'retry'
  /** The attempt that just failed. */
  readonly attempt: number
  /** The delay (ms) before the next attempt. */
  readonly delayMs: number
  /** Error that triggered the retry. */
  readonly error: unknown
}

export interface CacheHitEvent extends ActlyEventBase {
  readonly type: 'cache-hit'
  /** Age of the cached value in ms. */
  readonly ageMs: number
}

export interface CacheMissEvent extends ActlyEventBase {
  readonly type: 'cache-miss'
}

export interface DedupeJoinEvent extends ActlyEventBase {
  readonly type: 'dedupe-join'
  /** This caller's position in the joiner queue (1 = first joiner). */
  readonly joinerPosition: number
}

export interface TimeoutEvent extends ActlyEventBase {
  readonly type: 'timeout'
  /** Which deadline fired. */
  readonly kind: 'per-attempt' | 'total'
  /** The configured ms. */
  readonly ms: number
}

export interface FinalSuccessEvent extends ActlyEventBase {
  readonly type: 'final-success'
  /** Where the value came from. */
  readonly source: ActSource
  /** Total attempts made (0 for cache hit). */
  readonly attempts: number
  /** Total wall-clock duration of the act() call. */
  readonly durationMs: number
}

export interface FinalFailureEvent extends ActlyEventBase {
  readonly type: 'final-failure'
  /** Total attempts made. */
  readonly attempts: number
  /** Total wall-clock duration of the act() call. */
  readonly durationMs: number
  /**
   * Stable reason for failure - use for telemetry tags. Re-exported as
   * `ActlyFailedBy` so `AuditEntry.failedBy` and this field share one
   * source of truth.
   */
  readonly failedBy: ActlyFailedBy
  /** The final error. */
  readonly error: unknown
}

export type ActlyEvent =
  | AttemptEvent
  | RetryEvent
  | CacheHitEvent
  | CacheMissEvent
  | DedupeJoinEvent
  | TimeoutEvent
  | FinalSuccessEvent
  | FinalFailureEvent
  | BackpressureEvent
  | WatchdogEvent

export interface BackpressureEvent extends ActlyEventBase {
  readonly type: 'backpressure'
  /** Which policy emitted the backpressure signal. */
  readonly source: 'bulkhead'
  /** Current queue length (callers waiting for a slot). */
  readonly queueLength: number
  /** Configured maxConcurrent for this key. */
  readonly maxConcurrent: number
  /** Configured maxQueueSize for this key (Infinity if unbounded). */
  readonly maxQueueSize: number
  /** Utilization ratio (queueLength / maxQueueSize). 1.0 = full. */
  readonly utilization: number
}

/**
 * Watchdog fired: an in-flight `act()` has been pending past the
 * configured threshold (default 60s). Opt-in via `enableWatchdog()` -
 * off by default to avoid per-call timer overhead.
 */
export interface WatchdogEvent extends ActlyEventBase {
  readonly type: 'watchdog'
  /** How long the call has been in-flight (ms). */
  readonly elapsedMs: number
  /** The scope the stuck call is in. */
  readonly scope: string
}

/**
 * User-supplied observability hooks. All optional. When absent, zero
 * overhead is incurred on the hot path.
 */
export interface ObservabilityHooks {
  onAttempt?: (event: AttemptEvent) => void
  onRetry?: (event: RetryEvent) => void
  onCacheHit?: (event: CacheHitEvent) => void
  onCacheMiss?: (event: CacheMissEvent) => void
  onDedupeJoin?: (event: DedupeJoinEvent) => void
  onTimeout?: (event: TimeoutEvent) => void
  onFinalSuccess?: (event: FinalSuccessEvent) => void
  onFinalFailure?: (event: FinalFailureEvent) => void
  /**
   * Bulkhead queue utilization crossed 80%. Emitted at most once per
   * crossing (not on every call) so callers can throttle upstream
   * before the bulkhead starts rejecting.
   */
  onBackpressure?: (event: BackpressureEvent) => void
  /**
   * Watchdog threshold exceeded for an in-flight call. Opt-in via
   * `enableWatchdog()`; not fired by default.
   */
  onWatchdog?: (event: WatchdogEvent) => void
}

/**
 * Threads observability through the policy chain without changing every
 * policy's signature. Attached to `PolicyContext` as an optional field;
 * policies that emit events check for its presence. `traceId` lives here
 * too so policies can stamp it onto events.
 */
export interface ObservabilityContext {
  traceId: string
  hooks: ObservabilityHooks
  /** Per-call counter for dedupe joiner position (approximate). */
  joinerCounter: number
}

/**
 * Policies call this once at decision points. False = skip all event work.
 */
export function hasObservers(ctx: { observability?: ObservabilityContext }): ctx is { observability: ObservabilityContext } {
  return ctx.observability != null
}
