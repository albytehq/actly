"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HedgeTimeoutError = void 0;
exports.act = act;
exports.invalidate = invalidate;
exports.withStore = withStore;
const executor_js_1 = require("./executor.js");
const retry_js_1 = require("../policies/retry.js");
const timeout_js_1 = require("../policies/timeout.js");
const dedupe_js_1 = require("../policies/dedupe.js");
const cache_js_1 = require("../policies/cache.js");
const circuitBreaker_js_1 = require("../policies/circuitBreaker.js");
const bulkhead_js_1 = require("../policies/bulkhead.js");
const rateLimit_js_1 = require("../policies/rateLimit.js");
const memory_js_1 = require("../stores/memory.js");
const base_js_1 = require("../stores/base.js");
const abort_js_1 = require("../utils/abort.js");
const sanitize_js_1 = require("../utils/sanitize.js");
const safeCall_js_1 = require("../utils/safeCall.js");
const health_js_1 = require("./health.js");
const shutdown_js_1 = require("./shutdown.js");
const validate_js_1 = require("../utils/validate.js");
const errors_js_1 = require("../errors.js");
const defaultStore = (0, memory_js_1.createDefaultStore)();
const CACHE_NS = 'cache:';
function monotonicNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}
function generateTraceId() {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `actly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function buildObservability(hooks, traceId) {
    if (!hooks)
        return undefined;
    const hasAnyHook = !!hooks.onAttempt ||
        !!hooks.onRetry ||
        !!hooks.onCacheHit ||
        !!hooks.onCacheMiss ||
        !!hooks.onDedupeJoin ||
        !!hooks.onTimeout ||
        !!hooks.onFinalSuccess ||
        !!hooks.onFinalFailure ||
        !!hooks.onBackpressure ||
        !!hooks.onWatchdog;
    if (!hasAnyHook)
        return undefined;
    return {
        traceId: traceId ?? generateTraceId(),
        hooks,
        joinerCounter: 0,
    };
}
function classifyFailure(error) {
    if (error == null || typeof error !== 'object')
        return 'fn-error';
    const code = error.code;
    if (code === 'ACTLY_ABORT')
        return 'abort';
    if (code === 'ACTLY_TIMEOUT')
        return 'timeout';
    if (code === 'ACTLY_TOTAL_TIMEOUT')
        return 'total-timeout';
    if (code === 'ACTLY_RETRY_EXHAUSTED')
        return 'retry-exhausted';
    if (code === 'ACTLY_VALIDATION')
        return 'validation';
    if (code === 'ACTLY_CIRCUIT_OPEN')
        return 'circuit-open';
    if (code === 'ACTLY_BULKHEAD_FULL')
        return 'bulkhead-full';
    if (code === 'ACTLY_RATE_LIMIT')
        return 'rate-limited';
    if (code === 'ACTLY_RESOURCE_EXHAUSTED')
        return 'resource-exhausted';
    if (code === 'ACTLY_HEDGE_TIMEOUT')
        return 'hedge-timeout';
    if (error instanceof Error) {
        const name = error.name;
        if (name === 'AbortError')
            return 'abort';
    }
    return 'fn-error';
}
function normalizeDedupe(opt) {
    if (opt === true)
        return { enabled: true };
    if (opt && typeof opt === 'object' && opt.enabled) {
        if (opt.inflightTtl !== undefined && opt.inflightTtl !== 0 && !Number.isNaN(opt.inflightTtl)) {
            return { enabled: true, inflightTtl: opt.inflightTtl };
        }
        return { enabled: true };
    }
    return undefined;
}
function buildPolicies(options) {
    const dedupe = normalizeDedupe(options.dedupe);
    const policies = [];
    if (options.rateLimit) {
        policies.push((0, rateLimit_js_1.rateLimitPolicy)(options.rateLimit));
    }
    if (options.circuitBreaker) {
        policies.push((0, circuitBreaker_js_1.circuitBreakerPolicy)(options.circuitBreaker));
    }
    if (options.totalTimeout && options.totalTimeout.ms > 0) {
        policies.push((0, timeout_js_1.totalTimeoutPolicy)(options.totalTimeout));
    }
    if (options.cache && options.cache.ttl > 0) {
        policies.push((0, cache_js_1.cachePolicy)(options.cache));
    }
    if (options.bulkhead) {
        policies.push((0, bulkhead_js_1.bulkheadPolicy)(options.bulkhead));
    }
    if (dedupe) {
        policies.push((0, dedupe_js_1.dedupePolicy)(dedupe));
    }
    if (options.retry && options.retry.attempts > 1) {
        policies.push((0, retry_js_1.retryPolicy)(options.retry));
    }
    if (options.timeout && options.timeout.ms > 0) {
        policies.push((0, timeout_js_1.timeoutPolicy)(options.timeout));
    }
    return policies;
}
function buildRootSignal(userSignal) {
    const controller = new AbortController();
    if (userSignal) {
        const unlink = (0, abort_js_1.linkSignal)(userSignal, controller);
        return { controller, cleanup: unlink };
    }
    return { controller, cleanup: () => { } };
}
async function act(key, fn, options = {}) {
    (0, validate_js_1.assertKey)(key);
    (0, validate_js_1.assertOptions)(options);
    const hasAnyOption = options.retry !== undefined ||
        options.timeout !== undefined ||
        options.totalTimeout !== undefined ||
        options.dedupe !== undefined ||
        options.cache !== undefined ||
        options.signal !== undefined ||
        options.observability !== undefined ||
        options.traceId !== undefined ||
        options.circuitBreaker !== undefined ||
        options.bulkhead !== undefined ||
        options.rateLimit !== undefined ||
        options.hedge !== undefined ||
        options.fallback !== undefined ||
        options.audit !== undefined;
    if (!hasAnyOption) {
        const startedAt = monotonicNow();
        try {
            (0, health_js_1.registerInflight)('default');
        }
        catch (e) {
            const now = monotonicNow();
            const durationMs = now - startedAt;
            (0, health_js_1.recordError)('default', 'ACTLY_RESOURCE_EXHAUSTED', (0, sanitize_js_1.sanitizeErrorMessage)(e));
            return { ok: false, error: e, attempts: 0, durationMs };
        }
        (0, shutdown_js_1.registerDrainable)('default');
        try {
            const value = await fn(new AbortController().signal);
            (0, health_js_1.recordSuccess)('default');
            return { ok: true, value, source: 'fresh', attempts: 1, durationMs: monotonicNow() - startedAt };
        }
        catch (error) {
            (0, health_js_1.recordError)('default', 'fn-error', (0, sanitize_js_1.sanitizeErrorMessage)(error));
            return { ok: false, error, attempts: 1, durationMs: monotonicNow() - startedAt };
        }
        finally {
            (0, health_js_1.unregisterInflight)('default');
            (0, shutdown_js_1.unregisterDrainable)('default');
        }
    }
    const meta = { attempts: 1, source: 'fresh' };
    const { controller: rootController, cleanup } = buildRootSignal(options.signal);
    const observability = buildObservability(options.observability, options.traceId);
    const effectiveTraceId = observability?.traceId ?? options.traceId;
    const startedAt = monotonicNow();
    const scope = 'default';
    try {
        (0, health_js_1.registerInflight)(scope);
    }
    catch (e) {
        cleanup();
        const now = monotonicNow();
        const durationMs = now - startedAt;
        (0, health_js_1.recordError)(scope, 'ACTLY_RESOURCE_EXHAUSTED', (0, sanitize_js_1.sanitizeErrorMessage)(e));
        if (observability) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: 0, durationMs,
                failedBy: 'resource-exhausted', error: e,
            });
        }
        if (options.audit) {
            (0, safeCall_js_1.safeCall)(options.audit.log, {
                key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
                ok: false, attempts: 0, failedBy: 'resource-exhausted',
                error: (0, sanitize_js_1.sanitizeError)(e),
            });
        }
        return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    (0, shutdown_js_1.registerDrainable)(scope);
    if (rootController.signal.aborted) {
        cleanup();
        (0, health_js_1.unregisterInflight)(scope);
        (0, shutdown_js_1.unregisterDrainable)(scope);
        const error = rootController.signal.reason;
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        if (observability) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: now,
                attempts: 0, durationMs,
                failedBy: 'abort', error,
            });
        }
        if (options.audit) {
            const sanitizedError = (0, sanitize_js_1.sanitizeError)(error);
            (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError });
        }
        (0, health_js_1.recordError)(scope, 'ACTLY_ABORT', (0, sanitize_js_1.sanitizeErrorMessage)(error));
        return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    let policies;
    try {
        policies = buildPolicies(options);
    }
    catch (e) {
        cleanup();
        (0, health_js_1.unregisterInflight)(scope);
        (0, shutdown_js_1.unregisterDrainable)(scope);
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        (0, health_js_1.recordError)(scope, 'ACTLY_VALIDATION', (0, sanitize_js_1.sanitizeErrorMessage)(e));
        if (observability) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: now,
                attempts: 0, durationMs, failedBy: 'validation', error: e,
            });
        }
        if (options.audit) {
            (0, safeCall_js_1.safeCall)(options.audit.log, {
                key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
                ok: false, attempts: 0, failedBy: 'validation',
                error: (0, sanitize_js_1.sanitizeError)(e),
            });
        }
        return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
    if (observability && !hasRetryPolicy) {
        (0, safeCall_js_1.safeCall)(observability.hooks.onAttempt, {
            type: 'attempt', key, traceId: observability.traceId,
            timestamp: Date.now(), attempt: 1,
        });
    }
    const hedgePlacement = options.hedge?.placement ?? 'outside-retry';
    const hedgeKeepLoser = options.hedge?.keepLoser ?? false;
    const fnWithHedge = (options.hedge && hedgePlacement === 'inside-retry')
        ? wrapHedge(fn, options.hedge.delayMs, hedgeKeepLoser)
        : fn;
    const needsRaceAbort = options.signal !== undefined;
    try {
        let value;
        if (options.hedge && hedgePlacement === 'outside-retry') {
            const hedgeMeta = { attempts: 1, source: 'fresh' };
            const chainFactory = (signal, m) => (0, executor_js_1.execute)({
                key,
                fn: fnWithHedge,
                policies,
                store: defaultStore,
                meta: m,
                signal,
                observability,
            });
            const hedgeResult = needsRaceAbort
                ? await (0, abort_js_1.raceAbort)(Promise.resolve(runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser)), rootController.signal)
                : await runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser);
            meta.attempts = hedgeResult.winnerMeta.attempts;
            meta.source = hedgeResult.winnerMeta.source;
            value = hedgeResult.value;
        }
        else {
            const execPromise = (0, executor_js_1.execute)({
                key,
                fn: fnWithHedge,
                policies,
                store: defaultStore,
                meta,
                signal: rootController.signal,
                observability,
            });
            value = needsRaceAbort
                ? await (0, abort_js_1.raceAbort)(Promise.resolve(execPromise), rootController.signal)
                : await execPromise;
        }
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        (0, health_js_1.recordSuccess)(scope);
        if (observability) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onFinalSuccess, {
                type: 'final-success',
                key, traceId: observability.traceId, timestamp: now,
                source: meta.source, attempts: meta.attempts, durationMs,
            });
        }
        if (options.audit) {
            (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts });
        }
        return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
    }
    catch (error) {
        const durationMs = monotonicNow() - startedAt;
        const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
        let errorRecorded = false;
        if (options.fallback) {
            (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
            errorRecorded = true;
            try {
                const fallbackValue = typeof options.fallback.value === 'function'
                    ? await options.fallback.value()
                    : options.fallback.value;
                if (observability) {
                    (0, safeCall_js_1.safeCall)(observability.hooks.onFinalSuccess, {
                        type: 'final-success',
                        key, traceId: observability.traceId, timestamp: Date.now(),
                        source: meta.source, attempts: meta.attempts, durationMs,
                    });
                }
                if (options.audit) {
                    (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                }
                return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
            }
            catch (fallbackErr) {
                if (observability) {
                    (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                        type: 'final-failure',
                        key, traceId: observability.traceId, timestamp: Date.now(),
                        attempts: meta.attempts, durationMs,
                        failedBy: 'fn-error', error: fallbackErr,
                    });
                }
                if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
                    console.warn('Actly: fallback threw — error swallowed, surfacing original fn error.', fallbackErr);
                }
            }
        }
        const sanitizedError = options.audit ? (0, sanitize_js_1.sanitizeError)(error) : error;
        if (!errorRecorded) {
            (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
        }
        if (observability) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: meta.attempts, durationMs,
                failedBy, error,
            });
        }
        if (options.audit) {
            (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
        }
        return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
    }
    finally {
        cleanup();
        (0, health_js_1.unregisterInflight)(scope);
        (0, shutdown_js_1.unregisterDrainable)(scope);
    }
}
var errors_js_2 = require("../errors.js");
Object.defineProperty(exports, "HedgeTimeoutError", { enumerable: true, get: function () { return errors_js_2.HedgeTimeoutError; } });
function wrapHedge(fn, delayMs, keepLoser) {
    return async (parentSignal) => {
        const primaryCtl = new AbortController();
        const hedgeCtl = new AbortController();
        const unlinkPrimary = (0, abort_js_1.linkSignal)(parentSignal, primaryCtl);
        const unlinkHedge = (0, abort_js_1.linkSignal)(parentSignal, hedgeCtl);
        let timer;
        let primary;
        let hedgePromise;
        try {
            primary = Promise.resolve(fn(primaryCtl.signal));
            const hedgeTimeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new errors_js_1.HedgeTimeoutError()), delayMs);
            });
            try {
                return await Promise.race([primary, hedgeTimeout]);
            }
            catch (e) {
                if (!(e instanceof errors_js_1.HedgeTimeoutError)) {
                    if (!keepLoser)
                        hedgeCtl.abort(new Error('hedge cancelled: primary rejected'));
                    throw e;
                }
                hedgePromise = Promise.resolve(fn(hedgeCtl.signal));
                primary.catch(() => { });
                hedgePromise.catch(() => { });
                try {
                    const primaryTagged = primary.then(v => ({ value: v, winner: 'primary' }));
                    const hedgeTagged = hedgePromise.then(v => ({ value: v, winner: 'hedge' }));
                    const winner = await Promise.race([primaryTagged, hedgeTagged]);
                    if (!keepLoser) {
                        if (winner.winner === 'primary') {
                            hedgeCtl.abort(new Error('hedge cancelled: loser'));
                        }
                        else {
                            primaryCtl.abort(new Error('hedge cancelled: loser'));
                        }
                    }
                    return winner.value;
                }
                catch (err) {
                    if (!keepLoser) {
                        primaryCtl.abort(new Error('hedge cancelled: loser rejected'));
                        hedgeCtl.abort(new Error('hedge cancelled: loser rejected'));
                    }
                    throw err;
                }
            }
        }
        finally {
            if (timer)
                clearTimeout(timer);
            unlinkPrimary();
            unlinkHedge();
        }
    };
}
async function runWithHedge(chainFactory, primaryMeta, hedgeMeta, parentSignal, delayMs, keepLoser) {
    const primaryCtl = new AbortController();
    const hedgeCtl = new AbortController();
    const unlinkPrimary = (0, abort_js_1.linkSignal)(parentSignal, primaryCtl);
    const unlinkHedge = (0, abort_js_1.linkSignal)(parentSignal, hedgeCtl);
    let timer;
    try {
        const primary = Promise.resolve(chainFactory(primaryCtl.signal, primaryMeta));
        const hedgeTimeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new errors_js_1.HedgeTimeoutError()), delayMs);
        });
        try {
            const value = await Promise.race([primary, hedgeTimeout]);
            return { value, winnerMeta: primaryMeta };
        }
        catch (e) {
            if (!(e instanceof errors_js_1.HedgeTimeoutError)) {
                if (!keepLoser)
                    hedgeCtl.abort(new Error('hedge cancelled: primary rejected'));
                throw e;
            }
            const hedge = Promise.resolve(chainFactory(hedgeCtl.signal, hedgeMeta));
            primary.catch(() => { });
            hedge.catch(() => { });
            const primaryTagged = primary.then(v => ({ value: v, winnerMeta: primaryMeta }));
            const hedgeTagged = hedge.then(v => ({ value: v, winnerMeta: hedgeMeta }));
            try {
                const winner = await Promise.race([primaryTagged, hedgeTagged]);
                if (!keepLoser) {
                    primaryCtl.abort(new Error('hedge cancelled: loser'));
                    hedgeCtl.abort(new Error('hedge cancelled: loser'));
                }
                return winner;
            }
            catch (err) {
                if (!keepLoser) {
                    primaryCtl.abort(new Error('hedge cancelled: loser rejected'));
                    hedgeCtl.abort(new Error('hedge cancelled: loser rejected'));
                }
                throw err;
            }
        }
    }
    finally {
        if (timer)
            clearTimeout(timer);
        unlinkPrimary();
        unlinkHedge();
    }
}
function invalidate(key) {
    (0, validate_js_1.assertKey)(key);
    const cacheKey = CACHE_NS + key;
    const existed = defaultStore.has(cacheKey);
    defaultStore.delete(cacheKey);
    return existed;
}
function withStore(store) {
    const crypto = globalThis.crypto;
    const scope = 'scoped:' + (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14));
    (0, health_js_1.registerStoreScope)(store, scope);
    const scopedAct = async (key, fn, options = {}) => {
        (0, validate_js_1.assertKey)(key);
        (0, validate_js_1.assertOptions)(options);
        const meta = { attempts: 1, source: 'fresh' };
        const { controller: rootController, cleanup } = buildRootSignal(options.signal);
        const observability = buildObservability(options.observability, options.traceId);
        const effectiveTraceId = observability?.traceId ?? options.traceId;
        const startedAt = monotonicNow();
        try {
            (0, health_js_1.registerInflight)(scope);
        }
        catch (e) {
            cleanup();
            const now = monotonicNow();
            const durationMs = now - startedAt;
            (0, health_js_1.recordError)(scope, 'ACTLY_RESOURCE_EXHAUSTED', (0, sanitize_js_1.sanitizeErrorMessage)(e));
            if (observability) {
                (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
                    attempts: 0, durationMs, failedBy: 'resource-exhausted', error: e,
                });
            }
            if (options.audit) {
                (0, safeCall_js_1.safeCall)(options.audit.log, {
                    key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
                    ok: false, attempts: 0, failedBy: 'resource-exhausted',
                    error: (0, sanitize_js_1.sanitizeError)(e),
                });
            }
            return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        (0, shutdown_js_1.registerDrainable)(scope);
        if (rootController.signal.aborted) {
            cleanup();
            (0, health_js_1.unregisterInflight)(scope);
            (0, shutdown_js_1.unregisterDrainable)(scope);
            const error = rootController.signal.reason;
            const now = Date.now();
            const durationMs = now - startedAt;
            (0, health_js_1.recordError)(scope, 'ACTLY_ABORT', (0, sanitize_js_1.sanitizeErrorMessage)(error));
            if (observability) {
                (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: 0, durationMs, failedBy: 'abort', error,
                });
            }
            if (options.audit) {
                const sanitizedError = (0, sanitize_js_1.sanitizeError)(error);
                (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError });
            }
            return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        let policies;
        try {
            policies = buildPolicies(options);
        }
        catch (e) {
            cleanup();
            (0, health_js_1.unregisterInflight)(scope);
            (0, shutdown_js_1.unregisterDrainable)(scope);
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            (0, health_js_1.recordError)(scope, 'ACTLY_VALIDATION', (0, sanitize_js_1.sanitizeErrorMessage)(e));
            if (observability) {
                (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: 0, durationMs, failedBy: 'validation', error: e,
                });
            }
            if (options.audit) {
                (0, safeCall_js_1.safeCall)(options.audit.log, {
                    key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
                    ok: false, attempts: 0, failedBy: 'validation',
                    error: (0, sanitize_js_1.sanitizeError)(e),
                });
            }
            return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
        if (observability && !hasRetryPolicy) {
            (0, safeCall_js_1.safeCall)(observability.hooks.onAttempt, {
                type: 'attempt', key, traceId: observability.traceId,
                timestamp: Date.now(), attempt: 1,
            });
        }
        const hedgePlacement = options.hedge?.placement ?? 'outside-retry';
        const hedgeKeepLoser = options.hedge?.keepLoser ?? false;
        const fnWithHedge = (options.hedge && hedgePlacement === 'inside-retry')
            ? wrapHedge(fn, options.hedge.delayMs, hedgeKeepLoser)
            : fn;
        const needsRaceAbort = options.signal !== undefined;
        try {
            let value;
            if (options.hedge && hedgePlacement === 'outside-retry') {
                const hedgeMeta = { attempts: 1, source: 'fresh' };
                const chainFactory = (signal, m) => (0, executor_js_1.execute)({
                    key,
                    fn: fnWithHedge,
                    policies,
                    store,
                    meta: m,
                    signal,
                    observability,
                });
                const hedgeResult = needsRaceAbort
                    ? await (0, abort_js_1.raceAbort)(Promise.resolve(runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser)), rootController.signal)
                    : await runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser);
                meta.attempts = hedgeResult.winnerMeta.attempts;
                meta.source = hedgeResult.winnerMeta.source;
                value = hedgeResult.value;
            }
            else {
                const execPromise = (0, executor_js_1.execute)({
                    key,
                    fn: fnWithHedge,
                    policies,
                    store,
                    meta,
                    signal: rootController.signal,
                    observability,
                });
                value = needsRaceAbort
                    ? await (0, abort_js_1.raceAbort)(Promise.resolve(execPromise), rootController.signal)
                    : await execPromise;
            }
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            (0, health_js_1.recordSuccess)(scope);
            if (observability) {
                (0, safeCall_js_1.safeCall)(observability.hooks.onFinalSuccess, {
                    type: 'final-success', key, traceId: observability.traceId, timestamp: now,
                    source: meta.source, attempts: meta.attempts, durationMs,
                });
            }
            if (options.audit) {
                (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts });
            }
            return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
        }
        catch (error) {
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
            let errorRecorded = false;
            if (options.fallback) {
                (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
                errorRecorded = true;
                try {
                    const fallbackValue = typeof options.fallback.value === 'function'
                        ? await options.fallback.value()
                        : options.fallback.value;
                    if (observability) {
                        (0, safeCall_js_1.safeCall)(observability.hooks.onFinalSuccess, {
                            type: 'final-success', key, traceId: observability.traceId, timestamp: Date.now(),
                            source: meta.source, attempts: meta.attempts, durationMs,
                        });
                    }
                    if (options.audit) {
                        (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                    }
                    return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
                }
                catch (fallbackErr) {
                    if (observability) {
                        (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                            type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
                            attempts: meta.attempts, durationMs, failedBy: 'fn-error', error: fallbackErr,
                        });
                    }
                    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
                        console.warn('Actly: fallback threw — error swallowed, surfacing original fn error.', fallbackErr);
                    }
                }
            }
            if (!errorRecorded) {
                (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
            }
            if (observability) {
                (0, safeCall_js_1.safeCall)(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: meta.attempts, durationMs, failedBy, error,
                });
            }
            if (options.audit) {
                const sanitizedError = (0, sanitize_js_1.sanitizeError)(error);
                (0, safeCall_js_1.safeCall)(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
            }
            return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
        }
        finally {
            cleanup();
            (0, health_js_1.unregisterInflight)(scope);
            (0, shutdown_js_1.unregisterDrainable)(scope);
        }
    };
    const invalidateImpl = (key) => {
        (0, validate_js_1.assertKey)(key);
        const cacheKey = CACHE_NS + key;
        if ((0, base_js_1.isSyncStore)(store)) {
            if (typeof store.deleteIfExists === 'function') {
                return store.deleteIfExists(cacheKey);
            }
            const existed = store.has(cacheKey);
            store.delete(cacheKey);
            return existed;
        }
        if (typeof store.deleteIfExists === 'function') {
            return store.deleteIfExists(cacheKey);
        }
        return (async () => {
            const existed = await store.has(cacheKey);
            await store.delete(cacheKey);
            return existed;
        })();
    };
    return Object.assign(scopedAct, {
        invalidate: invalidateImpl,
        store,
        scope,
    });
}
