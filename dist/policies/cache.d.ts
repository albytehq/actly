import type { CacheOptions, PolicyApplier } from '../types/index.js';
/**
 * Short-circuit the entire downstream chain on a cache hit.
 * On a miss, run `fn` and store the result with TTL.
 *
 * # Properties
 *
 *  - **Single-flight originator isolation**: the stored in-flight promise is
 *    the RAW `fn(signal)` — NOT raceAbort-wrapped. An originator's signal
 *    abort no longer causes all cache-miss joiners to reject. Each caller
 *    races against their OWN signal only.
 *  - **Generation-safe inflight cleanup**: stale originators don't delete
 *    newer entries (same pattern as dedupePolicy).
 *  - **Signal-aware async store path**: between `await store.get()` and
 *    `await store.set()`, we re-check `signal.aborted`. The previous
 *    version would happily return a cached value even after the caller
 *    aborted mid-Redis-latency.
 *  - **Cache hit honours abort**: if `signal.aborted` is true at policy
 *    entry, we reject immediately — consistent with `act()`'s contract.
 *
 * # Single-flight (cache stampede prevention)
 *
 * On a sync store, the policy also stores the in-flight Promise under a
 * separate `__inflight:cache:<key>` slot. Concurrent callers that miss the
 * cache but find an in-flight Promise join it instead of launching duplicate
 * work. This is the same mechanism `dedupePolicy` uses, applied internally
 * to cache misses so users don't need to combine `cache` + `dedupe` to
 * avoid stampedes.
 *
 * On an async store, single-flight is not possible (the same sync-store
 * constraint as dedupe applies). Stampedes are a known limitation — document
 * and pair with dedupe at a higher layer if you need single-flight semantics.
 *
 * # Fail-open writes
 *
 * If `store.set()` throws (e.g. Redis transient error), we swallow the error
 * and return the value anyway. The caller gets their result; the next call
 * will simply re-run `fn` and try to cache again. Caching is an optimisation,
 * not a correctness requirement.
 *
 * # Cache hit semantics
 *
 * On a cache hit, `meta.source` is set to `'cache'` and `meta.attempts` is
 * set to `0` — no work was performed.
 *
 * Failures are NEVER cached. Only successful values are stored.
 */
export declare function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T>;
//# sourceMappingURL=cache.d.ts.map