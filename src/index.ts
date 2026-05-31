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
  StateStore,
} from './types/index.js'

// Exported so consumers can build isolated stores (e.g. per-request in SSR)
export { InMemoryStore } from './state/store.js'

// Exported so callers can instanceof-check against timeout failures
export { TimeoutError, TotalTimeoutError } from './policies/timeout.js'
