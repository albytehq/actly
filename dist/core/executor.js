import { isSyncStore } from '../stores/base.js';
/**
 * Symbol stamped onto `PolicyApplier` functions by `dedupePolicy`.
 *
 * Lets `execute()` detect a dedupe policy without importing the policy
 * module (which would create a circular dep) or doing fragile name-sniffing.
 */
export const REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore');
/**
 * Pure execution engine.
 *
 * This file imports nothing from `/policies`. It operates on `PolicyApplier<T>`
 * — a type alias defined in `/types`. Policy implementations live in
 * `/policies` and are wired in `core/act.ts`.
 *
 * # Public API
 *
 * Exported so consumers can build custom policy chains with explicit stores
 * (e.g. for SSR request isolation or multi-tenant scenarios where the
 * module-level default store is wrong).
 */
export async function execute(input) {
    // Guard: if any policy in the chain requires a sync store, the provided
    // store must be synchronous. An async store + dedupePolicy is a silent
    // correctness failure — catch it here rather than letting it produce
    // subtly wrong dedupe behaviour at runtime.
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
        // Thread observability through. Policies read this lazily.
        observability: input.observability,
    };
    // Build the call chain from inside out.
    // reduceRight ensures policies[0] becomes the outermost wrapper (runs first).
    const wrapped = input.policies.reduceRight((inner, applyPolicy) => applyPolicy(inner, ctx), input.fn);
    // Call the outermost wrapper with the root signal.
    return wrapped(input.signal);
}
//# sourceMappingURL=executor.js.map