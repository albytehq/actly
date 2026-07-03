import type { ActFn, PolicyApplier, PolicyContext, DedupeOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { raceAbort } from '../utils/abort.js'

// Namespace so dedupe keys never collide with cache keys in the shared store.
const NS = 'dedupe:'

/**
 * What we store: the in-flight promise (so joiners can await the same one)
 * plus a reference to the originator's `meta` (so joiners can read the
 * real attempt count after the promise settles) plus a generation token
 * (so stale cleanup doesn't clobber a newer entry).
 *
 * # Generation token
 *
 * When `inflightTtl` expires and a new originator starts, the old
 * originator's `.finally()` would otherwise delete the new entry. The
 * generation token ensures stale cleanup is a no-op when the entry has
 * been replaced.
 *
 * # Promise semantics
 *
 * The stored `promise` is the RAW `fn(signal)` — NOT `raceAbort(fn, signal)`.
 * This means:
 *  - If the originator's signal aborts (their `totalTimeout` fires, their
 *    caller cancels), the originator's OWN `await` rejects (via the
 *    `raceAbort` wrapper in the originator path), but the stored promise
 *    continues running for joiners.
 *  - Joiners only reject when their OWN signal aborts, or when the
 *    originator's fn settles (success/failure propagates to all joiners).
 *
 * This isolates each caller's cancellation from the others — originator
 * cancellation never leaks into joiners.
 */
interface DedupeEntry<T> {
  /** Raw fn() promise — joiners await this directly. */
  promise: Promise<T>
  /** Originator's meta — joiners copy `attempts`/`source` from it. */
  meta: PolicyContext['meta']
  /** Generation token — stale cleanup checks this before deleting. */
  generation: number
}

// PolicyContext uses AnyStateStore, but dedupe requires synchronous access.
// We narrow via intersection here rather than changing the shared context
// type, so the executor can pass the same ctx object to all policies.
type DedupeContext = Omit<PolicyContext, 'store'> & { store: SyncStateStore }

/**
 * Module-level generation counter. Monotonic — guarantees uniqueness
 * across the lifetime of the process. Wraps at `Number.MAX_SAFE_INTEGER`
 * (which would take ~285 000 years at 1M increments/sec).
 */
let generationCounter = 0

function nextGeneration(): number {
  generationCounter = (generationCounter + 1) % Number.MAX_SAFE_INTEGER
  return generationCounter
}

/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # Properties
 *
 *  - **Generation-safe cleanup**: stale originators never delete newer
 *    entries when `inflightTtl` triggers replacement.
 *  - **Joiner isolation**: originator's caller-signal abort does NOT
 *    propagate to joiners. Each joiner races the shared in-flight promise
 *    against their OWN signal only.
 *  - **Truthful joiner attempts**: joiners that abort before the originator
 *    settles report `attempts: 0` (they did no work), not the originator's
 *    in-progress count.
 *
 * # INVARIANT: requires SyncStateStore
 *
 * The read-then-write that makes deduplication work must happen in a single
 * synchronous frame. An async store would introduce an `await` between
 * `get()` and `set()`, letting two concurrent callers both see a miss and
 * both launch work. The `REQUIRES_SYNC_STORE` symbol on the returned
 * `PolicyApplier` lets `execute()` enforce this at runtime for JS callers
 * that bypass TypeScript.
 */
export function dedupePolicy<T>(opts: DedupeOptions = { enabled: true }): PolicyApplier<T> {
  const inflightTtl = opts.inflightTtl

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    // Cast is safe: execute() verifies isSyncStore(ctx.store) before calling
    // any policy tagged with REQUIRES_SYNC_STORE.
    const syncCtx = ctx as DedupeContext

    return async (signal: AbortSignal) => {
      const key = NS + syncCtx.key

      // ─── Fast path: an in-flight promise already exists. Join it. ──────
      //
      // The joiner races the in-flight promise against THEIR OWN signal.
      // They do NOT inherit the originator's signal state — if the
      // originator's caller cancels, joiners continue waiting (or get
      // the eventual settled value).
      const existing = syncCtx.store.get<DedupeEntry<T>>(key)
      if (existing) {
        try {
          const value = await raceAbort(existing.promise, signal)
          // Success — copy originator's final meta (attempts, source)
          // so the joiner's ActResult reflects the real effort.
          syncCtx.meta.attempts = existing.meta.attempts
          syncCtx.meta.source   = existing.meta.source
          return value
        } catch (err) {
          // Joiner either aborted (their own signal) or got the
          // originator's settled error.
          if (signal.aborted) {
            // Joiner's own signal aborted before originator settled.
            // They did no work — report `attempts: 0` (truthful).
            syncCtx.meta.attempts = 0
            // source stays 'fresh' (default) — joiner didn't read from cache
          } else {
            // Originator settled with failure — copy its final meta.
            syncCtx.meta.attempts = existing.meta.attempts
            syncCtx.meta.source   = existing.meta.source
          }
          throw err
        }
      }

      // ─── Originator path: start the work and publish the promise. ──────
      //
      // The stored promise is the RAW fn(signal) — NOT raceAbort-wrapped.
      // This is critical: if we stored raceAbort(fn, signal), an
      // originator signal abort would cause the stored promise to reject,
      // which would propagate to all joiners. Instead:
      //   - stored: raw fn(signal) — joiners await this
      //   - originator's await: raceAbort(stored, signal) — originator
      //     can bail out on their own signal without affecting joiners
      const generation = nextGeneration()
      const rawPromise = Promise.resolve(fn(signal))

      const entry: DedupeEntry<T> = {
        promise: rawPromise,
        meta: syncCtx.meta,
        generation,
      }
      syncCtx.store.set<DedupeEntry<T>>(key, entry, inflightTtl)

      // Cleanup on settle: only delete if generation matches. If a newer
      // originator has replaced this entry (because inflightTtl expired),
      // our cleanup is a no-op — the newer entry stays.
      const cleanup = () => {
        const current = syncCtx.store.get<DedupeEntry<T>>(key)
        if (current && current.generation === generation) {
          syncCtx.store.delete(key)
        }
      }
      // Attach cleanup to the RAW promise (not the raceAbort-wrapped one)
      // so cleanup runs whenever fn settles, regardless of originator abort.
      rawPromise.then(cleanup, cleanup)

      // Originator races the raw promise against their own signal —
      // they can bail out without affecting joiners.
      return raceAbort(rawPromise, signal)
    }
  }

  // Tag so execute() can detect this policy without importing it.
  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true

  return applier
}
