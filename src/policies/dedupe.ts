import type { ActFn, PolicyApplier, PolicyContext, DedupeOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { raceAbort } from '../utils/abort.js'
import { safeCall } from '../utils/safeCall.js'
import { LIMITS } from '../utils/limits.js'

// Namespace so dedupe keys never collide with cache keys in the shared store.
const NS = 'dedupe:'

/**
 * What we store: the in-flight promise (so joiners await the same one), the
 * originator's `meta` (so joiners read the real attempt count after settle),
 * and a generation token (so stale cleanup doesn't clobber a newer entry).
 *
 * The stored `promise` is the RAW `fn(signal)` - NOT raceAbort-wrapped. So
 * if the originator's signal aborts, their own await rejects (via the
 * raceAbort wrapper in the originator path) but the stored promise keeps
 * running for joiners. Each caller's cancellation stays isolated.
 */
interface DedupeEntry<T> {
  /** Raw fn() promise - joiners await this directly. */
  promise: Promise<T>
  /** Originator's meta - joiners copy `attempts`/`source` from it. */
  meta: PolicyContext['meta']
  /** Generation token - stale cleanup checks this before deleting. */
  generation: number
}

// PolicyContext uses AnyStateStore, but dedupe requires synchronous access.
// Narrow here so the executor can pass the same ctx to all policies.
type DedupeContext = Omit<PolicyContext, 'store'> & { store: SyncStateStore }

/**
 * Monotonic generation counter. Wraps at Number.MAX_SAFE_INTEGER
 * (~285 000 years at 1M increments/sec).
 */
let generationCounter = 0

function nextGeneration(): number {
  generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER
  return generationCounter
}

/**
 * Collapse concurrent calls sharing the same key into one in-flight Promise.
 *
 * Stale originators never delete newer entries (generation-safe cleanup).
 * Originator's caller-signal abort doesn't propagate to joiners - each
 * joiner races the shared promise against their OWN signal. Joiners that
 * abort before the originator settles report `attempts: 0` (they did no
 * work).
 *
 * Requires a SyncStateStore: the read-then-write must happen in a single
 * synchronous frame, or two concurrent callers could both see a miss and
 * both launch work. The `REQUIRES_SYNC_STORE` symbol lets `execute()`
 * enforce this at runtime for JS callers that bypass TypeScript.
 */
export function dedupePolicy<T>(opts: DedupeOptions = { enabled: true }): PolicyApplier<T> {
  // Default to a bounded inflightTtl. Infinity meant a single hung fn would
  // block all subsequent callers on that key forever. 5 minutes bounds the
  // worst-case hang while staying generous. Pass `inflightTtl: Infinity`
  // explicitly to restore the old behaviour.
  const inflightTtl = opts.inflightTtl ?? LIMITS.DEFAULT_INFLIGHT_TTL

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    // cast is safe: execute() verifies isSyncStore(ctx.store) first
    const syncCtx = ctx as DedupeContext

    return async (signal: AbortSignal) => {
      const key = NS + syncCtx.key

      // ─── Fast path: an in-flight promise already exists. Join it. ──────
      //
      // The joiner races the in-flight promise against THEIR OWN signal.
      // They don't inherit the originator's signal state - if the
      // originator's caller cancels, joiners keep waiting.
      const existing = syncCtx.store.get<DedupeEntry<T>>(key)
      if (existing) {
        // joiner position is approximated by a per-call counter on the obs ctx
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
          // copy originator's final meta so joiner's ActResult is truthful
          syncCtx.meta.attempts = existing.meta.attempts
          syncCtx.meta.source   = existing.meta.source
          return value
        } catch (err) {
          if (signal.aborted) {
            // joiner bailed before originator settled - did no work
            syncCtx.meta.attempts = 0
          } else {
            // originator settled with failure - copy its final meta
            syncCtx.meta.attempts = existing.meta.attempts
            syncCtx.meta.source   = existing.meta.source
          }
          throw err
        }
      }

      // ─── Originator path: start the work and publish the promise. ──────
      //
      // The stored promise is RAW fn(signal) - NOT raceAbort-wrapped. If
      // we stored raceAbort(fn, signal), an originator signal abort would
      // reject the stored promise and propagate to all joiners. Instead:
      //   - stored: raw fn(signal) - joiners await this
      //   - originator's await: raceAbort(stored, signal) - can bail out
      //     without affecting joiners
      const generation = nextGeneration()
      const rawPromise = Promise.resolve(fn(signal))

      const entry: DedupeEntry<T> = {
        promise: rawPromise,
        meta: syncCtx.meta,
        generation,
      }
      syncCtx.store.set<DedupeEntry<T>>(key, entry, inflightTtl)

      // Only delete if generation matches - if a newer originator has
      // replaced this entry (inflightTtl expired), our cleanup is a no-op.
      // Wrapped in try/catch so a buggy store doesn't surface as
      // unhandledRejection - the entry expires via TTL regardless.
      const cleanup = () => {
        try {
          const current = syncCtx.store.get<DedupeEntry<T>>(key)
          if (current && current.generation === generation) {
            syncCtx.store.delete(key)
          }
        } catch {
          // custom store bug - entry expires via TTL on its own
        }
      }
      // attach to the RAW promise so cleanup runs whenever fn settles,
      // regardless of originator abort
      rawPromise.then(cleanup, cleanup).catch(() => { /* already handled */ })

      return raceAbort(rawPromise, signal)
    }
  }

  // Tag so execute() can detect this policy without importing it.
  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true

  return applier
}
