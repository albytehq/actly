import type { ActFn, CacheOptions, PolicyApplier, PolicyContext } from '../types/index.js'
import { isSyncStore } from '../stores/base.js'
import { safeCall } from '../utils/safeCall.js'
import { raceAbort } from '../utils/abort.js'
import { LIMITS } from '../utils/limits.js'

const NS = 'cache:'
const INFLIGHT_NS = 'inflight:cache:'

// Wrap cached values so `T = undefined` is distinguishable from a cache miss.
// Carries insertedAt so onCacheHit can report accurate age.
interface CacheEntry<T> {
  value: T
  insertedAt: number
}

// In-flight single-flight entry. Generation token prevents stale cleanup
// from an old originator clobbering a newer entry. The inflight slot has
// its own TTL so a hung fn can't hold the slot forever.
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
 * Short-circuit the chain on a cache hit; on a miss, run `fn` and store
 * the result with TTL.
 *
 * The stored in-flight promise is the RAW `fn(signal)` (not raceAbort-
 * wrapped), so an originator's signal abort doesn't reject for joiners -
 * each caller races only against their own signal. Cleanup is generation-
 * safe so stale originators don't delete newer entries.
 *
 * On a sync store, concurrent misses share an in-flight promise (single-
 * flight, same mechanism as `dedupePolicy`) to prevent stampedes. Async
 * stores can't do this atomically; pair with dedupe at a higher layer if
 * you need single-flight.
 *
 * `store.set()` failures are swallowed (cache is an optimisation, not a
 * correctness requirement). Failures are never cached. On a cache hit,
 * `meta.source = 'cache'` and `meta.attempts = 0`.
 */
export function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T> {
  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async (signal: AbortSignal) => {
      // honour abort on cache hit too, matching act()'s contract
      if (signal.aborted) return Promise.reject(signal.reason)

      const key = NS + ctx.key
      const inflightKey = INFLIGHT_NS + ctx.key

      // ─── Sync store: fast path with single-flight ────────────────────────
      if (isSyncStore(ctx.store)) {
        // narrow once; TS doesn't carry the narrowing into nested closures
        const store = ctx.store
        const obs = ctx.observability
        // 1. cache hit?
        const hit = store.get<CacheEntry<T>>(key)
        if (hit) {
          ctx.meta.source = 'cache'
          ctx.meta.attempts = 0
          if (obs) {
            const ageMs = Date.now() - hit.insertedAt
            safeCall(obs.hooks.onCacheHit, {
              type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
              timestamp: Date.now(), ageMs: Math.max(0, ageMs),
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

        // 2. in-flight single-flight hit? join it - race the shared promise
        // against OUR signal only; originator abort doesn't propagate
        const inflight = store.get<InflightEntry<T>>(inflightKey)
        if (inflight) {
          try {
            const value = await raceAbort(inflight.promise, signal)
            // mirror originator's meta so joiner's ActResult is truthful
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

        // 3. originator: launch fn, cache on success (fail-open). The stored
        // promise is RAW - originator's own await is raceAbort-wrapped so
        // they can bail without affecting joiners.
        const generation = nextGeneration()
        const rawPromise = Promise.resolve(fn(signal)).then(
          (value) => {
            try {
              store.set<CacheEntry<T>>(key, { value, insertedAt: Date.now() }, opts.ttl)
            } catch {
              // fail-open: cache write failure shouldn't surface
            }
            return value
          },
          (err) => { throw err },
        )

        // publish inflight for single-flight. If store.set throws, single-
        // flight is disabled for this call - still correct, just less
        // efficient. TTL bounds the worst-case hang from a never-settling fn.
        try {
          store.set<InflightEntry<T>>(inflightKey, { promise: rawPromise, generation, meta: ctx.meta }, LIMITS.DEFAULT_INFLIGHT_TTL)
        } catch {
          // single-flight unavailable; proceed without publishing
        }

        // generation-safe cleanup. Wrapped in try/catch so a buggy store
        // (e.g. Redis hiccup) doesn't surface as unhandledRejection - the
        // slot expires via TTL regardless.
        const cleanup = () => {
          try {
            const current = store.get<InflightEntry<T>>(inflightKey)
            if (current && current.generation === generation) {
              try { store.delete(inflightKey) } catch { /* ignore */ }
            }
          } catch {
            // custom store bug - slot expires via TTL on its own
          }
        }
        rawPromise.then(cleanup, cleanup).catch(() => { /* already handled */ })

        return raceAbort(rawPromise, signal)
      }

      // Async store: no single-flight (race window unavoidable). Re-check
      // signal.aborted between awaits.
      const obs = ctx.observability
      const hit = await ctx.store.get<CacheEntry<T>>(key)
      if (signal.aborted) return Promise.reject(signal.reason)
      if (hit) {
        ctx.meta.source = 'cache'
        ctx.meta.attempts = 0
        if (obs) {
          const ageMs = Date.now() - hit.insertedAt
          safeCall(obs.hooks.onCacheHit, {
            type: 'cache-hit', key: ctx.key, traceId: obs.traceId,
            timestamp: Date.now(), ageMs: Math.max(0, ageMs),
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
        // fail-open: see sync path
      }
      return value
    }
}
