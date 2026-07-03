import type { ActFn, PolicyApplier, AnyStateStore, RunMeta, ObservabilityContext } from '../types/index.js';
/**
 * Symbol stamped onto `PolicyApplier` functions by `dedupePolicy`.
 *
 * Lets `execute()` detect a dedupe policy without importing the policy
 * module (which would create a circular dep) or doing fragile name-sniffing.
 */
export declare const REQUIRES_SYNC_STORE: unique symbol;
export interface ExecutorInput<T> {
    key: string;
    fn: ActFn<T>;
    /**
     * Policies ordered outermost -> innermost.
     * `policies[0]` intercepts first; `policies[last]` is closest to `fn`.
     *
     * Canonical order: `[totalTimeout, cache, dedupe, retry, timeout]`
     *   totalTimeout -> hard wall-clock budget over the entire operation
     *   cache        -> a hit skips everything below it
     *   dedupe       -> collapses concurrent callers before retry fires
     *   retry        -> owns the attempt loop
     *   timeout      -> each individual attempt races against the clock
     */
    policies: ReadonlyArray<PolicyApplier<T>>;
    store: AnyStateStore;
    meta: RunMeta;
    /**
     * Root AbortSignal for the operation. Propagated inward through the
     * policy chain: each policy receives it as the `signal` argument to
     * its wrapped `ActFn`. The outermost policy may layer its own signal
     * (e.g. `totalTimeoutPolicy` arms a timer) and pass the composite
     * inward.
     */
    signal: AbortSignal;
    /**
     * Observability context. When present, policies emit events
     * via the hooks. When absent (the common case), zero overhead.
     */
    observability?: ObservabilityContext;
}
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
export declare function execute<T>(input: ExecutorInput<T>): Promise<T>;
//# sourceMappingURL=executor.d.ts.map