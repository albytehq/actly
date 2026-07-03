/**
 * Observability hooks.
 *
 * Eight event types covering the entire lifecycle of an `act()` call.
 *
 * # Contract
 *
 * When `options.observability` is `null`/`undefined` (the common case),
 * no event objects are allocated and no function calls are made. The
 * hot path is a single null-check per policy decision.
 *
 * When hooks ARE registered, events are allocated lazily — only when the
 * corresponding event actually fires. A cache hit doesn't allocate an
 * `onRetry` event, for example.
 *
 * # Event shape
 *
 * Every event carries `key`, `traceId`, and `timestamp` for correlation.
 * Event-specific fields are on the same object (no nesting) for flat
 * destructuring in user code.
 *
 * # Ordering
 *
 * For a successful fresh call with retries:
 *   onAttempt (1) → onAttempt (2) → onRetry (1→2) → onAttempt (3) → onFinalSuccess
 *
 * For a cache hit:
 *   onCacheHit → onFinalSuccess
 *
 * For a dedupe joiner:
 *   onDedupeJoin → onFinalSuccess (or onFinalFailure)
 *
 * For a timeout:
 *   onAttempt → onTimeout → onFinalFailure
 */
import type { ActSource } from './types/index.js';
/** Stable discriminator for telemetry. */
export type ActlyEventType = 'attempt' | 'retry' | 'cache-hit' | 'cache-miss' | 'dedupe-join' | 'timeout' | 'final-success' | 'final-failure';
/** Common fields on every event. */
export interface ActlyEventBase {
    /** The `key` passed to `act()`. */
    readonly key: string;
    /** Auto-generated trace ID (or user-supplied via `options.traceId`). */
    readonly traceId: string;
    /** Event timestamp (ms since epoch). */
    readonly timestamp: number;
    /** Discriminator for switch statements. */
    readonly type: ActlyEventType;
}
export interface AttemptEvent extends ActlyEventBase {
    readonly type: 'attempt';
    /** 1-based attempt number. */
    readonly attempt: number;
    /** Duration of this attempt in ms (set after attempt settles). */
    readonly durationMs?: number;
    /** Error from this attempt, if it failed. */
    readonly error?: unknown;
}
export interface RetryEvent extends ActlyEventBase {
    readonly type: 'retry';
    /** The attempt that just failed. */
    readonly attempt: number;
    /** The delay (ms) before the next attempt. */
    readonly delayMs: number;
    /** Error that triggered the retry. */
    readonly error: unknown;
}
export interface CacheHitEvent extends ActlyEventBase {
    readonly type: 'cache-hit';
    /** Age of the cached value in ms. */
    readonly ageMs: number;
}
export interface CacheMissEvent extends ActlyEventBase {
    readonly type: 'cache-miss';
}
export interface DedupeJoinEvent extends ActlyEventBase {
    readonly type: 'dedupe-join';
    /** This caller's position in the joiner queue (1 = first joiner). */
    readonly joinerPosition: number;
}
export interface TimeoutEvent extends ActlyEventBase {
    readonly type: 'timeout';
    /** Which deadline fired. */
    readonly kind: 'per-attempt' | 'total';
    /** The configured ms. */
    readonly ms: number;
}
export interface FinalSuccessEvent extends ActlyEventBase {
    readonly type: 'final-success';
    /** Where the value came from. */
    readonly source: ActSource;
    /** Total attempts made (0 for cache hit). */
    readonly attempts: number;
    /** Total wall-clock duration of the act() call. */
    readonly durationMs: number;
}
export interface FinalFailureEvent extends ActlyEventBase {
    readonly type: 'final-failure';
    /** Total attempts made. */
    readonly attempts: number;
    /** Total wall-clock duration of the act() call. */
    readonly durationMs: number;
    /** Stable reason for failure — use for telemetry tags. */
    readonly failedBy: 'abort' | 'timeout' | 'total-timeout' | 'retry-exhausted' | 'fn-error' | 'validation';
    /** The final error. */
    readonly error: unknown;
}
export type ActlyEvent = AttemptEvent | RetryEvent | CacheHitEvent | CacheMissEvent | DedupeJoinEvent | TimeoutEvent | FinalSuccessEvent | FinalFailureEvent;
/**
 * User-supplied observability hooks. All optional. When absent, zero
 * overhead is incurred on the hot path.
 */
export interface ObservabilityHooks {
    onAttempt?: (event: AttemptEvent) => void;
    onRetry?: (event: RetryEvent) => void;
    onCacheHit?: (event: CacheHitEvent) => void;
    onCacheMiss?: (event: CacheMissEvent) => void;
    onDedupeJoin?: (event: DedupeJoinEvent) => void;
    onTimeout?: (event: TimeoutEvent) => void;
    onFinalSuccess?: (event: FinalSuccessEvent) => void;
    onFinalFailure?: (event: FinalFailureEvent) => void;
}
/**
 * Internal: thread observability through the policy chain without changing
 * every policy's signature. We attach it to `PolicyContext` as an optional
 * field — policies that emit events check for its presence.
 *
 * `traceId` is also stored here so policies can include it in events.
 */
export interface ObservabilityContext {
    traceId: string;
    hooks: ObservabilityHooks;
    /** Counter for dedupe joiner position. Per-key, but we approximate by call. */
    joinerCounter: number;
}
/**
 * Quick null-check helper. Policies call this once at decision points; if
 * it returns false, no further observability work is done.
 */
export declare function hasObservers(ctx: {
    observability?: ObservabilityContext;
}): ctx is {
    observability: ObservabilityContext;
};
//# sourceMappingURL=observability.d.ts.map