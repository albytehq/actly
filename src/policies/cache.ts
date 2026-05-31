import type { ActFn, CacheOptions, PolicyApplier, PolicyContext } from '../types/index.js'

const NS = 'cache:'

// Wrap in an object so T=undefined is still distinguishable from a cache miss
interface CacheEntry<T> {
  value: T
}

/**
 * Short-circuits the entire downstream chain on a cache hit.
 * On a miss, runs fn and stores the result with TTL.
 *
 * Must be the OUTERMOST policy so a hit skips dedupe, timeout, and retry.
 */
export function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T> {
  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async () => {
      const key = NS + ctx.key

      const hit = ctx.store.get<CacheEntry<T>>(key)
      if (hit) {
        ctx.meta.source = 'cache'
        return hit.value
      }

      const value = await fn()
      ctx.store.set<CacheEntry<T>>(key, { value }, opts.ttl)
      return value
    }
}
