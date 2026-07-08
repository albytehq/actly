"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUIRES_SYNC_STORE = void 0;
exports.execute = execute;
const base_js_1 = require("../stores/base.js");
exports.REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore');
async function execute(input) {
    const needsSync = input.policies.some(p => p[exports.REQUIRES_SYNC_STORE]);
    if (needsSync && !(0, base_js_1.isSyncStore)(input.store)) {
        throw new Error('Actly: dedupePolicy requires a SyncStateStore (store._sync === true). ' +
            'The provided store does not satisfy this constraint. ' +
            'Either remove dedupe from the policy chain or use InMemoryStore.');
    }
    const ctx = {
        key: input.key,
        store: input.store,
        meta: input.meta,
        observability: input.observability,
    };
    const wrapped = input.policies.reduceRight((inner, applyPolicy) => applyPolicy(inner, ctx), input.fn);
    return wrapped(input.signal);
}
