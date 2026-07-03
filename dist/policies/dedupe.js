import { REQUIRES_SYNC_STORE } from '../core/executor.js';
import { raceAbort } from '../utils/abort.js';
// Namespace so dedupe keys never collide with cache keys in the shared store.
const NS = 'dedupe:';
/**
 * Module-level generation counter. Monotonic — guarantees uniqueness
 * across the lifetime of the process. Wraps at `Number.MAX_SAFE_INTEGER`
 * (which would take ~285 000 years at 1M increments/sec).
 */
let generationCounter = 0;
function nextGeneration() {
    generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER;
    return generationCounter;
}
/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # Properties
 *
 *  - **Generation-safe cleanup**: stale originators never delete newer
 *    entries when `inflightTtl` triggers replacement.
 *  - **Joiner isolation**: originator's caller-signal abort does NOT
 *    propagate to joiners. Each joiner races the shared in-flight promise
 *    against their OWN signal only.
 *  - **Truthful joiner attempts**: joiners that abort before the originator
 *    settles report `attempts: 0` (they did no work), not the originator's
 *    in-progress count.
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
            // ─── Fast path: an in-flight promise already exists. Join it. ──────
            //
            // The joiner races the in-flight promise against THEIR OWN signal.
            // They do NOT inherit the originator's signal state — if the
            // originator's caller cancels, joiners continue waiting (or get
            // the eventual settled value).
            const existing = syncCtx.store.get(key);
            if (existing) {
                try {
                    const value = await raceAbort(existing.promise, signal);
                    // Success — copy originator's final meta (attempts, source)
                    // so the joiner's ActResult reflects the real effort.
                    syncCtx.meta.attempts = existing.meta.attempts;
                    syncCtx.meta.source = existing.meta.source;
                    return value;
                }
                catch (err) {
                    // Joiner either aborted (their own signal) or got the
                    // originator's settled error.
                    if (signal.aborted) {
                        // Joiner's own signal aborted before originator settled.
                        // They did no work — report `attempts: 0` (truthful).
                        syncCtx.meta.attempts = 0;
                        // source stays 'fresh' (default) — joiner didn't read from cache
                    }
                    else {
                        // Originator settled with failure — copy its final meta.
                        syncCtx.meta.attempts = existing.meta.attempts;
                        syncCtx.meta.source = existing.meta.source;
                    }
                    throw err;
                }
            }
            // ─── Originator path: start the work and publish the promise. ──────
            //
            // The stored promise is the RAW fn(signal) — NOT raceAbort-wrapped.
            // This is critical: if we stored raceAbort(fn, signal), an
            // originator signal abort would cause the stored promise to reject,
            // which would propagate to all joiners. Instead:
            //   - stored: raw fn(signal) — joiners await this
            //   - originator's await: raceAbort(stored, signal) — originator
            //     can bail out on their own signal without affecting joiners
            const generation = nextGeneration();
            const rawPromise = Promise.resolve(fn(signal));
            const entry = {
                promise: rawPromise,
                meta: syncCtx.meta,
                generation,
            };
            syncCtx.store.set(key, entry, inflightTtl);
            // Cleanup on settle: only delete if generation matches. If a newer
            // originator has replaced this entry (because inflightTtl expired),
            // our cleanup is a no-op — the newer entry stays.
            const cleanup = () => {
                const current = syncCtx.store.get(key);
                if (current && current.generation === generation) {
                    syncCtx.store.delete(key);
                }
            };
            // Attach cleanup to the RAW promise (not the raceAbort-wrapped one)
            // so cleanup runs whenever fn settles, regardless of originator abort.
            rawPromise.then(cleanup, cleanup);
            // Originator races the raw promise against their own signal —
            // they can bail out without affecting joiners.
            return raceAbort(rawPromise, signal);
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
//# sourceMappingURL=dedupe.js.map