import type { ActOptions, PolicyApplier } from '../types.js'
import { retryPolicy } from '../policies/retry.js'
import { timeoutPolicy, totalTimeoutPolicy } from '../policies/timeout.js'
import { dedupePolicy } from '../policies/dedupe.js'
import { cachePolicy } from '../policies/cache.js'
import { circuitBreakerPolicy } from '../policies/circuitBreaker.js'
import { bulkheadPolicy } from '../policies/bulkhead.js'
import { rateLimitPolicy } from '../policies/rateLimit.js'

/**
 * True when no option field is set, i.e. the call can take the fast path:
 * no policies, no signal, no observability. Written as explicit field
 * checks so a literal-empty options object stays allocation-free.
 */
export function hasAnyOption(options: ActOptions): boolean {
  return (
    options.retry !== undefined ||
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
    options.audit !== undefined
  )
}

/**
 * Normalize `dedupe: true` shorthand; undefined when disabled. The object
 * form enables unless `enabled: false` — the same rule every other policy
 * and the standalone `dedupePolicy` follow. (Before 1.4.2 an object without
 * a truthy `enabled` was a silent no-op.)
 */
function normalizeDedupe(
  opt: ActOptions['dedupe'],
): { enabled: true; inflightTtl?: number } | undefined {
  if (opt === true) return { enabled: true }
  if (opt && typeof opt === 'object' && opt.enabled !== false) {
    // skip 0/NaN: the policy default (5 min) is safer than immediate expiry
    if (opt.inflightTtl !== undefined && opt.inflightTtl !== 0 && !Number.isNaN(opt.inflightTtl)) {
      return { enabled: true, inflightTtl: opt.inflightTtl }
    }
    return { enabled: true }
  }
  return undefined
}

// Policy appliers are pure per options object, so a frozen options object
// can be built once and reused. Non-frozen objects are not cached: callers
// may mutate them between calls.
const frozenPolicyCache = new WeakMap<object, ReadonlyArray<PolicyApplier<unknown>>>()

/**
 * Build the policy chain, outermost first:
 * `[rateLimit, circuitBreaker, totalTimeout, cache, bulkhead, dedupe, retry, timeout]`.
 * No-op policies (retry.attempts=1, cache.ttl<=0) are skipped.
 *
 * Frozen options objects are cached in a WeakMap: freeze your shared
 * config to get a zero-allocation chain on every call.
 */
export function buildPolicies<T>(options: ActOptions): ReadonlyArray<PolicyApplier<T>> {
  if (Object.isFrozen(options)) {
    const cached = frozenPolicyCache.get(options)
    if (cached) return cached as unknown as ReadonlyArray<PolicyApplier<T>>
    const built = buildUncached<T>(options)
    frozenPolicyCache.set(options, built as unknown as ReadonlyArray<PolicyApplier<unknown>>)
    return built
  }
  return buildUncached<T>(options)
}

function buildUncached<T>(options: ActOptions): ReadonlyArray<PolicyApplier<T>> {
  const dedupe = normalizeDedupe(options.dedupe)
  const policies: Array<PolicyApplier<T>> = []

  if (options.rateLimit) {
    policies.push(rateLimitPolicy<T>(options.rateLimit))
  }
  if (options.circuitBreaker) {
    policies.push(circuitBreakerPolicy<T>(options.circuitBreaker))
  }
  if (options.totalTimeout && options.totalTimeout.ms > 0) {
    policies.push(totalTimeoutPolicy<T>(options.totalTimeout))
  }
  if (options.cache && options.cache.ttl > 0) {
    policies.push(cachePolicy<T>(options.cache))
  }
  if (options.bulkhead) {
    policies.push(bulkheadPolicy<T>(options.bulkhead))
  }
  if (dedupe) {
    policies.push(dedupePolicy<T>(dedupe))
  }
  if (options.retry && options.retry.attempts > 1) {
    policies.push(retryPolicy<T>(options.retry))
  }
  if (options.timeout && options.timeout.ms > 0) {
    policies.push(timeoutPolicy<T>(options.timeout))
  }

  return policies
}
