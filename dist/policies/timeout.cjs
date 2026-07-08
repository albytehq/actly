"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalTimeoutError = exports.TimeoutError = void 0;
exports.timeoutPolicy = timeoutPolicy;
exports.totalTimeoutPolicy = totalTimeoutPolicy;
const abort_js_1 = require("../utils/abort.js");
const safeCall_js_1 = require("../utils/safeCall.js");
const errors_js_1 = require("../errors.js");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return errors_js_1.TimeoutError; } });
Object.defineProperty(exports, "TotalTimeoutError", { enumerable: true, get: function () { return errors_js_1.TotalTimeoutError; } });
function makeTimeoutPolicy(opts, errorCtor, kind) {
    const strategy = opts.strategy ?? 'race';
    return (fn, ctx) => async (parentSignal) => {
        const controller = new AbortController();
        const timerError = new errorCtor(opts.ms, { key: ctx.key });
        const obs = ctx.observability;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (obs) {
                (0, safeCall_js_1.safeCall)(obs.hooks.onTimeout, {
                    type: 'timeout', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(), kind, ms: opts.ms,
                });
            }
            controller.abort(timerError);
        }, opts.ms);
        const unlink = (0, abort_js_1.linkSignal)(parentSignal, controller);
        try {
            if (strategy === 'cooperative') {
                if (parentSignal.aborted) {
                    throw parentSignal.reason;
                }
                try {
                    const value = await fn(controller.signal);
                    return value;
                }
                catch (err) {
                    if (timedOut)
                        throw timerError;
                    throw err;
                }
            }
            return await new Promise((resolve, reject) => {
                if (controller.signal.aborted) {
                    reject(controller.signal.reason);
                    return;
                }
                const onAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve(fn(controller.signal)).then((value) => {
                    controller.signal.removeEventListener('abort', onAbort);
                    resolve(value);
                }, (error) => {
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(error);
                });
            });
        }
        finally {
            clearTimeout(timer);
            unlink();
        }
    };
}
function timeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, errors_js_1.TimeoutError, 'per-attempt');
}
function totalTimeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, errors_js_1.TotalTimeoutError, 'total');
}
