export { act } from './core/act.js'

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
  // v1.0 public type — preserved as alias for SyncStateStore (zero breakage)
  StateStore,
  // v1.1 additions — additive, non-breaking
  SyncStateStore,
  AsyncStateStore,
} from './types/index.js'

// Exported so consumers can build isolated stores (e.g. per-request in SSR)
export { InMemoryStore } from './stores/memory.js'
export type { InMemoryStoreOptions } from './stores/memory.js'

// Exported so callers can instanceof-check against timeout failures
export { TimeoutError, TotalTimeoutError } from './policies/timeout.js'
