"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
/**
 * Pure execution engine.
 *
 * This file imports nothing from /policies.
 * It operates on PolicyApplier<T> — a type alias defined in /types.
 * Policy implementations live in /policies and are wired in core/act.ts.
 */
async function execute(input) {
    const ctx = {
        key: input.key,
        store: input.store,
        meta: input.meta,
    };
    // Build the call chain from inside out.
    // reduceRight ensures policies[0] becomes the outermost wrapper (runs first).
    const wrapped = input.policies.reduceRight((inner, applyPolicy) => applyPolicy(inner, ctx), input.fn);
    return wrapped();
}
