import type { ActSource, ActlyFailedBy } from './types/index.js';
export type ActlyEventType = 'attempt' | 'retry' | 'cache-hit' | 'cache-miss' | 'dedupe-join' | 'timeout' | 'final-success' | 'final-failure' | 'backpressure' | 'watchdog';
export interface ActlyEventBase {
    readonly key: string;
    readonly traceId: string;
    readonly timestamp: number;
    readonly type: ActlyEventType;
}
export interface AttemptEvent extends ActlyEventBase {
    readonly type: 'attempt';
    readonly attempt: number;
    readonly durationMs?: number;
    readonly error?: unknown;
}
export interface RetryEvent extends ActlyEventBase {
    readonly type: 'retry';
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
}
export interface CacheHitEvent extends ActlyEventBase {
    readonly type: 'cache-hit';
    readonly ageMs: number;
}
export interface CacheMissEvent extends ActlyEventBase {
    readonly type: 'cache-miss';
}
export interface DedupeJoinEvent extends ActlyEventBase {
    readonly type: 'dedupe-join';
    readonly joinerPosition: number;
}
export interface TimeoutEvent extends ActlyEventBase {
    readonly type: 'timeout';
    readonly kind: 'per-attempt' | 'total';
    readonly ms: number;
}
export interface FinalSuccessEvent extends ActlyEventBase {
    readonly type: 'final-success';
    readonly source: ActSource;
    readonly attempts: number;
    readonly durationMs: number;
}
export interface FinalFailureEvent extends ActlyEventBase {
    readonly type: 'final-failure';
    readonly attempts: number;
    readonly durationMs: number;
    readonly failedBy: ActlyFailedBy;
    readonly error: unknown;
}
export type ActlyEvent = AttemptEvent | RetryEvent | CacheHitEvent | CacheMissEvent | DedupeJoinEvent | TimeoutEvent | FinalSuccessEvent | FinalFailureEvent | BackpressureEvent | WatchdogEvent;
export interface BackpressureEvent extends ActlyEventBase {
    readonly type: 'backpressure';
    readonly source: 'bulkhead';
    readonly queueLength: number;
    readonly maxConcurrent: number;
    readonly maxQueueSize: number;
    readonly utilization: number;
}
export interface WatchdogEvent extends ActlyEventBase {
    readonly type: 'watchdog';
    readonly elapsedMs: number;
    readonly scope: string;
}
export interface ObservabilityHooks {
    onAttempt?: (event: AttemptEvent) => void;
    onRetry?: (event: RetryEvent) => void;
    onCacheHit?: (event: CacheHitEvent) => void;
    onCacheMiss?: (event: CacheMissEvent) => void;
    onDedupeJoin?: (event: DedupeJoinEvent) => void;
    onTimeout?: (event: TimeoutEvent) => void;
    onFinalSuccess?: (event: FinalSuccessEvent) => void;
    onFinalFailure?: (event: FinalFailureEvent) => void;
    onBackpressure?: (event: BackpressureEvent) => void;
    onWatchdog?: (event: WatchdogEvent) => void;
}
export interface ObservabilityContext {
    traceId: string;
    hooks: ObservabilityHooks;
    joinerCounter: number;
}
export declare function hasObservers(ctx: {
    observability?: ObservabilityContext;
}): ctx is {
    observability: ObservabilityContext;
};
//# sourceMappingURL=observability.d.ts.map