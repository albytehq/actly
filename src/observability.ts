import type { ActSource, ActlyFailedBy } from './types.js'

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
  readonly key: string
  readonly traceId: string
  readonly timestamp: number
  readonly type: ActlyEventType
}

export interface AttemptEvent extends ActlyEventBase {
  readonly type: 'attempt'
  /** 1-based attempt number. */
  readonly attempt: number
  /** Filled in after the attempt settles. */
  readonly durationMs?: number
  /** Filled in after the attempt settles, when it failed. */
  readonly error?: unknown
}

export interface RetryEvent extends ActlyEventBase {
  readonly type: 'retry'
  readonly attempt: number
  readonly delayMs: number
  readonly error: unknown
}

export interface CacheHitEvent extends ActlyEventBase {
  readonly type: 'cache-hit'
  readonly ageMs: number
}

export interface CacheMissEvent extends ActlyEventBase {
  readonly type: 'cache-miss'
}

export interface DedupeJoinEvent extends ActlyEventBase {
  readonly type: 'dedupe-join'
  readonly joinerPosition: number
}

export interface TimeoutEvent extends ActlyEventBase {
  readonly type: 'timeout'
  readonly kind: 'per-attempt' | 'total'
  readonly ms: number
}

export interface FinalSuccessEvent extends ActlyEventBase {
  readonly type: 'final-success'
  readonly source: ActSource
  readonly attempts: number
  readonly durationMs: number
}

export interface FinalFailureEvent extends ActlyEventBase {
  readonly type: 'final-failure'
  readonly attempts: number
  readonly durationMs: number
  readonly failedBy: ActlyFailedBy
  readonly error: unknown
  /**
   * Present when a `fallback` was configured and itself threw before the
   * original error was surfaced. The call's outcome error is still
   * `error`; this field exists so a broken fallback is detectable.
   */
  readonly fallbackError?: unknown
}

export interface BackpressureEvent extends ActlyEventBase {
  readonly type: 'backpressure'
  readonly source: 'bulkhead'
  readonly queueLength: number
  readonly maxConcurrent: number
  readonly maxQueueSize: number
  readonly utilization: number
}

export interface WatchdogEvent extends ActlyEventBase {
  readonly type: 'watchdog'
  readonly elapsedMs: number
  readonly scope: string
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

/**
 * All valid hook names on {@link ObservabilityHooks}. `act()` rejects
 * unknown keys in `options.observability` so typos fail loudly instead of
 * silently dropping telemetry.
 */
export const OBSERVABILITY_HOOKS = [
  'onAttempt',
  'onRetry',
  'onCacheHit',
  'onCacheMiss',
  'onDedupeJoin',
  'onTimeout',
  'onFinalSuccess',
  'onFinalFailure',
  'onBackpressure',
  'onWatchdog',
] as const

export type ObservabilityHookName = (typeof OBSERVABILITY_HOOKS)[number]

export interface ObservabilityHooks {
  onAttempt?: (event: AttemptEvent) => void
  onRetry?: (event: RetryEvent) => void
  onCacheHit?: (event: CacheHitEvent) => void
  onCacheMiss?: (event: CacheMissEvent) => void
  onDedupeJoin?: (event: DedupeJoinEvent) => void
  onTimeout?: (event: TimeoutEvent) => void
  onFinalSuccess?: (event: FinalSuccessEvent) => void
  onFinalFailure?: (event: FinalFailureEvent) => void
  /** Bulkhead queue utilization crossed 80%. Emitted at most once per crossing. */
  onBackpressure?: (event: BackpressureEvent) => void
  /** Watchdog threshold exceeded for an in-flight call. Opt-in via `enableWatchdog()`. */
  onWatchdog?: (event: WatchdogEvent) => void
}

/**
 * Threads observability through the policy chain: attached to
 * `PolicyContext.observability`; policies null-check before allocating
 * events, so absent means zero overhead.
 */
export interface ObservabilityContext {
  traceId: string
  hooks: ObservabilityHooks
  joinerCounter: number
}

/**
 * Fill the post-settle fields of an {@link AttemptEvent} already handed to
 * `onAttempt`. The event is mutated in place; consumers holding the object
 * observe the values appear once the attempt settles.
 * @internal
 */
export function fillAttemptOutcome(event: AttemptEvent, durationMs: number, error: unknown): void {
  const mutable = event as { durationMs?: number; error?: unknown }
  mutable.durationMs = durationMs
  if (error !== undefined) mutable.error = error
}

/**
 * Policies call this once at decision points. False = skip all event work.
 */
export function hasObservers(ctx: { observability?: ObservabilityContext }): ctx is { observability: ObservabilityContext } {
  return ctx.observability != null
}
