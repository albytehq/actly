const IS_DEV = typeof process !== 'undefined' &&
    typeof process.env === 'object' &&
    process.env !== null &&
    process.env.NODE_ENV !== 'production';
export function safeCall(fn, ...args) {
    if (!fn)
        return;
    try {
        const result = fn(...args);
        if (result !== null && result !== undefined && typeof result.then === 'function') {
            Promise.resolve(result).catch((err) => {
                if (IS_DEV) {
                    console.warn('Actly: async observability hook rejected — error swallowed to protect main path. ' +
                        'Fix the hook to prevent silent observability loss.', err);
                }
            });
        }
    }
    catch (err) {
        if (IS_DEV) {
            console.warn('Actly: observability hook threw — error swallowed to protect main path. ' +
                'Fix the hook to prevent silent observability loss.', err);
        }
    }
}
