"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDrainable = registerDrainable;
exports.unregisterDrainable = unregisterDrainable;
exports.drain = drain;
const drainStates = new Map();
function getState(scope) {
    let s = drainStates.get(scope);
    if (!s) {
        s = { inflight: 0, resolvers: [] };
        drainStates.set(scope, s);
    }
    return s;
}
function registerDrainable(scope = 'default') {
    getState(scope).inflight++;
}
function unregisterDrainable(scope = 'default') {
    const s = getState(scope);
    s.inflight = Math.max(0, s.inflight - 1);
    if (s.inflight === 0) {
        for (const r of s.resolvers)
            r();
        s.resolvers = [];
    }
}
/**
 * Wait for all in-flight act() calls in this scope to settle.
 * Returns true if all settled within timeoutMs, false if timed out.
 */
async function drain(timeoutMs, scope = 'default') {
    const s = getState(scope);
    if (s.inflight === 0)
        return true;
    return new Promise((resolve) => {
        let resolved = false;
        const resolver = () => {
            if (resolved)
                return;
            resolved = true;
            clearTimeout(timer);
            // Remove this resolver from the array
            const idx = s.resolvers.indexOf(resolver);
            if (idx >= 0)
                s.resolvers.splice(idx, 1);
            resolve(true);
        };
        const timer = setTimeout(() => {
            if (resolved)
                return;
            resolved = true;
            // Remove this resolver from the array on timeout
            const idx = s.resolvers.indexOf(resolver);
            if (idx >= 0)
                s.resolvers.splice(idx, 1);
            resolve(false);
        }, timeoutMs);
        s.resolvers.push(resolver);
    });
}
