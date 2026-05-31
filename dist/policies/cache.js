const NS = 'cache:';
/**
 * Short-circuits the entire downstream chain on a cache hit.
 * On a miss, runs fn and stores the result with TTL.
 *
 * Must be the OUTERMOST policy so a hit skips dedupe, timeout, and retry.
 */
export function cachePolicy(opts) {
    return (fn, ctx) => async () => {
        const key = NS + ctx.key;
        const hit = ctx.store.get(key);
        if (hit) {
            ctx.meta.source = 'cache';
            return hit.value;
        }
        const value = await fn();
        ctx.store.set(key, { value }, opts.ttl);
        return value;
    };
}
//# sourceMappingURL=cache.js.map