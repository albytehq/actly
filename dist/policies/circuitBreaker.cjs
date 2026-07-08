"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.circuitBreakerPolicy = circuitBreakerPolicy;
const executor_js_1 = require("../core/executor.js");
const errors_js_1 = require("../errors.js");
const abort_js_1 = require("../utils/abort.js");
const NS = 'cb:';
function getState(store, key, strategy) {
    const existing = store.get(NS + key);
    if (existing)
        return existing;
    if (strategy === 'count') {
        return {
            strategy: 'count',
            outcomes: [],
            index: 0,
            failures: 0,
            filled: 0,
            isOpen: false,
            openedAt: 0,
            halfOpen: false,
            lastFailureTime: 0,
        };
    }
    return {
        strategy: 'consecutive',
        failures: 0,
        lastFailureTime: 0,
        isOpen: false,
        openedAt: 0,
        halfOpen: false,
    };
}
function setState(store, key, state) {
    store.set(NS + key, state);
}
function recordCountOutcome(state, success, windowSize) {
    if (state.outcomes.length < windowSize) {
        state.outcomes.push(success);
        state.filled = state.outcomes.length;
        if (!success)
            state.failures++;
        state.index = (state.index + 1) % windowSize;
        return;
    }
    if (state.outcomes[state.index] === false)
        state.failures--;
    state.outcomes[state.index] = success;
    if (!success)
        state.failures++;
    state.index = (state.index + 1) % windowSize;
    state.filled = windowSize;
}
function countFailureRate(state) {
    if (state.filled === 0)
        return 0;
    return state.failures / state.filled;
}
function resetCountState(state) {
    state.outcomes = [];
    state.index = 0;
    state.failures = 0;
    state.filled = 0;
    state.isOpen = false;
    state.openedAt = 0;
    state.halfOpen = false;
    state.lastFailureTime = 0;
}
function circuitBreakerPolicy(opts) {
    const threshold = Math.max(1, Math.floor(opts.threshold));
    const cooldownMs = opts.cooldownMs;
    const resetTimeoutMs = opts.resetTimeoutMs ?? Number.POSITIVE_INFINITY;
    const strategy = opts.strategy ?? 'consecutive';
    const countSize = strategy === 'count' ? Math.max(1, Math.floor(opts.countSize ?? 100)) : 0;
    const countThreshold = strategy === 'count'
        ? Math.min(1, Math.max(0, opts.countThreshold ?? 0.5))
        : 0;
    const countMinimumCalls = strategy === 'count'
        ? Math.max(1, Math.floor(opts.countMinimumCalls ?? countSize))
        : 0;
    const applier = (fn, ctx) => {
        const syncCtx = ctx;
        return async (signal) => {
            const key = syncCtx.key;
            const now = Date.now();
            const state = getState(syncCtx.store, key, strategy);
            if (state.isOpen) {
                const elapsed = now - state.openedAt;
                if (elapsed >= cooldownMs) {
                    state.isOpen = false;
                    state.halfOpen = true;
                    setState(syncCtx.store, key, state);
                }
                else {
                    throw new errors_js_1.CircuitBreakerOpenError(key, cooldownMs - elapsed);
                }
            }
            else if (state.halfOpen) {
                throw new errors_js_1.CircuitBreakerOpenError(key, 0);
            }
            if (now - state.lastFailureTime > resetTimeoutMs && state.lastFailureTime > 0) {
                if (!state.halfOpen) {
                    if (state.strategy === 'count') {
                        resetCountState(state);
                    }
                    else {
                        state.failures = 0;
                        state.isOpen = false;
                        state.openedAt = 0;
                        state.halfOpen = false;
                    }
                    setState(syncCtx.store, key, state);
                }
            }
            try {
                const result = await fn(signal);
                const updated = getState(syncCtx.store, key, strategy);
                const wasHalfOpen = updated.halfOpen;
                if (wasHalfOpen && updated.strategy === 'count') {
                    resetCountState(updated);
                }
                else if (updated.strategy === 'count') {
                    recordCountOutcome(updated, true, countSize);
                }
                else {
                    updated.failures = 0;
                }
                if (wasHalfOpen) {
                    updated.isOpen = false;
                    updated.halfOpen = false;
                }
                const isIdle = updated.failures === 0 && !updated.isOpen && !updated.halfOpen;
                if (isIdle) {
                    syncCtx.store.delete(NS + key);
                }
                else {
                    setState(syncCtx.store, key, updated);
                }
                return result;
            }
            catch (err) {
                if (signal.aborted && ((0, abort_js_1.isAbortError)(err) || err === signal.reason)) {
                    const updated = getState(syncCtx.store, key, strategy);
                    if (updated.failures === 0 && !updated.isOpen && !updated.halfOpen) {
                        syncCtx.store.delete(NS + key);
                    }
                    else {
                        setState(syncCtx.store, key, updated);
                    }
                    throw err;
                }
                const updated = getState(syncCtx.store, key, strategy);
                const wasHalfOpen = updated.halfOpen;
                updated.lastFailureTime = Date.now();
                updated.halfOpen = false;
                if (updated.strategy === 'count') {
                    recordCountOutcome(updated, false, countSize);
                    const rate = countFailureRate(updated);
                    const enoughCalls = updated.filled >= countMinimumCalls;
                    if (wasHalfOpen || (enoughCalls && rate > countThreshold)) {
                        updated.isOpen = true;
                        updated.openedAt = Date.now();
                    }
                }
                else {
                    updated.failures++;
                    if (updated.failures >= threshold || wasHalfOpen) {
                        updated.isOpen = true;
                        updated.openedAt = Date.now();
                    }
                }
                setState(syncCtx.store, key, updated);
                throw err;
            }
        };
    };
    applier[executor_js_1.REQUIRES_SYNC_STORE] = true;
    return applier;
}
