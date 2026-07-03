"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.circuitBreakerPolicy = circuitBreakerPolicy;
const executor_js_1 = require("../core/executor.js");
const errors_js_1 = require("../errors.js");
const abort_js_1 = require("../utils/abort.js");
const NS = 'cb:';
function getState(store, key) {
    return store.get(NS + key) ?? { failures: 0, lastFailureTime: 0, isOpen: false, openedAt: 0, halfOpen: false };
}
function setState(store, key, state) {
    store.set(NS + key, state);
}
function circuitBreakerPolicy(opts) {
    const threshold = Math.max(1, Math.floor(opts.threshold));
    const cooldownMs = opts.cooldownMs;
    const resetTimeoutMs = opts.resetTimeoutMs ?? Number.POSITIVE_INFINITY;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            const key = syncCtx.key;
            const now = Date.now();
            // Read state synchronously and make decisions atomically
            const state = getState(syncCtx.store, key);
            if (state.isOpen) {
                const elapsed = now - state.openedAt;
                if (elapsed >= cooldownMs) {
                    // Transition to half-open: allow only ONE probe call
                    state.isOpen = false;
                    state.halfOpen = true;
                    setState(syncCtx.store, key, state);
                }
                else {
                    throw new errors_js_1.CircuitBreakerOpenError(key, cooldownMs - elapsed);
                }
            }
            else if (state.halfOpen) {
                // Another call is already probing — block this one
                throw new errors_js_1.CircuitBreakerOpenError(key, 0);
            }
            if (now - state.lastFailureTime > resetTimeoutMs && state.failures > 0) {
                state.failures = 0;
                setState(syncCtx.store, key, state);
            }
            try {
                const result = await fn(signal);
                // Re-read state (it may have changed during await) and update atomically
                const updated = getState(syncCtx.store, key);
                updated.failures = 0;
                updated.isOpen = false;
                updated.halfOpen = false;
                setState(syncCtx.store, key, updated);
                return result;
            }
            catch (err) {
                // Signal aborts are not downstream failures — don't count them
                if ((0, abort_js_1.isAbortError)(err) || (signal.aborted && err === signal.reason)) {
                    const updated = getState(syncCtx.store, key);
                    if (updated.halfOpen) {
                        // Abort during half-open: probe didn't succeed or fail —
                        // downstream health is still unknown. Go back to OPEN with
                        // fresh cooldown so next call waits before probing again.
                        updated.isOpen = true;
                        updated.openedAt = Date.now();
                        updated.halfOpen = false;
                    }
                    setState(syncCtx.store, key, updated);
                    throw err;
                }
                const updated = getState(syncCtx.store, key);
                updated.failures++;
                updated.lastFailureTime = Date.now();
                updated.halfOpen = false;
                if (updated.failures >= threshold) {
                    updated.isOpen = true;
                    updated.openedAt = Date.now();
                }
                setState(syncCtx.store, key, updated);
                throw err;
            }
        };
    };
    applier[executor_js_1.REQUIRES_SYNC_STORE] = true;
    return applier;
}
