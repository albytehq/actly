import type { ActFn, CacheOptions, PolicyApplier, PolicyContext } from '../types.js'
import { isSyncStore } from '../stores/contract.js'
import { safeCall } from '../safeCall.js'
import { raceAbort } from '../abort.js'
import { assertCacheOptions } from '../validate.js'
import { LIMITS } from '../limits.js'

const NS = 'cache:'
const INFLIGHT_NS = 'inflight:cache:'

// Wraps the cached value so T = undefined is distinguishable from a miss.
interface CacheEntry<T> {
  value: T
  insertedAt: number
}

// Single-flight entry; the generation token makes stale cleanup a no-op
// when a newer originator replaced the slot.
interface InflightEntry<T> {
  promise: Promise<T>
  generation: number
  meta: PolicyContext['meta']
}

let generationCounter = 0
function nextGeneration(): number {
  generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER
  return generationCounter
}

/**
 * Short-circuit on a cache hit; on a miss, run `fn` and store the result
 * with TTL. Failures are never cached. On a sync store, concurrent misses
 * share an in-flight promise (same mechanism as `dedupePolicy`) to prevent
 * stampedes; async stores cannot do this atomically.
 *
 * `store.set()` failures are swallowed (cache is an optimisation). On a
 * hit, `meta.source = 'cache'` and `meta.attempts = 0`.
 *
 * Options are validated at construction: the store layer maps a
 * non-positive or non-finite `ttl` to "never expires", so `ttl: 0` would
 * silently become an infinite cache.
 */
export function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T> {
  assertCacheOptions(opts)
  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(signal.reason)

      const key = NS + ctx.key
      const inflightKey = INFLIGHT_NS + ctx.key

      if (isSyncStore(ctx.store)) {
        const store = ctx.store
        const obs = ctx.observability

        const hit = store.get<CacheEntry<T>>(key)
        if (hit) {
          ctx.meta.source = 'cache'
          ctx.meta.attempts = 0
          if (obs) {
            safeCall(obs.hooks.onCacheHit, {
              type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
              timestamp: Date.now(), ageMs: Math.max(0, Date.now() - hit.insertedAt),
            })
          }
          return hit.value
        }

        if (obs) {
          safeCall(obs.hooks.onCacheMiss, {
            type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
            timestamp: Date.now(),
          })
        }

        const inflight = store.get<InflightEntry<T>>(inflightKey)
        if (inflight) {
          try {
            const value = await raceAbort(inflight.promise, signal)
            ctx.meta.attempts = inflight.meta.attempts
            ctx.meta.source = inflight.meta.source
            return value
          } catch (err) {
            if (signal.aborted) {
              ctx.meta.attempts = 0
            } else {
              ctx.meta.attempts = inflight.meta.attempts
              ctx.meta.source = inflight.meta.source
            }
            throw err
          }
        }

        const generation = nextGeneration()
        const rawPromise = Promise.resolve(fn(signal)).then(
          (value) => {
            try {
              store.set<CacheEntry<T>>(key, { value, insertedAt: Date.now() }, opts.ttl)
            } catch {
              // fail-open: a cache write failure must not surface
            }
            return value
          },
        )

        // Publishing the inflight slot is an optimisation: failure here just
        // disables single-flight for this call.
        try {
          store.set<InflightEntry<T>>(inflightKey, { promise: rawPromise, generation, meta: ctx.meta }, LIMITS.DEFAULT_INFLIGHT_TTL)
        } catch {
          // proceed without publishing
        }

        const cleanup = () => {
          try {
            const current = store.get<InflightEntry<T>>(inflightKey)
            if (current && current.generation === generation) {
              try { store.delete(inflightKey) } catch { /* ignore */ }
            }
          } catch {
            // slot expires via TTL
          }
        }
        rawPromise.then(cleanup, cleanup).catch(() => { /* handled by awaiter */ })

        return raceAbort(rawPromise, signal)
      }

      // Async store: no single-flight (the race window is unavoidable).
      // Re-check aborted between awaits.
      const obs = ctx.observability
      const hit = await ctx.store.get<CacheEntry<T>>(key)
      if (signal.aborted) return Promise.reject(signal.reason)
      if (hit) {
        ctx.meta.source = 'cache'
        ctx.meta.attempts = 0
        if (obs) {
          safeCall(obs.hooks.onCacheHit, {
            type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
            timestamp: Date.now(), ageMs: Math.max(0, Date.now() - hit.insertedAt),
          })
        }
        return hit.value
      }
      if (obs) {
        safeCall(obs.hooks.onCacheMiss, {
          type: 'cache-miss', key: ctx.key, traceId: obs.traceId,
          timestamp: Date.now(),
        })
      }

      const value = await fn(signal)
      if (signal.aborted) return Promise.reject(signal.reason)
      try {
        await ctx.store.set<CacheEntry<T>>(key, { value, insertedAt: Date.now() }, opts.ttl)
      } catch {
        // fail-open
      }
      return value
    }
}
