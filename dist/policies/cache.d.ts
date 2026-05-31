import type { CacheOptions, PolicyApplier } from '../types/index.js';
/**
 * Short-circuits the entire downstream chain on a cache hit.
 * On a miss, runs fn and stores the result with TTL.
 *
 * Must be the OUTERMOST policy so a hit skips dedupe, timeout, and retry.
 */
export declare function cachePolicy<T>(opts: CacheOptions): PolicyApplier<T>;
//# sourceMappingURL=cache.d.ts.map