"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cachePolicy = cachePolicy;
const base_js_1 = require("../stores/base.js");
const safeCall_js_1 = require("../utils/safeCall.js");
const abort_js_1 = require("../utils/abort.js");
const limits_js_1 = require("../utils/limits.js");
const NS = 'cache:';
const INFLIGHT_NS = 'inflight:cache:';
let generationCounter = 0;
function nextGeneration() {
    generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER;
    return generationCounter;
}
function cachePolicy(opts) {
    return (fn, ctx) => async (signal) => {
        if (signal.aborted)
            return Promise.reject(signal.reason);
        const key = NS + ctx.key;
        const inflightKey = INFLIGHT_NS + ctx.key;
        if ((0, base_js_1.isSyncStore)(ctx.store)) {
            const store = ctx.store;
            const obs = ctx.observability;
            const hit = store.get(key);
            if (hit) {
                ctx.meta.source = 'cache';
                ctx.meta.attempts = 0;
                if (obs) {
                    const ageMs = Date.now() - hit.insertedAt;
                    (0, safeCall_js_1.safeCall)(obs.hooks.onCacheHit, {
                        type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                        timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                    });
                }
                return hit.value;
            }
            if (obs) {
                (0, safeCall_js_1.safeCall)(obs.hooks.onCacheMiss, {
                    type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(),
                });
            }
            const inflight = store.get(inflightKey);
            if (inflight) {
                try {
                    const value = await (0, abort_js_1.raceAbort)(inflight.promise, signal);
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
                store.set(inflightKey, { promise: rawPromise, generation, meta: ctx.meta }, limits_js_1.LIMITS.DEFAULT_INFLIGHT_TTL);
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
            return (0, abort_js_1.raceAbort)(rawPromise, signal);
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
                (0, safeCall_js_1.safeCall)(obs.hooks.onCacheHit, {
                    type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(), ageMs: Math.max(0, ageMs),
                });
            }
            return hit.value;
        }
        if (obs) {
            (0, safeCall_js_1.safeCall)(obs.hooks.onCacheMiss, {
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
