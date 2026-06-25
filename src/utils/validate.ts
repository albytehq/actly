import type {
  ActOptions,
  CacheOptions,
  DedupeOptions,
  RetryOptions,
  TimeoutOptions,
} from '../types/index.js'

/**
 * Validate user-facing option shapes. Throws `RangeError` / `TypeError` on
 * invalid input — these are programmer errors, not runtime failures, so
 * throwing (rather than returning an `ActFailure`) is the right call.
 *
 * Called once at the top of `act()` so policies can assume well-formed input.
 */

export function assertKey(key: string): void {
  if (typeof key !== 'string') {
    throw new TypeError(`Actly: key must be a string, got ${typeof key}`)
  }
  if (key.length === 0) {
    throw new RangeError(
      "Actly: key must be non-empty. An empty key collapses every caller " +
      "onto the same dedupe/cache slot — almost certainly a bug.",
    )
  }
  // Reject reserved internal prefixes so user keys cannot collide with
  // dedupe/cache namespace prefixes.
  if (key.startsWith('dedupe:') || key.startsWith('cache:') || key.startsWith('__inflight:')) {
    throw new RangeError(
      `Actly: key must not start with reserved prefix "dedupe:", "cache:", or "__inflight:" (got ${JSON.stringify(key)}).`
    )
  }
}

export function assertRetryOptions(opts: RetryOptions): void {
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new RangeError(
      `Actly: retry.attempts must be a positive integer, got ${opts.attempts}`,
    )
  }
  if (opts.delayMs !== undefined) {
    assertNonNegativeFinite('retry.delayMs', opts.delayMs)
  }
  if (opts.maxDelay !== undefined) {
    assertNonNegativeFinite('retry.maxDelay', opts.maxDelay)
  }
  if (opts.shouldRetry !== undefined && typeof opts.shouldRetry !== 'function') {
    throw new TypeError(
      `Actly: retry.shouldRetry must be a function, got ${typeof opts.shouldRetry}`,
    )
  }
}

export function assertTimeoutOptions(opts: TimeoutOptions, field: string): void {
  if (typeof opts.ms !== 'number' || !Number.isFinite(opts.ms) || opts.ms <= 0) {
    throw new RangeError(
      `Actly: ${field}.ms must be a positive finite number, got ${opts.ms}`,
    )
  }
}

export function assertCacheOptions(opts: CacheOptions): void {
  if (typeof opts.ttl !== 'number' || !Number.isFinite(opts.ttl) || opts.ttl <= 0) {
    throw new RangeError(
      `Actly: cache.ttl must be a positive finite number, got ${opts.ttl}`,
    )
  }
}

export function assertDedupeOptions(opts: DedupeOptions): void {
  if (opts.inflightTtl !== undefined) {
    assertNonNegativeFinite('dedupe.inflightTtl', opts.inflightTtl)
  }
}

export function assertOptions(options: ActOptions): void {
  if (options.retry)     assertRetryOptions(options.retry)
  if (options.timeout)   assertTimeoutOptions(options.timeout, 'timeout')
  if (options.totalTimeout) assertTimeoutOptions(options.totalTimeout, 'totalTimeout')
  if (options.cache)     assertCacheOptions(options.cache)
  if (options.dedupe && typeof options.dedupe !== 'boolean') {
    assertDedupeOptions(options.dedupe)
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError(
      `Actly: signal must be an AbortSignal, got ${options.signal === null ? 'null' : typeof options.signal}`,
    )
  }
}

function assertNonNegativeFinite(field: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `Actly: ${field} must be a non-negative finite number, got ${value}`,
    )
  }
}
