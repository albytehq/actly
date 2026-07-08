import { linkSignal } from '../utils/abort.js';
import { safeCall } from '../utils/safeCall.js';
import { TimeoutError, TotalTimeoutError } from '../errors.js';
export { TimeoutError, TotalTimeoutError };
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
                safeCall(obs.hooks.onTimeout, {
                    type: 'timeout', key: ctx.key, traceId: obs.traceId,
                    timestamp: Date.now(), kind, ms: opts.ms,
                });
            }
            controller.abort(timerError);
        }, opts.ms);
        const unlink = linkSignal(parentSignal, controller);
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
export function timeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TimeoutError, 'per-attempt');
}
export function totalTimeoutPolicy(opts) {
    return makeTimeoutPolicy(opts, TotalTimeoutError, 'total');
}
