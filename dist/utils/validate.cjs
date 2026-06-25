"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertKey = assertKey;
exports.assertRetryOptions = assertRetryOptions;
exports.assertTimeoutOptions = assertTimeoutOptions;
exports.assertCacheOptions = assertCacheOptions;
exports.assertDedupeOptions = assertDedupeOptions;
exports.assertOptions = assertOptions;
/**
 * Validate user-facing option shapes. Throws `RangeError` / `TypeError` on
 * invalid input — these are programmer errors, not runtime failures, so
 * throwing (rather than returning an `ActFailure`) is the right call.
 *
 * Called once at the top of `act()` so policies can assume well-formed input.
 */
function assertKey(key) {
    if (typeof key !== 'string') {
        throw new TypeError(`Actly: key must be a string, got ${typeof key}`);
    }
    if (key.length === 0) {
        throw new RangeError("Actly: key must be non-empty. An empty key collapses every caller " +
            "onto the same dedupe/cache slot — almost certainly a bug.");
    }
    // Reject reserved internal prefixes so user keys cannot collide with
    // dedupe/cache namespace prefixes.
    if (key.startsWith('dedupe:') || key.startsWith('cache:') || key.startsWith('__inflight:')) {
        throw new RangeError(`Actly: key must not start with reserved prefix "dedupe:", "cache:", or "__inflight:" (got ${JSON.stringify(key)}).`);
    }
}
function assertRetryOptions(opts) {
    if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
        throw new RangeError(`Actly: retry.attempts must be a positive integer, got ${opts.attempts}`);
    }
    if (opts.delayMs !== undefined) {
        assertNonNegativeFinite('retry.delayMs', opts.delayMs);
    }
    if (opts.maxDelay !== undefined) {
        assertNonNegativeFinite('retry.maxDelay', opts.maxDelay);
    }
    if (opts.shouldRetry !== undefined && typeof opts.shouldRetry !== 'function') {
        throw new TypeError(`Actly: retry.shouldRetry must be a function, got ${typeof opts.shouldRetry}`);
    }
}
function assertTimeoutOptions(opts, field) {
    if (typeof opts.ms !== 'number' || !Number.isFinite(opts.ms) || opts.ms <= 0) {
        throw new RangeError(`Actly: ${field}.ms must be a positive finite number, got ${opts.ms}`);
    }
}
function assertCacheOptions(opts) {
    if (typeof opts.ttl !== 'number' || !Number.isFinite(opts.ttl) || opts.ttl <= 0) {
        throw new RangeError(`Actly: cache.ttl must be a positive finite number, got ${opts.ttl}`);
    }
}
function assertDedupeOptions(opts) {
    if (opts.inflightTtl !== undefined) {
        assertNonNegativeFinite('dedupe.inflightTtl', opts.inflightTtl);
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
}
function assertNonNegativeFinite(field, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`Actly: ${field} must be a non-negative finite number, got ${value}`);
    }
}
