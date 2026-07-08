import { isSyncStore } from '../stores/base.js';
export const REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore');
export async function execute(input) {
    const needsSync = input.policies.some(p => p[REQUIRES_SYNC_STORE]);
    if (needsSync && !isSyncStore(input.store)) {
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
