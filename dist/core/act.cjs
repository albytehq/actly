"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const health_js_1 = require("./health.js");
const shutdown_js_1 = require("./shutdown.js");
const validate_js_1 = require("../utils/validate.js");
// Module-level default store so cache and dedupe persist across calls.
// Bounded by default (maxSize: 10_000, autoCleanup: 60s) to
// prevent unbounded memory growth in long-running servers. Callers who
// want truly unbounded storage must construct their own `InMemoryStore`
// with `maxSize: Infinity` and pass it via `withStore()`.
const defaultStore = (0, memory_js_1.createDefaultStore)();
// Namespace prefixes used by policies. Kept here (not in policy files) so
// `invalidate()` can resolve cache keys without importing policy internals.
const CACHE_NS = 'cache:';
/**
 * Generate a trace ID for correlation across logs/metrics.
 *
 * Uses `crypto.randomUUID()` on Node 20+ (fast, native). Falls back to a
 * timestamp+random string for environments without it.
 */
function generateTraceId() {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `actly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/**
 * Build the observability context (or return undefined if no hooks).
 * The context is shared via PolicyContext.observability so every policy
 * can emit events through the same traceId + hooks.
 */
function buildObservability(hooks, traceId) {
    // Contract: if no hooks are supplied, return undefined.
    // Policies check `ctx.observability != null` before allocating events.
    if (!hooks)
        return undefined;
    // Check that at least one hook is actually defined (avoid allocating
    // context for an empty hooks object).
    const hasAnyHook = !!hooks.onAttempt ||
        !!hooks.onRetry ||
        !!hooks.onCacheHit ||
        !!hooks.onCacheMiss ||
        !!hooks.onDedupeJoin ||
        !!hooks.onTimeout ||
        !!hooks.onFinalSuccess ||
        !!hooks.onFinalFailure;
    if (!hasAnyHook)
        return undefined;
    return {
        traceId: traceId ?? generateTraceId(),
        hooks,
        joinerCounter: 0,
    };
}
/**
 * Determine the `failedBy` discriminator from a caught error.
 * Name sniffing requires `instanceof Error` to prevent plain-object spoofing.
 */
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
    // Fall back to name sniffing for non-actly errors (e.g. DOMException abort).
    // Require instanceof Error to prevent plain-object spoofing.
    if (error instanceof Error) {
        const name = error.name;
        if (name === 'AbortError')
            return 'abort';
    }
    return 'fn-error';
}
/**
 * Normalise `dedupe: true` shorthand to `DedupeOptions`.
 * Returns `undefined` if dedupe is disabled or absent.
 */
function normalizeDedupe(opt) {
    if (opt === true)
        return { enabled: true };
    if (opt && typeof opt === 'object' && opt.enabled) {
        return {
            enabled: true,
            ...(opt.inflightTtl !== undefined ? { inflightTtl: opt.inflightTtl } : {}),
        };
    }
    return undefined;
}
/**
 * Build the policy chain from `ActOptions`. The order is fixed and
 * documented in `executor.ts`. Policies with no effect (e.g. `retry.attempts: 1`)
 * are skipped — they would be pure overhead.
 */
function buildPolicies(options) {
    const dedupe = normalizeDedupe(options.dedupe);
    const policies = [];
    // Outermost: rate limiter (blocks before any work is done)
    if (options.rateLimit) {
        policies.push((0, rateLimit_js_1.rateLimitPolicy)(options.rateLimit));
    }
    // Circuit breaker (blocks if downstream is failing)
    if (options.circuitBreaker) {
        policies.push((0, circuitBreaker_js_1.circuitBreakerPolicy)(options.circuitBreaker));
    }
    // Hard wall-clock budget over the entire operation
    if (options.totalTimeout && options.totalTimeout.ms > 0) {
        policies.push((0, timeout_js_1.totalTimeoutPolicy)(options.totalTimeout));
    }
    // Cache: a hit short-circuits everything below it
    if (options.cache && options.cache.ttl > 0) {
        policies.push((0, cache_js_1.cachePolicy)(options.cache));
    }
    // Bulkhead: limits concurrency per key
    if (options.bulkhead) {
        policies.push((0, bulkhead_js_1.bulkheadPolicy)(options.bulkhead));
    }
    // Dedupe: collapses concurrent callers before retry fires
    if (dedupe) {
        policies.push((0, dedupe_js_1.dedupePolicy)(dedupe));
    }
    // Retry: owns the attempt loop (attempts: 1 is a no-op — skip)
    if (options.retry && options.retry.attempts > 1) {
        policies.push((0, retry_js_1.retryPolicy)(options.retry));
    }
    // Innermost: per-attempt clock. Resets on every retry
    if (options.timeout && options.timeout.ms > 0) {
        policies.push((0, timeout_js_1.timeoutPolicy)(options.timeout));
    }
    return policies;
}
/**
 * Build a root AbortController from `options.signal`.
 *
 * - If no user signal: returns a fresh controller that never aborts unless
 *   an outer timeout policy aborts it.
 * - If user signal is already aborted: returns a controller that is already
 *   aborted with the user's reason (so the operation rejects immediately).
 * - Otherwise: links the user signal to the controller.
 */
function buildRootSignal(userSignal) {
    const controller = new AbortController();
    if (userSignal) {
        const unlink = (0, abort_js_1.linkSignal)(userSignal, controller);
        return { controller, cleanup: unlink };
    }
    return { controller, cleanup: () => { } };
}
/**
 * Execute `fn` with the given reliability policies.
 *
 * @param key     Stable identifier for this action. Scopes dedupe + cache.
 * @param fn      The async work to run. Receives an `AbortSignal` for
 *                cooperative cancellation (legacy `() => Promise<T>` is
 *                still accepted — the signal is simply ignored).
 * @param options Which policies to apply and how. All fields are optional.
 *
 * @returns       `ActResult<T>` — always resolves, never throws.
 *                Check `result.ok` before reading `result.value`.
 *
 * @example
 * // With cooperative cancellation
 * const result = await act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, {
 *   retry:        { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout:      { ms: 5_000 },
 *   totalTimeout: { ms: 12_000 },
 *   dedupe:       true,
 *   cache:        { ttl: 60_000 },
 * })
 *
 * if (result.ok) {
 *   console.log(result.value, result.source, result.attempts)
 * } else {
 *   console.error(result.error)
 * }
 */
async function act(key, fn, options = {}) {
    (0, validate_js_1.assertKey)(key);
    (0, validate_js_1.assertOptions)(options);
    // Fast path: no options means no policies, no signal, no observability.
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
        const startedAt = Date.now();
        (0, health_js_1.registerInflight)('default');
        (0, shutdown_js_1.registerDrainable)('default');
        try {
            const value = await fn(new AbortController().signal);
            (0, health_js_1.recordSuccess)('default');
            return { ok: true, value, source: 'fresh', attempts: 1, durationMs: Date.now() - startedAt };
        }
        catch (error) {
            (0, health_js_1.recordError)('default', 'fn-error', (0, sanitize_js_1.sanitizeErrorMessage)(error));
            return { ok: false, error, attempts: 1, durationMs: Date.now() - startedAt };
        }
        finally {
            (0, health_js_1.unregisterInflight)('default');
            (0, shutdown_js_1.unregisterDrainable)('default');
        }
    }
    const meta = { attempts: 1, source: 'fresh' };
    const { controller: rootController, cleanup } = buildRootSignal(options.signal);
    const observability = buildObservability(options.observability, options.traceId);
    const startedAt = Date.now();
    const scope = 'default';
    (0, health_js_1.registerInflight)(scope);
    (0, shutdown_js_1.registerDrainable)(scope);
    if (rootController.signal.aborted) {
        cleanup();
        (0, health_js_1.unregisterInflight)(scope);
        (0, shutdown_js_1.unregisterDrainable)(scope);
        const error = rootController.signal.reason;
        if (observability) {
            observability.hooks.onFinalFailure?.({
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: 0, durationMs: Date.now() - startedAt,
                failedBy: 'abort', error,
            });
        }
        if (options.audit) {
            options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs: Date.now() - startedAt, ok: false, attempts: 0, failedBy: 'abort', error });
        }
        (0, health_js_1.recordError)(scope, 'ACTLY_ABORT', (0, sanitize_js_1.sanitizeErrorMessage)(error));
        return { ok: false, error, attempts: 0, traceId: observability?.traceId, durationMs: Date.now() - startedAt };
    }
    const policies = buildPolicies(options);
    const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
    if (observability && !hasRetryPolicy) {
        observability.hooks.onAttempt?.({
            type: 'attempt', key, traceId: observability.traceId,
            timestamp: Date.now(), attempt: 1,
        });
    }
    // Wrap fn with hedge request if configured
    const fnWithHedge = options.hedge ? wrapHedge(fn, options.hedge.delayMs) : fn;
    try {
        const value = await (0, abort_js_1.raceAbort)((0, executor_js_1.execute)({
            key,
            fn: fnWithHedge,
            policies,
            store: defaultStore,
            meta,
            signal: rootController.signal,
            observability,
        }), rootController.signal);
        const durationMs = Date.now() - startedAt;
        (0, health_js_1.recordSuccess)(scope);
        if (observability) {
            observability.hooks.onFinalSuccess?.({
                type: 'final-success',
                key, traceId: observability.traceId, timestamp: Date.now(),
                source: meta.source, attempts: meta.attempts, durationMs,
            });
        }
        if (options.audit) {
            options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
        }
        return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: observability?.traceId, durationMs };
    }
    catch (error) {
        const durationMs = Date.now() - startedAt;
        const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
        // Fallback: if configured, return fallback value instead of failure.
        // Record the error in health check so monitoring can detect downstream
        // failures even when fallback masks them from the caller.
        let errorRecorded = false;
        if (options.fallback) {
            (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
            errorRecorded = true;
            try {
                const fallbackValue = typeof options.fallback.value === 'function'
                    ? await options.fallback.value()
                    : options.fallback.value;
                if (observability) {
                    observability.hooks.onFinalSuccess?.({
                        type: 'final-success',
                        key, traceId: observability.traceId, timestamp: Date.now(),
                        source: meta.source, attempts: meta.attempts, durationMs,
                    });
                }
                if (options.audit) {
                    options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                }
                return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: observability?.traceId, durationMs };
            }
            catch {
                // fallback itself failed — fall through to normal failure
            }
        }
        const sanitizedError = options.audit ? (0, sanitize_js_1.sanitizeError)(error) : error;
        if (!errorRecorded) {
            (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
        }
        if (observability) {
            observability.hooks.onFinalFailure?.({
                type: 'final-failure',
                key, traceId: observability.traceId, timestamp: Date.now(),
                attempts: meta.attempts, durationMs,
                failedBy, error,
            });
        }
        if (options.audit) {
            options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
        }
        return { ok: false, error, attempts: meta.attempts, traceId: observability?.traceId, durationMs };
    }
    finally {
        cleanup();
        (0, health_js_1.unregisterInflight)(scope);
        (0, shutdown_js_1.unregisterDrainable)(scope);
    }
}
// Hedge request: sends a second call after delayMs, races them.
// Clears timer on settle to prevent leak. Marks primary as handled
// to prevent unhandled rejection if hedge wins.
function wrapHedge(fn, delayMs) {
    return async (signal) => {
        let timer;
        const primary = fn(signal);
        const hedgeTimeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('__HEDGE_TIMEOUT__')), delayMs);
        });
        try {
            return await Promise.race([primary, hedgeTimeout]);
        }
        catch (e) {
            if (e instanceof Error && e.message === '__HEDGE_TIMEOUT__') {
                // Primary is still running — mark as handled to prevent unhandled rejection
                Promise.resolve(primary).catch(() => { });
                const hedgePromise = Promise.resolve(fn(signal));
                hedgePromise.catch(() => { }); // mark hedge as handled if primary wins
                return await Promise.race([primary, hedgePromise]);
            }
            throw e;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };
}
/**
 * Invalidate the cached value for `key` on the default module-level store.
 *
 * Only clears the cache slot — does not affect in-flight dedupe entries
 * (those will settle on their own). Returns `true` if a cache entry was
 * removed, `false` otherwise.
 *
 * Useful when you know the underlying data has changed and you want the
 * next `act()` call to re-run `fn` instead of serving stale cache:
 *
 * ```ts
 * await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 * // ... user updates their profile ...
 * invalidate('user:42')  // next call will re-fetch
 * ```
 */
function invalidate(key) {
    (0, validate_js_1.assertKey)(key);
    const cacheKey = CACHE_NS + key;
    const existed = defaultStore.has(cacheKey);
    defaultStore.delete(cacheKey);
    return existed;
}
function withStore(store) {
    const scope = 'scoped:' + Math.random().toString(36).slice(2, 8);
    const scopedAct = async (key, fn, options = {}) => {
        (0, validate_js_1.assertKey)(key);
        (0, validate_js_1.assertOptions)(options);
        const meta = { attempts: 1, source: 'fresh' };
        const { controller: rootController, cleanup } = buildRootSignal(options.signal);
        const observability = buildObservability(options.observability, options.traceId);
        const startedAt = Date.now();
        (0, health_js_1.registerInflight)(scope);
        (0, shutdown_js_1.registerDrainable)(scope);
        if (rootController.signal.aborted) {
            cleanup();
            (0, health_js_1.unregisterInflight)(scope);
            (0, shutdown_js_1.unregisterDrainable)(scope);
            const error = rootController.signal.reason;
            if (observability) {
                observability.hooks.onFinalFailure?.({
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
                    attempts: 0, durationMs: Date.now() - startedAt, failedBy: 'abort', error,
                });
            }
            return { ok: false, error, attempts: 0, traceId: observability?.traceId, durationMs: Date.now() - startedAt };
        }
        const policies = buildPolicies(options);
        const hasRetryPolicy = !!(options.retry && options.retry.attempts > 1);
        if (observability && !hasRetryPolicy) {
            observability.hooks.onAttempt?.({
                type: 'attempt', key, traceId: observability.traceId,
                timestamp: Date.now(), attempt: 1,
            });
        }
        const fnWithHedge = options.hedge ? wrapHedge(fn, options.hedge.delayMs) : fn;
        try {
            const value = await (0, abort_js_1.raceAbort)((0, executor_js_1.execute)({
                key,
                fn: fnWithHedge,
                policies,
                store,
                meta,
                signal: rootController.signal,
                observability,
            }), rootController.signal);
            const durationMs = Date.now() - startedAt;
            (0, health_js_1.recordSuccess)(scope);
            if (observability) {
                observability.hooks.onFinalSuccess?.({
                    type: 'final-success', key, traceId: observability.traceId, timestamp: Date.now(),
                    source: meta.source, attempts: meta.attempts, durationMs,
                });
            }
            if (options.audit) {
                options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
            }
            return { ok: true, value, source: meta.source, attempts: meta.attempts, traceId: observability?.traceId, durationMs };
        }
        catch (error) {
            const durationMs = Date.now() - startedAt;
            const failedBy = rootController.signal.aborted ? 'abort' : classifyFailure(error);
            let errorRecorded = false;
            if (options.fallback) {
                (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
                errorRecorded = true;
                try {
                    const fallbackValue = typeof options.fallback.value === 'function'
                        ? await options.fallback.value()
                        : options.fallback.value;
                    if (options.audit) {
                        options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: true, attempts: meta.attempts });
                    }
                    return { ok: true, value: fallbackValue, source: 'fresh', attempts: meta.attempts, traceId: observability?.traceId, durationMs };
                }
                catch {
                    // fallback failed — fall through
                }
            }
            if (!errorRecorded) {
                (0, health_js_1.recordError)(scope, failedBy, (0, sanitize_js_1.sanitizeErrorMessage)(error));
            }
            if (observability) {
                observability.hooks.onFinalFailure?.({
                    type: 'final-failure', key, traceId: observability.traceId, timestamp: Date.now(),
                    attempts: meta.attempts, durationMs, failedBy, error,
                });
            }
            if (options.audit) {
                const sanitizedError = (0, sanitize_js_1.sanitizeError)(error);
                options.audit.log({ key, traceId: observability?.traceId ?? '', timestamp: Date.now(), durationMs, ok: false, attempts: meta.attempts, failedBy, error: sanitizedError });
            }
            return { ok: false, error, attempts: meta.attempts, traceId: observability?.traceId, durationMs };
        }
        finally {
            cleanup();
            (0, health_js_1.unregisterInflight)(scope);
            (0, shutdown_js_1.unregisterDrainable)(scope);
        }
    };
    // Build the `invalidate` implementation. The runtime branch on
    // `isSyncStore` selects the correct path; the cast through `unknown`
    // is required because TypeScript cannot narrow the union return type
    // (`boolean | Promise<boolean>`) to match either overload signature
    // individually. The overloads at the call site guarantee callers see
    // the correct type.
    //
    // FIX: The old async path did has() then delete() in separate awaits —
    // a TOCTOU race. Sync stores are safe (single synchronous frame).
    // Async stores document this as a known limitation.
    const invalidateImpl = (key) => {
        (0, validate_js_1.assertKey)(key);
        const cacheKey = CACHE_NS + key;
        if ((0, base_js_1.isSyncStore)(store)) {
            // Sync store: has() + delete() in the same synchronous frame is safe in single-frame.
            const existed = store.has(cacheKey);
            store.delete(cacheKey);
            return existed;
        }
        // Async store: safe in single-frame delete. We check has() first, then delete.
        // Between the two awaits, another caller could delete — but the return
        // value is "did this key exist at the time we checked", which is the
        // best we can do without a store-level delete-and-return-existed API.
        // For true safe in single-frame semantics, async stores should implement a
        // `deleteIfExists()` method — documented as a future API enhancement.
        return (async () => {
            const existed = await store.has(cacheKey);
            await store.delete(cacheKey);
            return existed;
        })();
    };
    // Attach `invalidate` and `store` to the function object. We use
    // `Object.assign` rather than mutation so the types narrow cleanly at
    // the call site. The cast through `unknown` is necessary because the
    // implementation signature is wider than either overload.
    return Object.assign(scopedAct, {
        invalidate: invalidateImpl,
        store,
    });
}
