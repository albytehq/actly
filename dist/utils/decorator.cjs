"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePolicy = usePolicy;
function usePolicy(options) {
    return function (_target, propertyKey, descriptor) {
        if (!descriptor || !descriptor.value) {
            throw new Error(`Actly: @usePolicy can only be applied to methods with a function value. ` +
                `Got descriptor without value for property "${String(propertyKey)}".`);
        }
        const originalMethod = descriptor.value;
        let actPromise;
        const getAct = () => {
            if (!actPromise)
                actPromise = Promise.resolve().then(() => require('../core/act.js')).then(m => m.act);
            return actPromise;
        };
        const wrappedMethod = async function (...args) {
            const act = await getAct();
            const ctorName = this?.constructor?.name ?? 'Anonymous';
            const key = `${ctorName}.${String(propertyKey)}`;
            const firstArg = args[0];
            const isSignal = firstArg != null &&
                typeof firstArg === 'object' &&
                typeof firstArg.aborted === 'boolean' &&
                typeof firstArg.addEventListener === 'function';
            const signal = isSignal ? firstArg : undefined;
            const fnArgs = signal ? args.slice(1) : args;
            const result = await act(key, async (actSignal) => originalMethod.apply(this, [actSignal, ...fnArgs]), signal ? { ...options, signal } : options);
            if (result.ok)
                return result.value;
            throw result.error;
        };
        try {
            Object.defineProperty(wrappedMethod, 'name', {
                value: typeof propertyKey === 'symbol' ? propertyKey.description ?? 'wrapped' : propertyKey,
                configurable: true,
            });
        }
        catch {
        }
        descriptor.value = wrappedMethod;
        return descriptor;
    };
}
