"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cachePolicy = cachePolicy;
const base_js_1 = require("../stores/base.js");
const NS = 'cache:';
const INFLIGHT_NS = '__inflight:cache:';
let generationCounter = 0;
function nextGeneration() {
    generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER;
    return generationCounter;
}
/**
 * Short-circuit the entire downstream chain on a cache hit.
 * On a miss, run `fn` and store the result with TTL.
 *
 * # Properties
 *
 *  - **Single-flight originator isolation**: the stored in-flight promise is
 *    the RAW `fn(signal)` — NOT raceAbort-wrapped. An originator's signal
 *    abort no longer causes all cache-miss joiners to reject. Each caller
 *    races against their OWN signal only.
 *  - **Generation-safe inflight cleanup**: stale originators don't delete
 *    newer entries (same pattern as dedupePolicy).
 *  - **Signal-aware async store path**: between `await store.get()` and
 *    `await store.set()`, we re-check `signal.aborted`. The previous
 *    version would happily return a cached value even after the caller
 *    aborted mid-Redis-latency.
 *  - **Cache hit honours abort**: if `signal.aborted` is true at policy
 *    entry, we reject immediately — consistent with `act()`'s contract.
 *
 * # Single-flight (cache stampede prevention)
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
 * set to `0` — no work was performed.
 *
 * Failures are NEVER cached. Only successful values are stored.
 */
function cachePolicy(opts) {
    return (fn, ctx) => async (signal) => {
        // Honour abort on cache hit too. Consistent with act()'s
        // "reject immediately if signal aborted" contract.
        if (signal.aborted)
            return Promise.reject(signal.reason);
        const key = NS + ctx.key;
        const inflightKey = INFLIGHT_NS + ctx.key;
        // ─── Sync store: fast path with single-flight ────────────────────────
        if ((0, base_js_1.isSyncStore)(ctx.store)) {
            // Capture the narrowed sync store so closures (cleanup) keep the
            // type information — TS doesn't carry `isSyncStore` narrowing
            // into nested function bodies.
            const store = ctx.store;
            const obs = ctx.observability;
            // 1. Cache hit?
            const hit = store.get(key);
            if (hit) {
                ctx.meta.source = 'cache';
                ctx.meta.attempts = 0;
                // Emit cache-hit event if hooks are registered.
                // Compute actual age from the entry's insertion timestamp.
                if (obs) {
                    const ageMs = Date.now() - hit.insertedAt;
                    obs.hooks.onCacheHit?.({
                        type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                        timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                    });
                }
                return hit.value;
            }
            // Emit cache-miss event if hooks are registered.
            if (obs) {
                obs.hooks.onCacheMiss?.({
                    type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(),
                });
            }
            // 2. In-flight single-flight hit? Join it.
            //
            // The stored promise is RAW fn(signal). Joiners race it
            // against their OWN signal only — originator abort doesn't
            // propagate to joiners.
            const inflight = store.get(inflightKey);
            if (inflight) {
                // Race the in-flight promise against OUR OWN signal. If we
                // abort, we reject — but other joiners and the originator
                // continue unaffected.
                try {
                    const value = await raceWithOwnSignal(inflight.promise, signal);
                    // Mirror originator's meta so joiner's ActResult reflects
                    // the real effort (attempts, source).
                    ctx.meta.attempts = inflight.meta.attempts;
                    ctx.meta.source = inflight.meta.source;
                    return value;
                }
                catch (err) {
                    // Copy meta on failure too (same as dedupe joiners)
                    if (signal.aborted) {
                        ctx.meta.attempts = 0;
                    }
                    else {
                        ctx.meta.attempts = inflight.meta.attempts;
                        ctx.meta.source = inflight.meta.source;
                    }
                    throw err;
                }
            }
            // 3. Originator: launch fn, cache on success (fail-open).
            //
            // The stored promise is the RAW fn(signal) — NOT raceAbort-wrapped.
            // Originator's own await is wrapped in raceWithOwnSignal so they
            // can bail on their signal without affecting joiners.
            const generation = nextGeneration();
            const rawPromise = Promise.resolve(fn(signal)).then((value) => {
                try {
                    store.set(key, { value, insertedAt: Date.now() }, opts.ttl);
                }
                catch {
                    // Fail-open: cache write failure should not surface to caller.
                }
                return value;
            }, 
            // Re-throw the error so joiners see it. Don't cache failures.
            (err) => { throw err; });
            // Publish the in-flight entry for single-flight. If store.set
            // throws, single-flight is disabled for this call — concurrent
            // callers will all run fn. Still correct, just less efficient.
            try {
                store.set(inflightKey, { promise: rawPromise, generation, meta: ctx.meta });
            }
            catch {
                // Single-flight unavailable; proceed without publishing.
                // Originator still gets their value (or error).
            }
            // Cleanup the in-flight slot on settle — generation-safe.
            const cleanup = () => {
                const current = store.get(inflightKey);
                if (current && current.generation === generation) {
                    try {
                        store.delete(inflightKey);
                    }
                    catch { /* ignore */ }
                }
            };
            rawPromise.then(cleanup, cleanup);
            // Originator races the raw promise against their OWN signal.
            return raceWithOwnSignal(rawPromise, signal);
        }
        // Async store: no single-flight (race window unavoidable).
        // Re-check signal.aborted between awaits.
        const obs = ctx.observability;
        const hit = await ctx.store.get(key);
        if (signal.aborted)
            return Promise.reject(signal.reason);
        if (hit) {
            ctx.meta.source = 'cache';
            ctx.meta.attempts = 0;
            if (obs) {
                const ageMs = Date.now() - hit.insertedAt;
                obs.hooks.onCacheHit?.({
                    type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                });
            }
            return hit.value;
        }
        if (obs) {
            obs.hooks.onCacheMiss?.({
                type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
                timestamp: Date.now(),
            });
        }
        const value = await fn(signal);
        if (signal.aborted)
            return Promise.reject(signal.reason);
        try {
            await ctx.store.set(key, { value, insertedAt: Date.now() }, opts.ttl);
        }
        catch {
            // Fail-open: see sync path comment.
        }
        return value;
    };
}
/**
 * Race a promise against a signal — but if the signal aborts, mark the
 * underlying promise as handled (so its eventual rejection doesn't surface
 * as an unhandled rejection). The underlying promise keeps running for any
 * other consumers (e.g. joiners in single-flight).
 *
 * This is `raceAbort` from `utils/abort.ts`, inlined here to avoid an import
 * cycle (cache.ts already imports from stores, dedupe imports from abort —
 * keeping cache independent of abort reduces the import graph depth).
 *
 * Internal — not exported.
 */
function raceWithOwnSignal(promise, signal) {
    if (signal.aborted) {
        promise.catch(() => { }); // mark as handled
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
