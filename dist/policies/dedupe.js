import { REQUIRES_SYNC_STORE } from '../core/executor.js';
// Namespace so dedupe keys never collide with cache keys in the shared store
const NS = 'dedupe:';
/**
 * Collapses concurrent calls that share the same key into one in-flight Promise.
 *
 * The first caller starts the work. Every subsequent caller that arrives before
 * the first resolves gets the same Promise back — no duplicate work.
 *
 * INVARIANT: requires a SyncStateStore — see stores/base.ts.
 * The read-then-write that makes deduplication work must happen in a single
 * synchronous frame. An async store would introduce an await between get() and
 * set(), letting two concurrent callers both see a miss and both launch work.
 * The REQUIRES_SYNC_STORE symbol on the returned PolicyApplier lets execute()
 * enforce this at runtime for JS callers that bypass TypeScript.
 *
 * Known tradeoff (v1): deduped callers see attempts=1 in their ActResult because
 * the retry counter belongs to the originating call's meta object.
 */
export function dedupePolicy() {
    const applier = (fn, ctx) => {
        // Cast is safe: execute() verifies isSyncStore(ctx.store) before calling
        // any policy tagged with REQUIRES_SYNC_STORE.
        const syncCtx = ctx;
        return async () => {
            const key = NS + syncCtx.key;
            const inflight = syncCtx.store.get(key);
            if (inflight)
                return inflight;
            // No TTL — .finally() cleans up regardless of outcome
            const promise = fn().finally(() => syncCtx.store.delete(key));
            syncCtx.store.set(key, promise);
            return promise;
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
//# sourceMappingURL=dedupe.js.map