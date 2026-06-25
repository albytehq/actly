import { isSyncStore } from '../stores/base.js';
const NS = 'cache:';
const INFLIGHT_NS = '__inflight:cache:';
/**
 * Short-circuit the entire downstream chain on a cache hit.
 * On a miss, run `fn` and store the result with TTL.
 *
 * # Single-flight (fixes cache stampede)
 *
 * On a sync store, the policy also stores the in-flight Promise under a
 * separate `__inflight:cache:<key>` slot. Concurrent callers that miss the
 * cache but find an in-flight Promise join it instead of launching duplicate
 * work. This is the same mechanism `dedupePolicy` uses, applied internally
 * to cache misses so users don't need to combine `cache` + `dedupe` to
 * avoid stampedes.
 *
 * On an async store, single-flight is not possible (the same sync-store
 * constraint as dedupe applies). Stampedes are a known limitation — document
 * and pair with dedupe at a higher layer if you need single-flight semantics.
 *
 * # Fail-open writes
 *
 * If `store.set()` throws (e.g. Redis transient error), we swallow the error
 * and return the value anyway. The caller gets their result; the next call
 * will simply re-run `fn` and try to cache again. Caching is an optimisation,
 * not a correctness requirement.
 *
 * # Cache hit semantics
 *
 * On a cache hit, `meta.source` is set to `'cache'` and `meta.attempts` is
 * set to `0` — no work was performed. (v1.1.0 reported `attempts: 1` on
 * cache hits, which was inconsistent with the documented meaning of
 * `attempts`. v1.1.5 fixes this.)
 *
 * Failures are NEVER cached. Only successful values are stored.
 */
export function cachePolicy(opts) {
    return (fn, ctx) => async (signal) => {
        const key = NS + ctx.key;
        const inflightKey = INFLIGHT_NS + ctx.key;
        // ─── Sync store: fast path with single-flight ────────────────────────
        if (isSyncStore(ctx.store)) {
            // 1. Cache hit?
            const hit = ctx.store.get(key);
            if (hit) {
                ctx.meta.source = 'cache';
                ctx.meta.attempts = 0;
                return hit.value;
            }
            // 2. In-flight single-flight hit? Join it.
            const inflight = ctx.store.get(inflightKey);
            if (inflight)
                return inflight;
            // 3. Originator: launch fn, cache on success (fail-open).
            const promise = Promise.resolve(fn(signal)).then((value) => {
                try {
                    ctx.store.set(key, { value }, opts.ttl);
                }
                catch {
                    // Fail-open: cache write failure should not surface to caller.
                    // The value is still valid; next call will just re-run fn.
                }
                return value;
            }, (err) => { throw err; });
            // Try to publish the in-flight promise so concurrent callers can
            // join (single-flight). If store.set throws, single-flight is
            // disabled for this call — concurrent callers will all run fn.
            // That's still correct, just less efficient.
            try {
                ctx.store.set(inflightKey, promise);
                // Cleanup the in-flight slot on settle. The `.catch(() => {})`
                // suppresses the unhandled-rejection warning that would otherwise
                // fire on the `.finally()` chain — the original `promise` (with
                // its rejection) is returned to the caller, which has its own
                // try/catch via act().
                promise.finally(() => {
                    try {
                        ctx.store.delete(inflightKey);
                    }
                    catch { /* ignore */ }
                }).catch(() => { });
            }
            catch {
                // Single-flight unavailable; proceed without publishing.
            }
            return promise;
        }
        // ─── Async store: no single-flight (race window unavoidable) ─────────
        const hit = await ctx.store.get(key);
        if (hit) {
            ctx.meta.source = 'cache';
            ctx.meta.attempts = 0;
            return hit.value;
        }
        const value = await fn(signal);
        try {
            await ctx.store.set(key, { value }, opts.ttl);
        }
        catch {
            // Fail-open: see sync path comment.
        }
        return value;
    };
}
//# sourceMappingURL=cache.js.map