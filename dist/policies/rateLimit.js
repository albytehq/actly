import { REQUIRES_SYNC_STORE } from '../core/executor.js';
import { RateLimitError } from '../errors.js';
const NS = 'rl:';
function getState(store, key) {
    return store.get(NS + key) ?? { timestamps: [] };
}
function setState(store, key, state) {
    store.set(NS + key, state);
}
export function rateLimitPolicy(opts) {
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
                throw new RateLimitError(key, maxCalls, windowMs);
            }
            state.timestamps.push(now);
            setState(syncCtx.store, key, state);
            return fn(signal);
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
//# sourceMappingURL=rateLimit.js.map