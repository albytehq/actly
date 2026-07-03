"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitPolicy = rateLimitPolicy;
const executor_js_1 = require("../core/executor.js");
const errors_js_1 = require("../errors.js");
const NS = 'rl:';
function getState(store, key) {
    return store.get(NS + key) ?? { timestamps: [] };
}
function setState(store, key, state) {
    store.set(NS + key, state);
}
function rateLimitPolicy(opts) {
    const maxCalls = Math.max(1, Math.floor(opts.maxCalls));
    const windowMs = opts.windowMs;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            const key = syncCtx.key;
            const now = Date.now();
            const state = getState(syncCtx.store, key);
            const cutoff = now - windowMs;
            state.timestamps = state.timestamps.filter(t => t > cutoff);
            if (state.timestamps.length >= maxCalls) {
                setState(syncCtx.store, key, state);
                throw new errors_js_1.RateLimitError(key, maxCalls, windowMs);
            }
            state.timestamps.push(now);
            setState(syncCtx.store, key, state);
            return fn(signal);
        };
    };
    applier[executor_js_1.REQUIRES_SYNC_STORE] = true;
    return applier;
}
