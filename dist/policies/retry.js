import { computeDelay } from '../utils/backoff.js';
import { isAbortError, sleep } from '../utils/abort.js';
import { safeCall } from '../utils/safeCall.js';
import { RetryExhaustedError } from '../errors.js';
import { LIMITS } from '../utils/limits.js';
function defaultShouldRetry(error, _attempt) {
    if (isAbortError(error))
        return false;
    if (typeof error === 'object' && error !== null) {
        const code = error.code;
        if (code === 'ACTLY_TIMEOUT' || code === 'ACTLY_TOTAL_TIMEOUT')
            return false;
    }
    return true;
}
export function retryPolicy(opts) {
    const max = Math.max(1, Math.floor(opts.attempts));
    const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
    const shouldRetryResult = opts.shouldRetryResult;
    const dangerouslyUnref = opts.dangerouslyUnref === true;
    const sleepOpts = dangerouslyUnref ? { unref: true } : undefined;
    const backoffFn = opts.backoffFn;
    return (fn, ctx) => async (parentSignal) => {
        const backoffState = {};
        let errors;
        let retriedAtLeastOnce = false;
        const obs = ctx.observability;
        for (let attempt = 1; attempt <= max; attempt++) {
            if (parentSignal.aborted)
                throw parentSignal.reason;
            ctx.meta.attempts = attempt;
            const attemptStart = Date.now();
            try {
                if (obs) {
                    safeCall(obs.hooks.onAttempt, {
                        type: 'attempt', key: ctx.key, traceId: obs.traceId,
                        timestamp: attemptStart, attempt,
                    });
                }
                const value = await fn(parentSignal);
                if (shouldRetryResult) {
                    let accept;
                    try {
                        const raw = shouldRetryResult(value, attempt);
                        accept = typeof raw === 'boolean' ? raw : true;
                    }
                    catch {
                        return value;
                    }
                    if (accept)
                        return value;
                    const syntheticError = new Error(`Actly: shouldRetryResult returned false on attempt ${attempt}`);
                    if (errors === undefined)
                        errors = [];
                    if (errors.length < 10) {
                        errors.push(syntheticError);
                    }
                    else {
                        errors.shift();
                        errors.push(syntheticError);
                    }
                    if (attempt >= max) {
                        if (obs) {
                            safeCall(obs.hooks.onRetry, {
                                type: 'retry', key: ctx.key, traceId: obs.traceId,
                                timestamp: Date.now(), attempt, delayMs: 0,
                                error: syntheticError,
                            });
                        }
                        return value;
                    }
                    retriedAtLeastOnce = true;
                    if (parentSignal.aborted)
                        throw parentSignal.reason;
                    let rawDelay;
                    try {
                        rawDelay = backoffFn
                            ? backoffFn(attempt, syntheticError, backoffState)
                            : computeDelay(attempt, opts);
                    }
                    catch {
                        rawDelay = computeDelay(attempt, opts);
                    }
                    const safeDelay = Number.isFinite(rawDelay) ? rawDelay : 0;
                    const delay = Math.min(Math.max(0, safeDelay), LIMITS.MAX_RETRY_DELAY_MS);
                    if (obs) {
                        safeCall(obs.hooks.onRetry, {
                            type: 'retry', key: ctx.key, traceId: obs.traceId,
                            timestamp: Date.now(), attempt, delayMs: delay,
                            error: syntheticError,
                        });
                    }
                    if (delay > 0)
                        await sleep(delay, parentSignal, sleepOpts);
                    continue;
                }
                return value;
            }
            catch (err) {
                if (errors === undefined)
                    errors = [];
                if (errors.length < 10) {
                    errors.push(err);
                }
                else {
                    errors.shift();
                    errors.push(err);
                }
                let retryable;
                try {
                    retryable = shouldRetry(err, attempt);
                }
                catch {
                    throw err;
                }
                if (attempt >= max) {
                    if (retriedAtLeastOnce) {
                        throw new RetryExhaustedError({
                            key: ctx.key,
                            attempts: attempt,
                            lastError: err,
                            errors: errors ?? [],
                        });
                    }
                    throw err;
                }
                if (!retryable)
                    throw err;
                retriedAtLeastOnce = true;
                if (parentSignal.aborted)
                    throw parentSignal.reason;
                let rawDelay;
                try {
                    rawDelay = backoffFn
                        ? backoffFn(attempt, err, backoffState)
                        : computeDelay(attempt, opts);
                }
                catch {
                    rawDelay = computeDelay(attempt, opts);
                }
                const safeDelay = Number.isFinite(rawDelay) ? rawDelay : 0;
                const delay = Math.min(Math.max(0, safeDelay), LIMITS.MAX_RETRY_DELAY_MS);
                if (obs) {
                    safeCall(obs.hooks.onRetry, {
                        type: 'retry', key: ctx.key, traceId: obs.traceId,
                        timestamp: Date.now(), attempt, delayMs: delay, error: err,
                    });
                }
                if (delay > 0) {
                    await sleep(delay, parentSignal, sleepOpts);
                }
            }
        }
        throw new Error('Actly: retryPolicy reached unreachable state');
    };
}
