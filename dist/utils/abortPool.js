const pool = [];
const MAX_POOL_SIZE = 64;
export function acquireController() {
    while (pool.length > 0) {
        const c = pool.pop();
        if (!c.signal.aborted) {
            return c;
        }
    }
    return new AbortController();
}
export function releaseController(c) {
    if (c.signal.aborted)
        return;
    if (pool.length >= MAX_POOL_SIZE)
        return;
    pool.push(c);
}
export function poolSize() {
    return pool.length;
}
//# sourceMappingURL=abortPool.js.map