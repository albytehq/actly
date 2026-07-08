import { execute } from './executor.js';
import { retryPolicy } from '../policies/retry.js';
import { timeoutPolicy, totalTimeoutPolicy } from '../policies/timeout.js';
import { dedupePolicy } from '../policies/dedupe.js';
import { cachePolicy } from '../policies/cache.js';
import { circuitBreakerPolicy } from '../policies/circuitBreaker.js';
import { bulkheadPolicy } from '../policies/bulkhead.js';
import { rateLimitPolicy } from '../policies/rateLimit.js';
import { createDefaultStore } from '../stores/memory.js';
import { isSyncStore } from '../stores/base.js';
import { linkSignal, raceAbort } from '../utils/abort.js';
import { sanitizeError, sanitizeErrorMessage } from '../utils/sanitize.js';
import { safeCall } from '../utils/safeCall.js';
import { registerInflight, unregisterInflight, recordError, recordSuccess, registerStoreScope } from './health.js';
import { registerDrainable, unregisterDrainable } from './shutdown.js';
import { assertKey, assertOptions, } from '../utils/validate.js';
import { HedgeTimeoutError } from '../errors.js';
const defaultStore = createDefaultStore();
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
        policies.push(rateLimitPolicy(options.rateLimit));
    }
    if (options.circuitBreaker) {
        policies.push(circuitBreakerPolicy(options.circuitBreaker));
    }
    if (options.totalTimeout && options.totalTimeout.ms > 0) {
        policies.push(totalTimeoutPolicy(options.totalTimeout));
    }
    if (options.cache && options.cache.ttl > 0) {
        policies.push(cachePolicy(options.cache));
    }
    if (options.bulkhead) {
        policies.push(bulkheadPolicy(options.bulkhead));
    }
    if (dedupe) {
        policies.push(dedupePolicy(dedupe));
    }
    if (options.retry && options.retry.attempts > 1) {
        policies.push(retryPolicy(options.retry));
    }
    if (options.timeout && options.timeout.ms > 0) {
        policies.push(timeoutPolicy(options.timeout));
    }
    return policies;
}
function buildRootSignal(userSignal) {
    const controller = new AbortController();
    if (userSignal) {
        const unlink = linkSignal(userSignal, controller);
        return { controller, cleanup: unlink };
    }
    return { controller, cleanup: () => { } };
}
export async function act(key, fn, options = {}) {
    assertKey(key);
    assertOptions(options);
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
            registerInflight('default');
        }
        catch (e) {
            const now = monotonicNow();
            const durationMs = now - startedAt;
            recordError('default', 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e));
            return { ok: false, error: e, attempts: 0, durationMs };
        }
        registerDrainable('default');
        try {
            const value = await fn(new AbortController().signal);
            recordSuccess('default');
            return { ok: true, value, source: 'fresh', attempts: 1, durationMs: monotonicNow() - startedAt };
        }
        catch (error) {
            recordError('default', 'fn-error', sanitizeErrorMessage(error));
            return { ok: false, error, attempts: 1, durationMs: monotonicNow() - startedAt };
        }
        finally {
            unregisterInflight('default');
            unregisterDrainable('default');
        }
    }
    const meta = { attempts: 1, source: 'fresh' };
    const { controller: rootController, cleanup } = buildRootSignal(options.signal);
    const observability = buildObservability(options.observability, options.traceId);
    const effectiveTraceId = observability?.traceId ?? options.traceId;
    const startedAt = monotonicNow();
    const scope = 'default';
    try {
        registerInflight(scope);
    }
    catch (e) {
        cleanup();
        const now = monotonicNow();
        const durationMs = now - startedAt;
        recordError(scope, 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e));
        if (observability) {
            safeCall(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: 0, durationMs,
                failedBy: 'resource-exhausted', error: e,
            });
        }
        if (options.audit) {
            safeCall(options.audit.log, {
                key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
                ok: false, attempts: 0, failedBy: 'resource-exhausted',
                error: sanitizeError(e),
            });
        }
        return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    registerDrainable(scope);
    if (rootController.signal.aborted) {
        cleanup();
        unregisterInflight(scope);
        unregisterDrainable(scope);
        const error = rootController.signal.reason;
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        if (observability) {
            safeCall(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: now,
                attempts: 0, durationMs,
                failedBy: 'abort', error,
            });
        }
        if (options.audit) {
            const sanitizedError = sanitizeError(error);
            safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError });
        }
        recordError(scope, 'ACTLY_ABORT', sanitizeErrorMessage(error));
        return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    let policies;
    try {
        policies = buildPolicies(options);
    }
    catch (e) {
        cleanup();
        unregisterInflight(scope);
        unregisterDrainable(scope);
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        recordError(scope, 'ACTLY_VALIDATION', sanitizeErrorMessage(e));
        if (observability) {
            safeCall(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: now,
                attempts: 0, durationMs, failedBy: 'validation', error: e,
            });
        }
        if (options.audit) {
            safeCall(options.audit.log, {
                key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
                ok: false, attempts: 0, failedBy: 'validation',
                error: sanitizeError(e),
            });
        }
        return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
    }
    const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
    if (observability && !hasRetryPolicy) {
        safeCall(observability.hooks.onAttempt, {
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
            const chainFactory = (signal, m) => execute({
                key,
                fn: fnWithHedge,
                policies,
                store: defaultStore,
                meta: m,
                signal,
                observability,
            });
            const hedgeResult = needsRaceAbort
                ? await raceAbort(Promise.resolve(runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser)), rootController.signal)
                : await runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser);
            meta.attempts = hedgeResult.winnerMeta.attempts;
            meta.source = hedgeResult.winnerMeta.source;
            value = hedgeResult.value;
        }
        else {
            const execPromise = execute({
                key,
                fn: fnWithHedge,
                policies,
                store: defaultStore,
                meta,
                signal: rootController.signal,
                observability,
            });
            value = needsRaceAbort
                ? await raceAbort(Promise.resolve(execPromise), rootController.signal)
                : await execPromise;
        }
        const now = Date.now();
        const durationMs = monotonicNow() - startedAt;
        recordSuccess(scope);
        if (observability) {
            safeCall(observability.hooks.onFinalSuccess, {
                type: 'final-success',
                key, traceId: observability.traceId, timestamp: now,
                source: meta.source, attempts: meta.attempts, durationMs,
            });
        }
        if (options.audit) {
            safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts });
        }
        return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
    }
    catch (error) {
        const durationMs = monotonicNow() - startedAt;
        const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
        let errorRecorded = false;
        if (options.fallback) {
            recordError(scope, failedBy, sanitizeErrorMessage(error));
            errorRecorded = true;
            try {
                const fallbackValue = typeof options.fallback.value === 'function'
                    ? await options.fallback.value()
                    : options.fallback.value;
                if (observability) {
                    safeCall(observability.hooks.onFinalSuccess, {
                        type: 'final-success',
                        key, traceId: observability.traceId, timestamp: Date.now(),
                        source: meta.source, attempts: meta.attempts, durationMs,
                    });
                }
                if (options.audit) {
                    safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                }
                return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
            }
            catch (fallbackErr) {
                if (observability) {
                    safeCall(observability.hooks.onFinalFailure, {
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
        const sanitizedError = options.audit ? sanitizeError(error) : error;
        if (!errorRecorded) {
            recordError(scope, failedBy, sanitizeErrorMessage(error));
        }
        if (observability) {
            safeCall(observability.hooks.onFinalFailure, {
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: meta.attempts, durationMs,
                failedBy, error,
            });
        }
        if (options.audit) {
            safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
        }
        return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
    }
    finally {
        cleanup();
        unregisterInflight(scope);
        unregisterDrainable(scope);
    }
}
export { HedgeTimeoutError } from '../errors.js';
function wrapHedge(fn, delayMs, keepLoser) {
    return async (parentSignal) => {
        const primaryCtl = new AbortController();
        const hedgeCtl = new AbortController();
        const unlinkPrimary = linkSignal(parentSignal, primaryCtl);
        const unlinkHedge = linkSignal(parentSignal, hedgeCtl);
        let timer;
        let primary;
        let hedgePromise;
        try {
            primary = Promise.resolve(fn(primaryCtl.signal));
            const hedgeTimeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new HedgeTimeoutError()), delayMs);
            });
            try {
                return await Promise.race([primary, hedgeTimeout]);
            }
            catch (e) {
                if (!(e instanceof HedgeTimeoutError)) {
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
    const unlinkPrimary = linkSignal(parentSignal, primaryCtl);
    const unlinkHedge = linkSignal(parentSignal, hedgeCtl);
    let timer;
    try {
        const primary = Promise.resolve(chainFactory(primaryCtl.signal, primaryMeta));
        const hedgeTimeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new HedgeTimeoutError()), delayMs);
        });
        try {
            const value = await Promise.race([primary, hedgeTimeout]);
            return { value, winnerMeta: primaryMeta };
        }
        catch (e) {
            if (!(e instanceof HedgeTimeoutError)) {
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
export function invalidate(key) {
    assertKey(key);
    const cacheKey = CACHE_NS + key;
    const existed = defaultStore.has(cacheKey);
    defaultStore.delete(cacheKey);
    return existed;
}
export function withStore(store) {
    const crypto = globalThis.crypto;
    const scope = 'scoped:' + (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14));
    registerStoreScope(store, scope);
    const scopedAct = async (key, fn, options = {}) => {
        assertKey(key);
        assertOptions(options);
        const meta = { attempts: 1, source: 'fresh' };
        const { controller: rootController, cleanup } = buildRootSignal(options.signal);
        const observability = buildObservability(options.observability, options.traceId);
        const effectiveTraceId = observability?.traceId ?? options.traceId;
        const startedAt = monotonicNow();
        try {
            registerInflight(scope);
        }
        catch (e) {
            cleanup();
            const now = monotonicNow();
            const durationMs = now - startedAt;
            recordError(scope, 'ACTLY_RESOURCE_EXHAUSTED', sanitizeErrorMessage(e));
            if (observability) {
                safeCall(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
                    attempts: 0, durationMs, failedBy: 'resource-exhausted', error: e,
                });
            }
            if (options.audit) {
                safeCall(options.audit.log, {
                    key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs,
                    ok: false, attempts: 0, failedBy: 'resource-exhausted',
                    error: sanitizeError(e),
                });
            }
            return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        registerDrainable(scope);
        if (rootController.signal.aborted) {
            cleanup();
            unregisterInflight(scope);
            unregisterDrainable(scope);
            const error = rootController.signal.reason;
            const now = Date.now();
            const durationMs = now - startedAt;
            recordError(scope, 'ACTLY_ABORT', sanitizeErrorMessage(error));
            if (observability) {
                safeCall(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: 0, durationMs, failedBy: 'abort', error,
                });
            }
            if (options.audit) {
                const sanitizedError = sanitizeError(error);
                safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: false, attempts: 0, failedBy: 'abort', error: sanitizedError });
            }
            return { ok: false, error, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        let policies;
        try {
            policies = buildPolicies(options);
        }
        catch (e) {
            cleanup();
            unregisterInflight(scope);
            unregisterDrainable(scope);
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            recordError(scope, 'ACTLY_VALIDATION', sanitizeErrorMessage(e));
            if (observability) {
                safeCall(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: 0, durationMs, failedBy: 'validation', error: e,
                });
            }
            if (options.audit) {
                safeCall(options.audit.log, {
                    key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs,
                    ok: false, attempts: 0, failedBy: 'validation',
                    error: sanitizeError(e),
                });
            }
            return { ok: false, error: e, attempts: 0, traceId: effectiveTraceId, durationMs };
        }
        const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
        if (observability && !hasRetryPolicy) {
            safeCall(observability.hooks.onAttempt, {
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
                const chainFactory = (signal, m) => execute({
                    key,
                    fn: fnWithHedge,
                    policies,
                    store,
                    meta: m,
                    signal,
                    observability,
                });
                const hedgeResult = needsRaceAbort
                    ? await raceAbort(Promise.resolve(runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser)), rootController.signal)
                    : await runWithHedge(chainFactory, meta, hedgeMeta, rootController.signal, options.hedge.delayMs, hedgeKeepLoser);
                meta.attempts = hedgeResult.winnerMeta.attempts;
                meta.source = hedgeResult.winnerMeta.source;
                value = hedgeResult.value;
            }
            else {
                const execPromise = execute({
                    key,
                    fn: fnWithHedge,
                    policies,
                    store,
                    meta,
                    signal: rootController.signal,
                    observability,
                });
                value = needsRaceAbort
                    ? await raceAbort(Promise.resolve(execPromise), rootController.signal)
                    : await execPromise;
            }
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            recordSuccess(scope);
            if (observability) {
                safeCall(observability.hooks.onFinalSuccess, {
                    type: 'final-success', key, traceId: observability.traceId, timestamp: now,
                    source: meta.source, attempts: meta.attempts, durationMs,
                });
            }
            if (options.audit) {
                safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: now, durationMs, ok: true, attempts: meta.attempts });
            }
            return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
        }
        catch (error) {
            const now = Date.now();
            const durationMs = monotonicNow() - startedAt;
            const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
            let errorRecorded = false;
            if (options.fallback) {
                recordError(scope, failedBy, sanitizeErrorMessage(error));
                errorRecorded = true;
                try {
                    const fallbackValue = typeof options.fallback.value === 'function'
                        ? await options.fallback.value()
                        : options.fallback.value;
                    if (observability) {
                        safeCall(observability.hooks.onFinalSuccess, {
                            type: 'final-success', key, traceId: observability.traceId, timestamp: Date.now(),
                            source: meta.source, attempts: meta.attempts, durationMs,
                        });
                    }
                    if (options.audit) {
                        safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                    }
                    return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
                }
                catch (fallbackErr) {
                    if (observability) {
                        safeCall(observability.hooks.onFinalFailure, {
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
                recordError(scope, failedBy, sanitizeErrorMessage(error));
            }
            if (observability) {
                safeCall(observability.hooks.onFinalFailure, {
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: now,
                    attempts: meta.attempts, durationMs, failedBy, error,
                });
            }
            if (options.audit) {
                const sanitizedError = sanitizeError(error);
                safeCall(options.audit.log, { key, traceId: effectiveTraceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
            }
            return { ok: false, error, attempts: meta.attempts, traceId: effectiveTraceId, durationMs };
        }
        finally {
            cleanup();
            unregisterInflight(scope);
            unregisterDrainable(scope);
        }
    };
    const invalidateImpl = (key) => {
        assertKey(key);
        const cacheKey = CACHE_NS + key;
        if (isSyncStore(store)) {
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
