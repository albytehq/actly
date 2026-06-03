import type { CacheOptions, PolicyApplier } from '../types/index.js';
/**
 * Short-circuits the entire downstream chain on a cache hit.
 * On a miss, runs fn and stores the result with TTL.
 *
 * Must be the OUTERMOST policy so a hit skips dedupe, timeout, and retry.
 *
 * Supports both SyncStateStore and AsyncStateStore. The async branch
 * introduces two await points (get + set) but has no correctness
 * requirement for same-tick execution — worst case is a cache stampede
 * on a simultaneous miss, which is standard behaviour without locking.
 */
export declare function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T>;
//# sourceMappingURL=cache.d.ts.map