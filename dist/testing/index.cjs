"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForObsHook = waitForObsHook;
exports.isActlyEventType = isActlyEventType;
function waitForObsHook(hooks, hookName, timeoutMs = 5000) {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    let settled = false;
    const timer = setTimeout(() => {
        if (settled)
            return;
        settled = true;
        hooks[hookName] = previousHook;
        rejectFn(new Error(`Actly: waitForObsHook timed out after ${timeoutMs}ms waiting for "${String(hookName)}".`));
    }, timeoutMs);
    const unrefable = timer;
    if (typeof unrefable.unref === 'function')
        unrefable.unref();
    const previousHook = hooks[hookName];
    const cleanup = () => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        hooks[hookName] = previousHook;
    };
    hooks[hookName] = (event) => {
        if (typeof previousHook === 'function') {
            try {
                previousHook(event);
            }
            catch { }
        }
        if (settled)
            return;
        cleanup();
        resolveFn(event);
    };
    return Object.assign(promise, { cancel: cleanup });
}
function isActlyEventType(value) {
    return (value === 'attempt' ||
        value === 'retry' ||
        value === 'cache-hit' ||
        value === 'cache-miss' ||
        value === 'dedupe-join' ||
        value === 'timeout' ||
        value === 'final-success' ||
        value === 'final-failure' ||
        value === 'backpressure' ||
        value === 'watchdog');
}
