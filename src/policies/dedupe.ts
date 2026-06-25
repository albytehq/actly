import type { ActFn, PolicyApplier, PolicyContext, DedupeOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { raceAbort } from '../utils/abort.js'

// Namespace so dedupe keys never collide with cache keys in the shared store.
const NS = 'dedupe:'

// What we store: the in-flight promise (so joiners can await the same one)
// plus a reference to the originator's `meta` (so joiners can read the
// real attempt count after the promise settles).
interface DedupeEntry<T> {
  promise: Promise<T>
  meta:    PolicyContext['meta']
}

// PolicyContext uses AnyStateStore, but dedupe requires synchronous access.
// We narrow via intersection here rather than changing the shared context
// type, so the executor can pass the same ctx object to all policies.
type DedupeContext = Omit<PolicyContext, 'store'> & { store: SyncStateStore }

/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # How it works
 *
 * The first caller (originator) starts the work and stores
 * `{ promise, meta }` in the store under `dedupe:<key>`. Every subsequent
 * caller that arrives before the promise settles receives the SAME promise
 * — no duplicate work.
 *
 * # Shared `meta` (fixes v1.0 trade-off)
 *
 * The originator's `ctx.meta` reference is stored alongside the promise.
 * Inner policies (e.g. `retryPolicy`) mutate it as they run. After the
 * promise settles, joiners copy `attempts` and `source` from the shared
 * meta into their own `ctx.meta`. This means a joiner's `ActResult.attempts`
 * reflects the real effort (e.g. `3` if the originator retried twice), not
 * the misleading default of `1`.
 *
 * # Abort safety (fixes hung-fn block)
 *
 * Joiners race the in-flight promise against their own AbortSignal via
 * `raceAbort`. If a joiner's signal aborts (e.g. their `totalTimeout`
 * fires), they reject immediately — they don't have to wait for the
 * originator to finish. The originator's promise continues in the
 * background for any other joiners that haven't aborted.
 *
 * If `inflightTtl` is set, the store entry is also TTL'd: if the
 * originator never settles, new callers can start fresh after the TTL
 * expires (the original promise still leaks unless an outer timeout
 * fires, but new callers aren't blocked).
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

      // Fast path: an in-flight promise already exists. Join it.
      // raceAbort ensures we don't block on a hung originator if our own
      // signal aborts.
      const existing = syncCtx.store.get<DedupeEntry<T>>(key)
      if (existing) {
        try {
          const value = await raceAbort(existing.promise, signal)
          return value
        } finally {
          // Copy the originator's final meta into our own, regardless of
          // success or failure. By the time `existing.promise` has settled
          // (or our signal aborted), the originator's retry loop has set
          // the final attempt count.
          syncCtx.meta.attempts = existing.meta.attempts
          syncCtx.meta.source   = existing.meta.source
        }
      }

      // Originator path: start the work and publish the promise.
      //
      // We race fn against `signal` so that if our own signal aborts while
      // fn is pending, we reject (and the .finally cleans up the store).
      // The stored promise is the RACED one — joiners see the same
      // rejection if they join before cleanup.
      const promise = raceAbort(
        Promise.resolve(fn(signal)),
        signal,
      ).finally(() => syncCtx.store.delete(key))

      const entry: DedupeEntry<T> = { promise, meta: syncCtx.meta }
      syncCtx.store.set<DedupeEntry<T>>(key, entry, inflightTtl)
      return promise
    }
  }

  // Tag so execute() can detect this policy without importing it.
  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true

  return applier
}
