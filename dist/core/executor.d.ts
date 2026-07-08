import type { ActFn, PolicyApplier, AnyStateStore, RunMeta, ObservabilityContext } from '../types/index.js';
export declare const REQUIRES_SYNC_STORE: unique symbol;
export interface ExecutorInput<T> {
    key: string;
    fn: ActFn<T>;
    policies: ReadonlyArray<PolicyApplier<T>>;
    store: AnyStateStore;
    meta: RunMeta;
    signal: AbortSignal;
    observability?: ObservabilityContext;
}
export declare function execute<T>(input: ExecutorInput<T>): Promise<T>;
//# sourceMappingURL=executor.d.ts.map