import { REQUIRES_SYNC_STORE } from '../core/executor.js';
import { RateLimitError } from '../errors.js';
const NS = 'rl:';
function getState(store, key) {
    return store.get(NS + key) ?? { timestamps: [] };
}
function setState(store, key, state, ttlMs) {
    store.set(NS + key, state, ttlMs);
}
export function rateLimitPolicy(opts) {
    const maxCalls = Math.max(1, Math.floor(opts.maxCalls));
    const windowMs = opts.windowMs;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            if (signal.aborted)
                return Promise.reject(signal.reason);
            const key = syncCtx.key;
            const now = Date.now();
            const state = getState(syncCtx.store, key);
            const cutoff = now - windowMs;
            const ts = state.timestamps;
            if (ts.length > 0 && ts[0] <= cutoff) {
                let i = 0;
                while (i < ts.length && ts[i] <= cutoff)
                    i++;
                if (i > 0) {
                    state.timestamps = i === ts.length ? [] : ts.slice(i);
                }
            }
            if (state.timestamps.length >= maxCalls) {
                setState(syncCtx.store, key, state, windowMs);
                throw new RateLimitError(key, maxCalls, windowMs);
            }
            state.timestamps.push(now);
            setState(syncCtx.store, key, state, windowMs);
            return fn(signal);
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
