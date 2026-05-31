import type { ActFn, PolicyApplier, PolicyContext } from '../types/index.js'

// Namespace so dedupe keys never collide with cache keys in the shared store
const NS = 'dedupe:'

/**
 * Collapses concurrent calls that share the same key into one in-flight Promise.
 *
 * The first caller starts the work. Every subsequent caller that arrives before
 * the first resolves gets the same Promise back — no duplicate work.
 *
 * Known tradeoff (v1): deduped callers see attempts=1 in their ActResult because
 * the retry counter belongs to the originating call's meta object.
 */
export function dedupePolicy<T>(): PolicyApplier<T> {
  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async () => {
      const key = NS + ctx.key

      const inflight = ctx.store.get<Promise<T>>(key)
      if (inflight) return inflight

      // No TTL — .finally() cleans up regardless of outcome
      const promise = fn().finally(() => ctx.store.delete(key))
      ctx.store.set<Promise<T>>(key, promise)
      return promise
    }
}
