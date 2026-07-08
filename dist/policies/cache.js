import { isSyncStore } from '../stores/base.js';
import { safeCall } from '../utils/safeCall.js';
import { raceAbort } from '../utils/abort.js';
import { LIMITS } from '../utils/limits.js';
const NS = 'cache:';
const INFLIGHT_NS = 'inflight:cache:';
let generationCounter = 0;
function nextGeneration() {
    generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER;
    return generationCounter;
}
export function cachePolicy(opts) {
    return (fn, ctx) => async (signal) => {
        if (signal.aborted)
            return Promise.reject(signal.reason);
        const key = NS + ctx.key;
        const inflightKey = INFLIGHT_NS + ctx.key;
        if (isSyncStore(ctx.store)) {
            const store = ctx.store;
            const obs = ctx.observability;
            const hit = store.get(key);
            if (hit) {
                ctx.meta.source = 'cache';
                ctx.meta.attempts = 0;
                if (obs) {
                    const ageMs = Date.now() - hit.insertedAt;
                    safeCall(obs.hooks.onCacheHit, {
                        type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                        timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                    });
                }
                return hit.value;
            }
            if (obs) {
                safeCall(obs.hooks.onCacheMiss, {
                    type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(),
                });
            }
            const inflight = store.get(inflightKey);
            if (inflight) {
                try {
                    const value = await raceAbort(inflight.promise, signal);
                    ctx.meta.attempts = inflight.meta.attempts;
                    ctx.meta.source = inflight.meta.source;
                    return value;
                }
                catch (err) {
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
            const generation = nextGeneration();
            const rawPromise = Promise.resolve(fn(signal)).then((value) => {
                try {
                    store.set(key, { value, insertedAt: Date.now() }, opts.ttl);
                }
                catch {
                }
                return value;
            }, (err) => { throw err; });
            try {
                store.set(inflightKey, { promise: rawPromise, generation, meta: ctx.meta }, LIMITS.DEFAULT_INFLIGHT_TTL);
            }
            catch {
            }
            const cleanup = () => {
                try {
                    const current = store.get(inflightKey);
                    if (current && current.generation === generation) {
                        try {
                            store.delete(inflightKey);
                        }
                        catch { }
                    }
                }
                catch {
                }
            };
            rawPromise.then(cleanup, cleanup).catch(() => { });
            return raceAbort(rawPromise, signal);
        }
        const obs = ctx.observability;
        const hit = await ctx.store.get(key);
        if (signal.aborted)
            return Promise.reject(signal.reason);
        if (hit) {
            ctx.meta.source = 'cache';
            ctx.meta.attempts = 0;
            if (obs) {
                const ageMs = Date.now() - hit.insertedAt;
                safeCall(obs.hooks.onCacheHit, {
                    type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                });
            }
            return hit.value;
        }
        if (obs) {
            safeCall(obs.hooks.onCacheMiss, {
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
        }
        return value;
    };
}
