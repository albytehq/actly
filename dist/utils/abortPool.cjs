"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireController = acquireController;
exports.releaseController = releaseController;
exports.poolSize = poolSize;
const pool = [];
const MAX_POOL_SIZE = 64;
function acquireController() {
    while (pool.length > 0) {
        const c = pool.pop();
        if (!c.signal.aborted) {
            return c;
        }
    }
    return new AbortController();
}
function releaseController(c) {
    if (c.signal.aborted)
        return;
    if (pool.length >= MAX_POOL_SIZE)
        return;
    pool.push(c);
}
function poolSize() {
    return pool.length;
}
