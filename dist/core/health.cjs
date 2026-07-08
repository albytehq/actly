"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStoreScope = registerStoreScope;
exports.resolveStoreScope = resolveStoreScope;
exports.registerInflight = registerInflight;
exports.unregisterInflight = unregisterInflight;
exports.enableWatchdog = enableWatchdog;
exports.registerWatchdogHooks = registerWatchdogHooks;
exports.unregisterWatchdogHooks = unregisterWatchdogHooks;
exports.disableWatchdog = disableWatchdog;
exports.recordError = recordError;
exports.recordSuccess = recordSuccess;
exports.createHealthCheck = createHealthCheck;
const limits_js_1 = require("../utils/limits.js");
const errors_js_1 = require("../errors.js");
const safeCall_js_1 = require("../utils/safeCall.js");
const storeScopes = new WeakMap();
function registerStoreScope(store, scope) {
    storeScopes.set(store, scope);
}
function resolveStoreScope(store) {
    return storeScopes.get(store);
}
const healthStates = new Map();
const startTime = Date.now();
const INFLIGHT_LIMIT_DISABLED = process.env.ACTLY_NO_INFLIGHT_LIMIT === '1' ||
    process.env.ACTLY_NO_INFLIGHT_LIMIT === 'true';
const INFLIGHT_LIMIT = limits_js_1.LIMITS.MAX_GLOBAL_INFLIGHT;
let globalInflightCount = 0;
let inflightBusySince;
let watchdogTimer;
let watchdogThresholdMs = 60_000;
const watchdogHooks = new Set();
let watchdogFiredForBusySince;
function noteInflightUp() {
    if (inflightBusySince === undefined) {
        inflightBusySince = Date.now();
    }
}
function noteInflightDown() {
    if (globalInflightCount === 0) {
        inflightBusySince = undefined;
        watchdogFiredForBusySince = undefined;
    }
}
function getState(scope) {
    let s = healthStates.get(scope);
    if (!s) {
        s = { inflight: 0 };
        healthStates.set(scope, s);
    }
    return s;
}
function registerInflight(scope) {
    if (!INFLIGHT_LIMIT_DISABLED && globalInflightCount >= INFLIGHT_LIMIT) {
        throw new errors_js_1.ResourceExhaustedError(globalInflightCount, INFLIGHT_LIMIT);
    }
    globalInflightCount++;
    noteInflightUp();
    getState(scope).inflight++;
}
function unregisterInflight(scope) {
    globalInflightCount = Math.max(0, globalInflightCount - 1);
    noteInflightDown();
    const s = getState(scope);
    s.inflight = Math.max(0, s.inflight - 1);
    if (s.inflight === 0 && s.lastError === undefined && scope !== 'default') {
        healthStates.delete(scope);
    }
}
function enableWatchdog(thresholdMs = 60_000, hooks) {
    const prevThreshold = watchdogThresholdMs;
    watchdogThresholdMs = thresholdMs;
    if (hooks)
        watchdogHooks.add(hooks);
    if (watchdogTimer && thresholdMs === prevThreshold)
        return;
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = undefined;
    }
    const intervalMs = Math.max(50, Math.floor(thresholdMs / 4));
    watchdogTimer = setInterval(() => {
        if (globalInflightCount === 0)
            return;
        if (inflightBusySince === undefined)
            return;
        const elapsed = Date.now() - inflightBusySince;
        if (elapsed < watchdogThresholdMs)
            return;
        if (watchdogFiredForBusySince === inflightBusySince)
            return;
        watchdogFiredForBusySince = inflightBusySince;
        const event = {
            type: 'watchdog',
            key: '<unknown>',
            traceId: '<watchdog>',
            timestamp: Date.now(),
            elapsedMs: elapsed,
            scope: '<process>',
        };
        for (const h of watchdogHooks) {
            (0, safeCall_js_1.safeCall)(h.onWatchdog, event);
        }
    }, intervalMs);
    const t = watchdogTimer;
    if (typeof t.unref === 'function')
        t.unref();
}
function registerWatchdogHooks(hooks) {
    watchdogHooks.add(hooks);
}
function unregisterWatchdogHooks(hooks) {
    watchdogHooks.delete(hooks);
}
function disableWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = undefined;
    }
    watchdogHooks.clear();
}
function recordError(scope, code, message) {
    const s = getState(scope);
    s.lastError = { code, message, timestamp: Date.now() };
}
function recordSuccess(scope) {
    getState(scope).lastSuccessAt = Date.now();
}
function createHealthCheck(store, options) {
    const scope = options?.scope ?? resolveStoreScope(store) ?? 'default';
    const probeIntervalMs = options?.probeIntervalMs;
    let probeTimer;
    if (probeIntervalMs && probeIntervalMs > 0) {
        probeTimer = setInterval(() => {
            const s = healthStates.get(scope);
            if (s && s.inflight > 0) {
                console.warn(`Actly: health probe detected ${s.inflight} in-flight calls in scope "${scope}" ` +
                    `at ${new Date().toISOString()}. If this persists, a fn may be hung.`);
            }
        }, probeIntervalMs);
        const t = probeTimer;
        if (typeof t.unref === 'function')
            t.unref();
    }
    const checkFn = () => {
        const s = healthStates.get(scope);
        return {
            storeSize: store.size(),
            pendingInflight: s?.inflight ?? 0,
            uptimeMs: Date.now() - startTime,
            lastError: s?.lastError,
            lastSuccessAt: s?.lastSuccessAt,
        };
    };
    checkFn.dispose = () => {
        if (probeTimer !== undefined) {
            clearInterval(probeTimer);
            probeTimer = undefined;
        }
    };
    return checkFn;
}
