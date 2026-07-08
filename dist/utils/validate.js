import { LIMITS } from './limits.js';
import { sanitizeKey } from './key.js';
export function assertKey(key) {
    sanitizeKey(key);
}
export function assertRetryOptions(opts) {
    if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
        throw new RangeError(`Actly: retry.attempts must be a positive integer, got ${opts.attempts}`);
    }
    if (opts.attempts > LIMITS.MAX_RETRY_ATTEMPTS) {
        throw new RangeError(`Actly: retry.attempts ${opts.attempts} exceeds limit ${LIMITS.MAX_RETRY_ATTEMPTS}. ` +
            `If you genuinely need more, use an outer supervisor.`);
    }
    if (opts.delayMs !== undefined) {
        assertNonNegativeFinite('retry.delayMs', opts.delayMs, LIMITS.MAX_RETRY_DELAY_MS);
    }
    if (opts.maxDelay !== undefined) {
        assertNonNegativeFinite('retry.maxDelay', opts.maxDelay, LIMITS.MAX_RETRY_DELAY_MS);
    }
    if (opts.backoff !== undefined && !BACKOFF_MODES.has(opts.backoff)) {
        throw new RangeError(`Actly: retry.backoff must be one of ${[...BACKOFF_MODES].map((m) => JSON.stringify(m)).join(' | ')}, ` +
            `got ${JSON.stringify(opts.backoff)}`);
    }
    if (opts.jitter !== undefined && !JITTER_MODES.has(opts.jitter)) {
        throw new RangeError(`Actly: retry.jitter must be one of ${[...JITTER_MODES].map((m) => JSON.stringify(m)).join(' | ')}, ` +
            `got ${JSON.stringify(opts.jitter)}`);
    }
    if (opts.shouldRetry !== undefined && typeof opts.shouldRetry !== 'function') {
        throw new TypeError(`Actly: retry.shouldRetry must be a function, got ${typeof opts.shouldRetry}`);
    }
    if (opts.shouldRetryResult !== undefined && typeof opts.shouldRetryResult !== 'function') {
        throw new TypeError(`Actly: retry.shouldRetryResult must be a function, got ${typeof opts.shouldRetryResult}`);
    }
    if (opts.backoffFn !== undefined && typeof opts.backoffFn !== 'function') {
        throw new TypeError(`Actly: retry.backoffFn must be a function, got ${typeof opts.backoffFn}`);
    }
    if (opts.dangerouslyUnref !== undefined && typeof opts.dangerouslyUnref !== 'boolean') {
        throw new TypeError(`Actly: retry.dangerouslyUnref must be a boolean, got ${typeof opts.dangerouslyUnref}`);
    }
}
export function assertTimeoutOptions(opts, field) {
    if (typeof opts.ms !== 'number' || !Number.isFinite(opts.ms) || opts.ms <= 0) {
        throw new RangeError(`Actly: ${field}.ms must be a positive finite number, got ${opts.ms}`);
    }
    if (opts.ms > LIMITS.MAX_TIMEOUT_MS) {
        throw new RangeError(`Actly: ${field}.ms ${opts.ms} exceeds limit ${LIMITS.MAX_TIMEOUT_MS}.`);
    }
    if (opts.strategy !== undefined && opts.strategy !== 'race' && opts.strategy !== 'cooperative') {
        throw new RangeError(`Actly: ${field}.strategy must be 'race' or 'cooperative', got ${JSON.stringify(opts.strategy)}`);
    }
}
export function assertCacheOptions(opts) {
    if (typeof opts.ttl !== 'number' || !Number.isFinite(opts.ttl) || opts.ttl <= 0) {
        throw new RangeError(`Actly: cache.ttl must be a positive finite number, got ${opts.ttl}`);
    }
    if (opts.ttl > LIMITS.MAX_CACHE_TTL) {
        throw new RangeError(`Actly: cache.ttl ${opts.ttl} exceeds limit ${LIMITS.MAX_CACHE_TTL} (~24h).`);
    }
}
export function assertDedupeOptions(opts) {
    if (opts.inflightTtl !== undefined) {
        if (opts.inflightTtl === Number.POSITIVE_INFINITY)
            return;
        if (opts.inflightTtl === 0) {
            throw new RangeError(`Actly: dedupe.inflightTtl must be > 0 (or Infinity). Got 0 — "immediate expiry" is not a valid configuration; use a small positive number (e.g. 1) instead.`);
        }
        assertNonNegativeFinite('dedupe.inflightTtl', opts.inflightTtl, LIMITS.MAX_INFLIGHT_TTL);
    }
}
export function assertOptions(options) {
    if (options.retry)
        assertRetryOptions(options.retry);
    if (options.timeout)
        assertTimeoutOptions(options.timeout, 'timeout');
    if (options.totalTimeout)
        assertTimeoutOptions(options.totalTimeout, 'totalTimeout');
    if (options.cache)
        assertCacheOptions(options.cache);
    if (options.dedupe != null && typeof options.dedupe !== 'boolean') {
        assertDedupeOptions(options.dedupe);
    }
    if (options.dedupe != null &&
        typeof options.dedupe !== 'boolean' && typeof options.dedupe !== 'object') {
        throw new TypeError(`Actly: dedupe must be a boolean, an object, or undefined, got ${typeof options.dedupe}`);
    }
    if (options.signal !== undefined && options.signal !== null) {
        const s = options.signal;
        if (typeof s !== 'object' ||
            typeof s.aborted !== 'boolean' ||
            typeof s.addEventListener !== 'function' ||
            typeof s.removeEventListener !== 'function') {
            throw new TypeError(`Actly: signal must be an AbortSignal (object with .aborted boolean, .addEventListener function, and .removeEventListener function), got ${options.signal === null ? 'null' : typeof options.signal}`);
        }
    }
    if (options.circuitBreaker)
        assertCircuitBreakerOptions(options.circuitBreaker);
    if (options.bulkhead)
        assertBulkheadOptions(options.bulkhead);
    if (options.rateLimit)
        assertRateLimitOptions(options.rateLimit);
    if (options.hedge)
        assertHedgeOptions(options.hedge);
    if (options.audit)
        assertAuditOptions(options.audit);
}
export function assertAuditOptions(opts) {
    if (typeof opts.log !== 'function') {
        throw new TypeError(`Actly: audit.log must be a function, got ${opts.log === null ? 'null' : typeof opts.log}`);
    }
}
export function assertCircuitBreakerOptions(opts) {
    if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
        throw new RangeError(`Actly: circuitBreaker.threshold must be a positive integer, got ${opts.threshold}`);
    }
    if (typeof opts.cooldownMs !== 'number' || !Number.isFinite(opts.cooldownMs) || opts.cooldownMs <= 0) {
        throw new RangeError(`Actly: circuitBreaker.cooldownMs must be a positive finite number, got ${opts.cooldownMs}`);
    }
    if (opts.resetTimeoutMs !== undefined) {
        if (opts.resetTimeoutMs === Number.POSITIVE_INFINITY)
            return;
        assertNonNegativeFinite('circuitBreaker.resetTimeoutMs', opts.resetTimeoutMs, Number.POSITIVE_INFINITY);
    }
    if (opts.strategy !== undefined && opts.strategy !== 'consecutive' && opts.strategy !== 'count') {
        throw new RangeError(`Actly: circuitBreaker.strategy must be 'consecutive' or 'count', got ${JSON.stringify(opts.strategy)}`);
    }
    if (opts.countSize !== undefined) {
        if (!Number.isInteger(opts.countSize) || opts.countSize < 1) {
            throw new RangeError(`Actly: circuitBreaker.countSize must be a positive integer, got ${opts.countSize}`);
        }
        if (opts.countSize > LIMITS.MAX_CIRCUIT_BREAKER_WINDOW) {
            throw new RangeError(`Actly: circuitBreaker.countSize ${opts.countSize} exceeds limit ${LIMITS.MAX_CIRCUIT_BREAKER_WINDOW}.`);
        }
    }
    if (opts.countThreshold !== undefined) {
        if (!Number.isFinite(opts.countThreshold) || opts.countThreshold < 0 || opts.countThreshold > 1) {
            throw new RangeError(`Actly: circuitBreaker.countThreshold must be a finite number between 0 and 1, got ${opts.countThreshold}`);
        }
    }
    if (opts.countMinimumCalls !== undefined) {
        if (!Number.isInteger(opts.countMinimumCalls) || opts.countMinimumCalls < 1) {
            throw new RangeError(`Actly: circuitBreaker.countMinimumCalls must be a positive integer, got ${opts.countMinimumCalls}`);
        }
        if (opts.countMinimumCalls > LIMITS.MAX_CIRCUIT_BREAKER_WINDOW) {
            throw new RangeError(`Actly: circuitBreaker.countMinimumCalls ${opts.countMinimumCalls} exceeds limit ${LIMITS.MAX_CIRCUIT_BREAKER_WINDOW}.`);
        }
    }
}
export function assertBulkheadOptions(opts) {
    if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
        throw new RangeError(`Actly: bulkhead.maxConcurrent must be a positive integer, got ${opts.maxConcurrent}`);
    }
    if (opts.maxConcurrent > LIMITS.MAX_BULKHEAD_CONCURRENCY) {
        throw new RangeError(`Actly: bulkhead.maxConcurrent ${opts.maxConcurrent} exceeds limit ${LIMITS.MAX_BULKHEAD_CONCURRENCY}.`);
    }
    if (opts.queueTimeoutMs !== undefined) {
        assertNonNegativeFinite('bulkhead.queueTimeoutMs', opts.queueTimeoutMs, Number.POSITIVE_INFINITY);
    }
    if (opts.maxQueueSize !== undefined) {
        if (opts.maxQueueSize !== Number.POSITIVE_INFINITY &&
            (!Number.isInteger(opts.maxQueueSize) || opts.maxQueueSize < 1)) {
            throw new RangeError(`Actly: bulkhead.maxQueueSize must be a positive integer or Infinity, got ${opts.maxQueueSize}`);
        }
        if (opts.maxQueueSize !== Number.POSITIVE_INFINITY &&
            opts.maxQueueSize > LIMITS.MAX_BULKHEAD_QUEUE) {
            throw new RangeError(`Actly: bulkhead.maxQueueSize ${opts.maxQueueSize} exceeds limit ${LIMITS.MAX_BULKHEAD_QUEUE}.`);
        }
    }
}
export function assertRateLimitOptions(opts) {
    if (!Number.isInteger(opts.maxCalls) || opts.maxCalls < 1) {
        throw new RangeError(`Actly: rateLimit.maxCalls must be a positive integer, got ${opts.maxCalls}`);
    }
    if (opts.maxCalls > LIMITS.MAX_RATE_LIMIT_CALLS) {
        throw new RangeError(`Actly: rateLimit.maxCalls ${opts.maxCalls} exceeds limit ${LIMITS.MAX_RATE_LIMIT_CALLS}.`);
    }
    if (typeof opts.windowMs !== 'number' || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
        throw new RangeError(`Actly: rateLimit.windowMs must be a positive finite number, got ${opts.windowMs}`);
    }
}
export function assertHedgeOptions(opts) {
    if (typeof opts.delayMs !== 'number' || !Number.isFinite(opts.delayMs) || opts.delayMs <= 0) {
        throw new RangeError(`Actly: hedge.delayMs must be a positive finite number, got ${opts.delayMs}`);
    }
    if (opts.delayMs > LIMITS.MAX_HEDGE_DELAY_MS) {
        throw new RangeError(`Actly: hedge.delayMs ${opts.delayMs} exceeds limit ${LIMITS.MAX_HEDGE_DELAY_MS}.`);
    }
    if (opts.placement !== undefined && opts.placement !== 'outside-retry' && opts.placement !== 'inside-retry') {
        throw new RangeError(`Actly: hedge.placement must be 'outside-retry' or 'inside-retry', got ${JSON.stringify(opts.placement)}`);
    }
    if (opts.keepLoser !== undefined && typeof opts.keepLoser !== 'boolean') {
        throw new TypeError(`Actly: hedge.keepLoser must be a boolean, got ${typeof opts.keepLoser}`);
    }
}
function assertNonNegativeFinite(field, value, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`Actly: ${field} must be a non-negative finite number, got ${value}`);
    }
    if (value > max) {
        throw new RangeError(`Actly: ${field} ${value} exceeds limit ${max}.`);
    }
}
const BACKOFF_MODES = new Set(['none', 'linear', 'exponential']);
const JITTER_MODES = new Set(['none', 'full', 'equal', 'decorrelated']);
