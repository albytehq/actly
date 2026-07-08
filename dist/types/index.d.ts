export type ActFn<T> = (signal: AbortSignal) => Promise<T> | T;
export type ActSource = 'fresh' | 'cache';
export interface ActSuccess<T> {
    ok: true;
    value: T;
    source: ActSource;
    attempts: number;
    traceId?: string;
    durationMs?: number;
}
export interface ActFailure {
    ok: false;
    error: unknown;
    attempts: number;
    traceId?: string;
    durationMs?: number;
}
export type ActResult<T> = ActSuccess<T> | ActFailure;
export interface RetryOptions {
    attempts: number;
    delayMs?: number;
    backoff?: 'none' | 'linear' | 'exponential';
    backoffFn?: (attempt: number, error: unknown, state: Record<string, unknown>) => number;
    maxDelay?: number;
    jitter?: 'none' | 'full' | 'equal' | 'decorrelated';
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    shouldRetryResult?: <V>(value: V, attempt: number) => boolean;
    dangerouslyUnref?: boolean;
}
export interface TimeoutOptions {
    ms: number;
    strategy?: 'race' | 'cooperative';
}
export interface DedupeOptions {
    enabled: boolean;
    inflightTtl?: number;
}
export interface CacheOptions {
    ttl: number;
}
export interface ActOptions<T = unknown> {
    retry?: RetryOptions;
    timeout?: TimeoutOptions;
    dedupe?: boolean | DedupeOptions;
    cache?: CacheOptions;
    totalTimeout?: TimeoutOptions;
    signal?: AbortSignal;
    observability?: ObservabilityHooks;
    traceId?: string;
    circuitBreaker?: CircuitBreakerOptions;
    bulkhead?: BulkheadOptions;
    rateLimit?: RateLimitOptions;
    hedge?: HedgeOptions;
    fallback?: FallbackOptions<T>;
    audit?: AuditOptions;
}
export interface CircuitBreakerOptions {
    threshold: number;
    cooldownMs: number;
    resetTimeoutMs?: number;
    strategy?: 'consecutive' | 'count';
    countSize?: number;
    countThreshold?: number;
    countMinimumCalls?: number;
}
export interface BulkheadOptions {
    maxConcurrent: number;
    queueTimeoutMs?: number;
    maxQueueSize?: number;
}
export interface RateLimitOptions {
    maxCalls: number;
    windowMs: number;
}
export interface HedgeOptions {
    delayMs: number;
    placement?: 'outside-retry' | 'inside-retry';
    keepLoser?: boolean;
}
export interface FallbackOptions<T> {
    value: T | (() => T | Promise<T>);
}
export interface AuditOptions {
    log: (entry: AuditEntry) => void;
}
export interface AuditEntry {
    key: string;
    traceId: string;
    timestamp: number;
    durationMs: number;
    ok: boolean;
    attempts: number;
    failedBy?: ActlyFailedBy;
    error?: unknown;
}
export type ActlyFailedBy = 'abort' | 'timeout' | 'total-timeout' | 'retry-exhausted' | 'fn-error' | 'validation' | 'circuit-open' | 'bulkhead-full' | 'rate-limited' | 'resource-exhausted' | 'hedge-timeout';
export interface RunMeta {
    attempts: number;
    source: ActSource;
}
export type { ObservabilityContext } from '../observability.js';
import type { ObservabilityContext } from '../observability.js';
export interface PolicyContext {
    key: string;
    store: AnyStateStore;
    meta: RunMeta;
    observability?: ObservabilityContext;
}
export type PolicyApplier<T> = (fn: ActFn<T>, ctx: PolicyContext) => ActFn<T>;
import type { SyncStateStore, AsyncStateStore } from '../stores/base.js';
export type { SyncStateStore, AsyncStateStore };
import type { ObservabilityHooks as ObsHooks } from '../observability.js';
export type ObservabilityHooks = ObsHooks;
export type StateStore = SyncStateStore;
export type AnyStateStore = SyncStateStore | AsyncStateStore;
//# sourceMappingURL=index.d.ts.map