"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDrainable = registerDrainable;
exports.unregisterDrainable = unregisterDrainable;
exports.drain = drain;
exports.drainAll = drainAll;
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
        if (scope !== 'default') {
            drainStates.delete(scope);
        }
    }
}
async function drain(timeoutMs, scope = 'default') {
    const s = drainStates.get(scope);
    if (!s)
        return true;
    if (s.inflight === 0) {
        if (scope !== 'default' && s.resolvers.length === 0) {
            drainStates.delete(scope);
        }
        return true;
    }
    return new Promise((resolve) => {
        let resolved = false;
        const resolver = () => {
            if (resolved)
                return;
            resolved = true;
            clearTimeout(timer);
            const idx = s.resolvers.indexOf(resolver);
            if (idx >= 0)
                s.resolvers.splice(idx, 1);
            resolve(true);
        };
        const timer = setTimeout(() => {
            if (resolved)
                return;
            resolved = true;
            const idx = s.resolvers.indexOf(resolver);
            if (idx >= 0)
                s.resolvers.splice(idx, 1);
            resolve(false);
        }, timeoutMs);
        s.resolvers.push(resolver);
    });
}
async function drainAll(timeoutMs) {
    const scopes = Array.from(drainStates.keys());
    if (scopes.length === 0)
        return true;
    const results = await Promise.all(scopes.map(scope => drain(timeoutMs, scope)));
    return results.every(r => r === true);
}
