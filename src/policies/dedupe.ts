import type { ActFn, PolicyApplier, PolicyContext, DedupeOptions } from '../types.js'
import type { SyncStateStore } from '../stores/contract.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { raceAbort } from '../abort.js'
import { safeCall } from '../safeCall.js'
import { assertDedupeOptions } from '../validate.js'
import { LIMITS } from '../limits.js'

const NS = 'dedupe:'

/**
 * Stored per key: the raw in-flight promise (joiners await it directly, so
 * the originator's abort does not propagate to them), the originator's meta
 * (joiners copy attempts/source after settle), and a generation token so
 * stale cleanup cannot delete a newer entry.
 */
interface DedupeEntry<T> {
  promise: Promise<T>
  meta: PolicyContext['meta']
  generation: number
}

type DedupeContext = Omit<PolicyContext, 'store'> & { store: SyncStateStore }

let generationCounter = 0
function nextGeneration(): number {
  generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER
  return generationCounter
}

/**
 * Collapse concurrent calls sharing the same key into one in-flight promise.
 * Requires a SyncStateStore: the read-then-write must happen in one
 * synchronous frame or two callers could both miss and both launch work.
 * `REQUIRES_SYNC_STORE` lets `execute()` enforce this for JS callers.
 *
 * `{ enabled: false }` degrades to a pass-through (since 1.4; previously
 * the flag was only honoured on the `act()` path).
 *
 * Options are validated at construction (since 1.4): a non-finite
 * `inflightTtl` would otherwise fall through to the store's "never
 * expires" branch and pin the key forever — the opposite of the
 * near-immediate expiry the caller asked for.
 */
export function dedupePolicy<T>(opts: DedupeOptions = { enabled: true }): PolicyApplier<T> {
  assertDedupeOptions(opts)
  if (opts && opts.enabled === false) {
    return (fn: ActFn<T>, _ctx: PolicyContext): ActFn<T> => fn
  }

  // Bounded by default: a single hung fn would otherwise block the key
  // forever. `inflightTtl: Infinity` opts back into the old behaviour.
  const inflightTtl = opts.inflightTtl ?? LIMITS.DEFAULT_INFLIGHT_TTL

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as DedupeContext

    return async (signal: AbortSignal) => {
      const key = NS + syncCtx.key

      // Fast path: join the in-flight promise, racing it against THIS
      // caller's own signal only.
      const existing = syncCtx.store.get<DedupeEntry<T>>(key)
      if (existing) {
        const obs = syncCtx.observability
        if (obs) {
          obs.joinerCounter++
          safeCall(obs.hooks.onDedupeJoin, {
            type: 'dedupe-join', key: syncCtx.key, traceId: obs.traceId,
            timestamp: Date.now(), joinerPosition: obs.joinerCounter,
          })
        }
        try {
          const value = await raceAbort(existing.promise, signal)
          syncCtx.meta.attempts = existing.meta.attempts
          syncCtx.meta.source   = existing.meta.source
          return value
        } catch (err) {
          if (signal.aborted) {
            // joiner bailed before the originator settled; it did no work
            syncCtx.meta.attempts = 0
          } else {
            syncCtx.meta.attempts = existing.meta.attempts
            syncCtx.meta.source   = existing.meta.source
          }
          throw err
        }
      }

      // Originator: publish the RAW fn(signal). The originator's own await
      // is raceAbort-wrapped below, so it can bail without affecting joiners.
      const generation = nextGeneration()
      const rawPromise = Promise.resolve(fn(signal))

      syncCtx.store.set<DedupeEntry<T>>(key, { promise: rawPromise, meta: syncCtx.meta, generation }, inflightTtl)

      // Delete only when the generation still matches; a buggy store is
      // swallowed here since the TTL reclaims the entry regardless.
      const cleanup = () => {
        try {
          const current = syncCtx.store.get<DedupeEntry<T>>(key)
          if (current && current.generation === generation) {
            syncCtx.store.delete(key)
          }
        } catch {
          // entry expires via TTL
        }
      }
      rawPromise.then(cleanup, cleanup).catch(() => { /* handled by awaiter */ })

      return raceAbort(rawPromise, signal)
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
