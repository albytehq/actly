// ─── Primary API ──────────────────────────────────────────────────────────────
export { act, invalidate, withStore, } from './core/act.js';
// ─── Execution engine (for custom policy chains) ──────────────────────────────
export { execute, REQUIRES_SYNC_STORE, } from './core/executor.js';
// ─── Stores ───────────────────────────────────────────────────────────────────
export { InMemoryStore } from './stores/memory.js';
export { isSyncStore, isAsyncStore, } from './stores/base.js';
// ─── Error classes ────────────────────────────────────────────────────────────
export { TimeoutError, TotalTimeoutError, } from './policies/timeout.js';
//# sourceMappingURL=index.js.map