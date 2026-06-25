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
  TimeoutError,
  TotalTimeoutError,
} from './policies/timeout.js'

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
  StateStore,        // v1.0 alias for SyncStateStore (zero breakage)
  SyncStateStore,
  AsyncStateStore,
  AnyStateStore,
} from './types/index.js'
