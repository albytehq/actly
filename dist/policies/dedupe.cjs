"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dedupePolicy = dedupePolicy;
const executor_js_1 = require("../core/executor.js");
const abort_js_1 = require("../utils/abort.js");
const safeCall_js_1 = require("../utils/safeCall.js");
const limits_js_1 = require("../utils/limits.js");
const NS = 'dedupe:';
let generationCounter = 0;
function nextGeneration() {
    generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER;
    return generationCounter;
}
function dedupePolicy(opts = { enabled: true }) {
    const inflightTtl = opts.inflightTtl ?? limits_js_1.LIMITS.DEFAULT_INFLIGHT_TTL;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            const key = NS + syncCtx.key;
            const existing = syncCtx.store.get(key);
            if (existing) {
                const obs = syncCtx.observability;
                if (obs) {
                    obs.joinerCounter++;
                    (0, safeCall_js_1.safeCall)(obs.hooks.onDedupeJoin, {
                        type: 'dedupe-join', key: syncCtx.key, traceId: obs.traceId,
                        timestamp: Date.now(), joinerPosition: obs.joinerCounter,
                    });
                }
                try {
                    const value = await (0, abort_js_1.raceAbort)(existing.promise, signal);
                    syncCtx.meta.attempts = existing.meta.attempts;
                    syncCtx.meta.source = existing.meta.source;
                    return value;
                }
                catch (err) {
                    if (signal.aborted) {
                        syncCtx.meta.attempts = 0;
                    }
                    else {
                        syncCtx.meta.attempts = existing.meta.attempts;
                        syncCtx.meta.source = existing.meta.source;
                    }
                    throw err;
                }
            }
            const generation = nextGeneration();
            const rawPromise = Promise.resolve(fn(signal));
            const entry = {
                promise: rawPromise,
                meta: syncCtx.meta,
                generation,
            };
            syncCtx.store.set(key, entry, inflightTtl);
            const cleanup = () => {
                try {
                    const current = syncCtx.store.get(key);
                    if (current && current.generation === generation) {
                        syncCtx.store.delete(key);
                    }
                }
                catch {
                }
            };
            rawPromise.then(cleanup, cleanup).catch(() => { });
            return (0, abort_js_1.raceAbort)(rawPromise, signal);
        };
    };
    applier[executor_js_1.REQUIRES_SYNC_STORE] = true;
    return applier;
}
