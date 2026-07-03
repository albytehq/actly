"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertKey = assertKey;
exports.assertRetryOptions = assertRetryOptions;
exports.assertTimeoutOptions = assertTimeoutOptions;
exports.assertCacheOptions = assertCacheOptions;
exports.assertDedupeOptions = assertDedupeOptions;
exports.assertOptions = assertOptions;
exports.assertAuditOptions = assertAuditOptions;
exports.assertCircuitBreakerOptions = assertCircuitBreakerOptions;
exports.assertBulkheadOptions = assertBulkheadOptions;
exports.assertRateLimitOptions = assertRateLimitOptions;
exports.assertHedgeOptions = assertHedgeOptions;
const limits_js_1 = require("./limits.js");
const key_js_1 = require("./key.js");
/**
 * Validate user-facing option shapes. Throws `RangeError` / `TypeError` on
 * invalid input — these are programmer errors, not runtime failures, so
 * throwing (rather than returning an `ActFailure`) is the right call.
 *
 * Called once at the top of `act()` so policies can assume well-formed input.
 *
 * # Caps
 *
 * Every numeric input is bounded by {@link LIMITS}. This prevents memory
 * exhaustion (huge TTLs), CPU exhaustion (huge retry counts), and timer
 * overflow (huge delays). See `limits.ts` for rationale.
 */
function assertKey(key) {
    // Delegated to the dedicated sanitiser — keeps key rules in one place
    // for security centralisation. See `key.ts` for the full rule set.
    (0, key_js_1.sanitizeKey)(key);
}
function assertRetryOptions(opts) {
    if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
        throw new RangeError(`Actly: retry.attempts must be a positive integer, got ${opts.attempts}`);
    }
    if (opts.attempts > limits_js_1.LIMITS.MAX_RETRY_ATTEMPTS) {
        throw new RangeError(`Actly: retry.attempts ${opts.attempts} exceeds limit ${limits_js_1.LIMITS.MAX_RETRY_ATTEMPTS}. ` +
            `If you genuinely need more, use an outer supervisor.`);
    }
    if (opts.delayMs !== undefined) {
        assertNonNegativeFinite('retry.delayMs', opts.delayMs, limits_js_1.LIMITS.MAX_RETRY_DELAY_MS);
    }
    if (opts.maxDelay !== undefined) {
        assertNonNegativeFinite('retry.maxDelay', opts.maxDelay, limits_js_1.LIMITS.MAX_RETRY_DELAY_MS);
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
}
function assertTimeoutOptions(opts, field) {
    if (typeof opts.ms !== 'number' || !Number.isFinite(opts.ms) || opts.ms <= 0) {
        throw new RangeError(`Actly: ${field}.ms must be a positive finite number, got ${opts.ms}`);
    }
    if (opts.ms > limits_js_1.LIMITS.MAX_TIMEOUT_MS) {
        throw new RangeError(`Actly: ${field}.ms ${opts.ms} exceeds limit ${limits_js_1.LIMITS.MAX_TIMEOUT_MS}.`);
    }
}
function assertCacheOptions(opts) {
    if (typeof opts.ttl !== 'number' || !Number.isFinite(opts.ttl) || opts.ttl <= 0) {
        throw new RangeError(`Actly: cache.ttl must be a positive finite number, got ${opts.ttl}`);
    }
    if (opts.ttl > limits_js_1.LIMITS.MAX_CACHE_TTL) {
        throw new RangeError(`Actly: cache.ttl ${opts.ttl} exceeds limit ${limits_js_1.LIMITS.MAX_CACHE_TTL} (~24h).`);
    }
}
function assertDedupeOptions(opts) {
    if (opts.inflightTtl !== undefined) {
        assertNonNegativeFinite('dedupe.inflightTtl', opts.inflightTtl, limits_js_1.LIMITS.MAX_INFLIGHT_TTL);
    }
}
function assertOptions(options) {
    if (options.retry)
        assertRetryOptions(options.retry);
    if (options.timeout)
        assertTimeoutOptions(options.timeout, 'timeout');
    if (options.totalTimeout)
        assertTimeoutOptions(options.totalTimeout, 'totalTimeout');
    if (options.cache)
        assertCacheOptions(options.cache);
    if (options.dedupe && typeof options.dedupe !== 'boolean') {
        assertDedupeOptions(options.dedupe);
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
        throw new TypeError(`Actly: signal must be an AbortSignal, got ${options.signal === null ? 'null' : typeof options.signal}`);
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
function assertAuditOptions(opts) {
    if (typeof opts.log !== 'function') {
        throw new TypeError(`Actly: audit.log must be a function, got ${opts.log === null ? 'null' : typeof opts.log}`);
    }
}
function assertCircuitBreakerOptions(opts) {
    if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
        throw new RangeError(`Actly: circuitBreaker.threshold must be a positive integer, got ${opts.threshold}`);
    }
    if (typeof opts.cooldownMs !== 'number' || !Number.isFinite(opts.cooldownMs) || opts.cooldownMs <= 0) {
        throw new RangeError(`Actly: circuitBreaker.cooldownMs must be a positive finite number, got ${opts.cooldownMs}`);
    }
    if (opts.resetTimeoutMs !== undefined) {
        assertNonNegativeFinite('circuitBreaker.resetTimeoutMs', opts.resetTimeoutMs, Number.POSITIVE_INFINITY);
    }
}
function assertBulkheadOptions(opts) {
    if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
        throw new RangeError(`Actly: bulkhead.maxConcurrent must be a positive integer, got ${opts.maxConcurrent}`);
    }
    if (opts.queueTimeoutMs !== undefined) {
        assertNonNegativeFinite('bulkhead.queueTimeoutMs', opts.queueTimeoutMs, Number.POSITIVE_INFINITY);
    }
}
function assertRateLimitOptions(opts) {
    if (!Number.isInteger(opts.maxCalls) || opts.maxCalls < 1) {
        throw new RangeError(`Actly: rateLimit.maxCalls must be a positive integer, got ${opts.maxCalls}`);
    }
    if (typeof opts.windowMs !== 'number' || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
        throw new RangeError(`Actly: rateLimit.windowMs must be a positive finite number, got ${opts.windowMs}`);
    }
}
function assertHedgeOptions(opts) {
    if (typeof opts.delayMs !== 'number' || !Number.isFinite(opts.delayMs) || opts.delayMs <= 0) {
        throw new RangeError(`Actly: hedge.delayMs must be a positive finite number, got ${opts.delayMs}`);
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
