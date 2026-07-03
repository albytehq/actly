export { act, invalidate, withStore, } from './core/act.js';
export type { ScopedActSync, ScopedActAsync, } from './core/act.js';
export { execute, REQUIRES_SYNC_STORE, } from './core/executor.js';
export { InMemoryStore } from './stores/memory.js';
export type { InMemoryStoreOptions } from './stores/memory.js';
export { isSyncStore, isAsyncStore, } from './stores/base.js';
export { ActlyError, ActlyAbortError, TimeoutError, TotalTimeoutError, RetryExhaustedError, ValidationError, } from './errors.js';
export type { ActlyEventType, ActlyEventBase, AttemptEvent, RetryEvent, CacheHitEvent, CacheMissEvent, DedupeJoinEvent, TimeoutEvent, FinalSuccessEvent, FinalFailureEvent, ActlyEvent, ObservabilityHooks, } from './observability.js';
export type { ActFn, ActResult, ActSuccess, ActFailure, ActSource, ActOptions, RetryOptions, TimeoutOptions, DedupeOptions, CacheOptions, PolicyApplier, PolicyContext, RunMeta, StateStore, // alias for SyncStateStore (backwards compat)
SyncStateStore, AsyncStateStore, AnyStateStore, } from './types/index.js';
export { anySignal, raceAbort, sleep, linkSignal, isAbortError, } from './utils/abort.js';
export { sanitizeKey, } from './utils/key.js';
export { computeDelay, } from './utils/backoff.js';
export { LIMITS, } from './utils/limits.js';
export type { Limits } from './utils/limits.js';
export { CircuitBreakerOpenError, BulkheadOverflowError, RateLimitError, } from './errors.js';
export { createHealthCheck, } from './core/health.js';
export type { HealthStatus } from './core/health.js';
export { drain, } from './core/shutdown.js';
export { createTenantStore, createAsyncTenantStore, } from './core/tenant.js';
export type { TenantStoreOptions, TenantManager } from './core/tenant.js';
export { sanitizeErrorMessage, sanitizeError, } from './utils/sanitize.js';
export { acquireController, releaseController, poolSize, } from './utils/abortPool.js';
export type { CircuitBreakerOptions, BulkheadOptions, RateLimitOptions, HedgeOptions, FallbackOptions, AuditOptions, AuditEntry, } from './types/index.js';
//# sourceMappingURL=index.d.ts.map