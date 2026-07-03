import { REQUIRES_SYNC_STORE } from '../core/executor.js';
import { BulkheadOverflowError } from '../errors.js';
const NS = 'bulk:';
function getState(store, key) {
    return store.get(NS + key) ?? { active: 0, queue: [] };
}
function setState(store, key, state) {
    store.set(NS + key, state);
}
export function bulkheadPolicy(opts) {
    const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
    const queueTimeoutMs = opts.queueTimeoutMs ?? 0;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            const key = syncCtx.key;
            const acquireSlot = () => {
                // If signal already aborted, reject immediately
                if (signal.aborted)
                    return Promise.reject(signal.reason);
                const state = getState(syncCtx.store, key);
                if (state.active < maxConcurrent) {
                    state.active++;
                    setState(syncCtx.store, key, state);
                    return Promise.resolve();
                }
                if (queueTimeoutMs === 0) {
                    throw new BulkheadOverflowError(key, maxConcurrent);
                }
                return new Promise((resolve, reject) => {
                    const state2 = getState(syncCtx.store, key);
                    const entry = {
                        resolve,
                        reject,
                        signal,
                    };
                    // Remove entry from queue on signal abort
                    entry.onAbort = () => {
                        const s = getState(syncCtx.store, key);
                        const idx = s.queue.indexOf(entry);
                        if (idx >= 0) {
                            s.queue.splice(idx, 1);
                            setState(syncCtx.store, key, s);
                        }
                        if (entry.timer)
                            clearTimeout(entry.timer);
                        reject(signal.reason);
                    };
                    if (queueTimeoutMs > 0) {
                        entry.timer = setTimeout(() => {
                            const s = getState(syncCtx.store, key);
                            const idx = s.queue.indexOf(entry);
                            if (idx >= 0)
                                s.queue.splice(idx, 1);
                            setState(syncCtx.store, key, s);
                            signal.removeEventListener('abort', entry.onAbort);
                            reject(new BulkheadOverflowError(key, maxConcurrent));
                        }, queueTimeoutMs);
                    }
                    signal.addEventListener('abort', entry.onAbort, { once: true });
                    state2.queue.push(entry);
                    setState(syncCtx.store, key, state2);
                });
            };
            const releaseSlot = () => {
                const state = getState(syncCtx.store, key);
                state.active--;
                if (state.queue.length > 0) {
                    const next = state.queue.shift();
                    state.active++;
                    if (next.timer)
                        clearTimeout(next.timer);
                    // Remove abort listener from the QUEUED caller's signal (not releaser's)
                    if (next.onAbort && next.signal) {
                        next.signal.removeEventListener('abort', next.onAbort);
                    }
                    next.resolve();
                }
                if (state.active < 0)
                    state.active = 0;
                setState(syncCtx.store, key, state);
            };
            await acquireSlot();
            try {
                return await fn(signal);
            }
            finally {
                releaseSlot();
            }
        };
    };
    applier[REQUIRES_SYNC_STORE] = true;
    return applier;
}
//# sourceMappingURL=bulkhead.js.map