// ─── Primary API ──────────────────────────────────────────────────────────────

export { act, invalidate, withStore } from './core/act.js'
export type { ScopedActSync, ScopedActAsync } from './core/act.js'

// ─── Execution engine (for custom policy chains) ──────────────────────────────

export { execute, REQUIRES_SYNC_STORE } from './core/executor.js'
export type { ExecutorInput } from './core/executor.js'

// ─── Policy factories (public since 1.4 — build custom chains with execute) ─

export { retryPolicy } from './policies/retry.js'
export { timeoutPolicy, totalTimeoutPolicy } from './policies/timeout.js'
export { dedupePolicy } from './policies/dedupe.js'
export { cachePolicy } from './policies/cache.js'
export { circuitBreakerPolicy } from './policies/circuitBreaker.js'
export { bulkheadPolicy } from './policies/bulkhead.js'
export { rateLimitPolicy } from './policies/rateLimit.js'
export { noopPolicy } from './policies/noop.js'
export { computeDelay } from './backoff.js'

// ─── Stores ───────────────────────────────────────────────────────────────────

export { InMemoryStore } from './stores/memory.js'
export type { InMemoryStoreOptions } from './stores/memory.js'
export { isSyncStore, isAsyncStore } from './stores/contract.js'

// ─── Error classes ────────────────────────────────────────────────────────────

export {
  ActlyError,
  ActlyAbortError,
  TimeoutError,
  TotalTimeoutError,
  RetryExhaustedError,
  ValidationError,
  HedgeTimeoutError,
  CircuitBreakerOpenError,
  BulkheadOverflowError,
  RateLimitError,
  ResourceExhaustedError,
  isActlyError,
  sanitizeError,
  sanitizeErrorMessage,
} from './errors.js'

// ─── Observability ────────────────────────────────────────────────────────────

export { OBSERVABILITY_HOOKS } from './observability.js'
export type { ObservabilityHookName } from './observability.js'
export type { ObservabilityContext } from './observability.js'
export type {
  ActlyEventType,
  ActlyEventBase,
  AttemptEvent,
  RetryEvent,
  CacheHitEvent,
  CacheMissEvent,
  DedupeJoinEvent,
  TimeoutEvent,
  FinalSuccessEvent,
  FinalFailureEvent,
  BackpressureEvent,
  WatchdogEvent,
  ActlyEvent,
  ObservabilityHooks,
} from './observability.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type {
  ActFn,
  ActResult,
  ActSuccess,
  ActFailure,
  ActSource,
  ActOptions,
  RetryOptions,
  TimeoutOptions,
  DedupeOptions,
  CacheOptions,
  PolicyApplier,
  PolicyContext,
  RunMeta,
  StateStore,
  SyncStateStore,
  AsyncStateStore,
  AnyStateStore,
  CircuitBreakerOptions,
  BulkheadOptions,
  RateLimitOptions,
  HedgeOptions,
  FallbackOptions,
  AuditOptions,
  AuditEntry,
} from './types.js'

// ─── Cancellation utilities ───────────────────────────────────────────────────

export {
  anySignal,
  raceAbort,
  sleep,
  linkSignal,
  isAbortError,
} from './abort.js'

// ─── Validation ───────────────────────────────────────────────────────────────

export { sanitizeKey } from './keys.js'
export { LIMITS } from './limits.js'
export type { Limits } from './limits.js'

// ─── Health check & graceful shutdown ─────────────────────────────────────────

export {
  createHealthCheck,
  enableWatchdog,
  registerWatchdogHooks,
  unregisterWatchdogHooks,
  disableWatchdog,
} from './core/health.js'
export type { HealthStatus, HealthCheckFn } from './core/health.js'

export { drain, drainAll } from './core/shutdown.js'

// ─── Tenant isolation ─────────────────────────────────────────────────────────

export { createTenantStore, createAsyncTenantStore } from './core/tenant.js'
export type { TenantStoreOptions, TenantManager } from './core/tenant.js'

// ─── Decorator ────────────────────────────────────────────────────────────────

export { usePolicy } from './usePolicy.js'

// ─── Deprecated: AbortController pool ─────────────────────────────────────────
// The fast path uses a shared never-aborted signal; the pool has no
// internal use since 1.4 and will be removed in 2.0.

export {
  acquireController,
  releaseController,
  poolSize,
} from './abort.js'
