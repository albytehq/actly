export { act, invalidate, withStore, } from './core/act.js';
export type { ScopedActSync, ScopedActAsync, } from './core/act.js';
export { execute, REQUIRES_SYNC_STORE, } from './core/executor.js';
export { InMemoryStore } from './stores/memory.js';
export type { InMemoryStoreOptions } from './stores/memory.js';
export { isSyncStore, isAsyncStore, } from './stores/base.js';
export { TimeoutError, TotalTimeoutError, } from './policies/timeout.js';
export type { ActFn, ActResult, ActSuccess, ActFailure, ActSource, ActOptions, RetryOptions, TimeoutOptions, DedupeOptions, CacheOptions, PolicyApplier, PolicyContext, RunMeta, StateStore, // v1.0 alias for SyncStateStore (zero breakage)
SyncStateStore, AsyncStateStore, AnyStateStore, } from './types/index.js';
//# sourceMappingURL=index.d.ts.map