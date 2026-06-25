import { REQUIRES_SYNC_STORE } from '../core/executor.js';
import { raceAbort } from '../utils/abort.js';
// Namespace so dedupe keys never collide with cache keys in the shared store.
const NS = 'dedupe:';
/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # How it works
 *
 * The first caller (originator) starts the work and stores
 * `{ promise, meta }` in the store under `dedupe:<key>`. Every subsequent
 * caller that arrives before the promise settles receives the SAME promise
 * — no duplicate work.
 *
 * # Shared `meta` (fixes v1.0 trade-off)
 *
 * The originator's `ctx.meta` reference is stored alongside the promise.
 * Inner policies (e.g. `retryPolicy`) mutate it as they run. After the
 * promise settles, joiners copy `attempts` and `source` from the shared
 * meta into their own `ctx.meta`. This means a joiner's `ActResult.attempts`
 * reflects the real effort (e.g. `3` if the originator retried twice), not
 * the misleading default of `1`.
 *
 * # Abort safety (fixes hung-fn block)
 *
 * Joiners race the in-flight promise against their own AbortSignal via
 * `raceAbort`. If a joiner's signal aborts (e.g. their `totalTimeout`
 * fires), they reject immediately — they don't have to wait for the
 * originator to finish. The originator's promise continues in the
 * background for any other joiners that haven't aborted.
 *
 * If `inflightTtl` is set, the store entry is also TTL'd: if the
 * originator never settles, new callers can start fresh after the TTL
 * expires (the original promise still leaks unless an outer timeout
 * fires, but new callers aren't blocked).
 *
 * # INVARIANT: requires SyncStateStore
 *
 * The read-then-write that makes deduplication work must happen in a single
 * synchronous frame. An async store would introduce an `await` between
 * `get()` and `set()`, letting two concurrent callers both see a miss and
 * both launch work. The `REQUIRES_SYNC_STORE` symbol on the returned
 * `PolicyApplier` lets `execute()` enforce this at runtime for JS callers
 * that bypass TypeScript.
 */
export function dedupePolicy(opts = { enabled: true }) {
    const inflightTtl = opts.inflightTtl;
    const applier = (fn, ctx) => {
        // Cast is safe: execute() verifies isSyncStore(ctx.store) before calling
        // any policy tagged with REQUIRES_SYNC_STORE.
        const syncCtx = ctx;
        return async (signal) => {
            const key = NS + syncCtx.key;
            // Fast path: an in-flight promise already exists. Join it.
            // raceAbort ensures we don't block on a hung originator if our own
            // signal aborts.
            const existing = syncCtx.store.get(key);
            if (existing) {
                try {
                    const value = await raceAbort(existing.promise, signal);
                    return value;
                }
                finally {
                    // Copy the originator's final meta into our own, regardless of
                    // success or failure. By the time `existing.promise` has settled
                    // (or our signal aborted), the originator's retry loop has set
                    // the final attempt count.
                    syncCtx.meta.attempts = existing.meta.attempts;
                    syncCtx.meta.source = existing.meta.source;
                }
            }
            // Originator path: start the work and publish the promise.
            //
            // We race fn against `signal` so that if our own signal aborts while
            // fn is pending, we reject (and the .finally cleans up the store).
            // The stored promise is the RACED one — joiners see the same
            // rejection if they join before cleanup.
            const promise = raceAbort(Promise.resolve(fn(signal)), signal).finally(() => syncCtx.store.delete(key));
            const entry = { promise, meta: syncCtx.meta };
            syncCtx.store.set(key, entry, inflightTtl);
            return promise;
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
//# sourceMappingURL=dedupe.js.map