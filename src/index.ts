// ─── Primary API ──────────────────────────────────────────────────────────────

export {
  act,
  invalidate,
  withStore,
} from './core/act.js'

export type {
  ScopedActSync,
  ScopedActAsync,
} from './core/act.js'

// ─── Execution engine (for custom policy chains) ──────────────────────────────

export {
  execute,
  REQUIRES_SYNC_STORE,
} from './core/executor.js'

// ─── Stores ───────────────────────────────────────────────────────────────────

export { InMemoryStore } from './stores/memory.js'
export type { InMemoryStoreOptions } from './stores/memory.js'

export {
  isSyncStore,
  isAsyncStore,
} from './stores/base.js'

// ─── Error classes ────────────────────────────────────────────────────────────

export {
  ActlyError,
  ActlyAbortError,
  TimeoutError,
  TotalTimeoutError,
  RetryExhaustedError,
  ValidationError,
} from './errors.js'

// ─── Observability ───────────────────────────────────────────────────────────

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
  ActlyEvent,
  ObservabilityHooks,
} from './observability.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type {
  // Function & result shapes
  ActFn,
  ActResult,
  ActSuccess,
  ActFailure,
  ActSource,
  ActOptions,

  // Policy options
  RetryOptions,
  TimeoutOptions,
  DedupeOptions,
  CacheOptions,

  // Policy internals (for custom policy authors)
  PolicyApplier,
  PolicyContext,
  RunMeta,

  // Store types
  StateStore,        // alias for SyncStateStore (backwards compat)
  SyncStateStore,
  AsyncStateStore,
  AnyStateStore,
} from './types/index.js'

// ─── Utilities (for custom policy authors) ────────────────────────────────────

export {
  anySignal,
  raceAbort,
  sleep,
  linkSignal,
  isAbortError,
} from './utils/abort.js'

export {
  sanitizeKey,
} from './utils/key.js'

export {
  computeDelay,
} from './utils/backoff.js'

export {
  LIMITS,
} from './utils/limits.js'

export type { Limits } from './utils/limits.js'

// ─── Hardening: new error classes ────────────────────────────────────────────

export {
  CircuitBreakerOpenError,
  BulkheadOverflowError,
  RateLimitError,
} from './errors.js'

// ─── Hardening: health check & graceful shutdown ─────────────────────────────

export {
  createHealthCheck,
} from './core/health.js'
export type { HealthStatus } from './core/health.js'

export {
  drain,
} from './core/shutdown.js'

// ─── Hardening: tenant isolation ─────────────────────────────────────────────

export {
  createTenantStore,
  createAsyncTenantStore,
} from './core/tenant.js'
export type { TenantStoreOptions, TenantManager } from './core/tenant.js'

// ─── Hardening: error sanitization ───────────────────────────────────────────

export {
  sanitizeErrorMessage,
  sanitizeError,
} from './utils/sanitize.js'

// ─── Hardening: AbortController pool ─────────────────────────────────────────

export {
  acquireController,
  releaseController,
  poolSize,
} from './utils/abortPool.js'

// ─── Hardening: policy types ─────────────────────────────────────────────────

export type {
  CircuitBreakerOptions,
  BulkheadOptions,
  RateLimitOptions,
  HedgeOptions,
  FallbackOptions,
  AuditOptions,
  AuditEntry,
} from './types/index.js'
