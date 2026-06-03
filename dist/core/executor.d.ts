import type { ActFn, PolicyApplier, AnyStateStore, RunMeta } from '../types/index.js';
export declare const REQUIRES_SYNC_STORE: unique symbol;
export interface ExecutorInput<T> {
    key: string;
    fn: ActFn<T>;
    /**
     * Policies ordered outermost -> innermost.
     * policies[0] intercepts first; policies[last] is closest to fn.
     *
     * Canonical order: [totalTimeout, cache, dedupe, retry, timeout]
     *   totalTimeout -> hard wall-clock budget over the entire operation
     *   cache        -> a hit skips everything below it
     *   dedupe       -> collapses concurrent callers before retry fires
     *   retry        -> owns the attempt loop
     *   timeout      -> each individual attempt races against the clock
     */
    policies: ReadonlyArray<PolicyApplier<T>>;
    store: AnyStateStore;
    meta: RunMeta;
}
/**
 * Pure execution engine.
 *
 * This file imports nothing from /policies.
 * It operates on PolicyApplier<T> — a type alias defined in /types.
 * Policy implementations live in /policies and are wired in core/act.ts.
 */
export declare function execute<T>(input: ExecutorInput<T>): Promise<T>;
//# sourceMappingURL=executor.d.ts.map