"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.anySignal = anySignal;
exports.raceAbort = raceAbort;
exports.sleep = sleep;
exports.isAbortError = isAbortError;
exports.linkSignal = linkSignal;
const NATIVE_ANY = AbortSignal.any;
function anySignal(signals) {
    const filtered = signals.filter((s) => s != null);
    if (filtered.length === 0)
        return new AbortController().signal;
    if (filtered.length === 1)
        return filtered[0];
    if (NATIVE_ANY)
        return NATIVE_ANY.call(AbortSignal, filtered);
    const controller = new AbortController();
    const listeners = [];
    for (const signal of filtered) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const onAbort = () => {
            controller.abort(signal.reason);
            for (const off of listeners)
                off();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', onAbort));
    }
    if (controller.signal.aborted) {
        for (const off of listeners)
            off();
    }
    return controller.signal;
}
function raceAbort(promise, signal) {
    if (signal.aborted) {
        promise.catch(() => { });
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
function sleep(ms, signal, opts) {
    if (ms <= 0) {
        if (signal?.aborted)
            return Promise.reject(signal.reason);
        return Promise.resolve();
    }
    if (signal?.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (opts?.unref && typeof timer.unref === 'function') {
            timer.unref();
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal?.addEventListener('abort', onAbort);
    });
}
function isAbortError(err) {
    if (err == null || typeof err !== 'object')
        return false;
    if (err.code === 'ACTLY_ABORT')
        return true;
    const name = err.name;
    if (name === 'AbortError')
        return true;
    if (name === 'TimeoutError' &&
        err instanceof Error &&
        typeof DOMException !== 'undefined' &&
        err instanceof DOMException) {
        return true;
    }
    return false;
}
function linkSignal(parent, child) {
    if (parent.aborted) {
        child.abort(parent.reason);
        return () => { };
    }
    const onAbort = () => child.abort(parent.reason);
    parent.addEventListener('abort', onAbort);
    return () => parent.removeEventListener('abort', onAbort);
}
