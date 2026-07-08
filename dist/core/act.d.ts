import type { ActFn, ActOptions, ActResult, AnyStateStore, SyncStateStore, AsyncStateStore } from '../types/index.js';
export declare function act<T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>;
export { HedgeTimeoutError } from '../errors.js';
export declare function invalidate(key: string): boolean;
export interface ScopedActSync {
    <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>;
    invalidate(key: string): boolean;
    readonly store: AnyStateStore;
    readonly scope: string;
}
export interface ScopedActAsync {
    <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>;
    invalidate(key: string): Promise<boolean>;
    readonly store: AnyStateStore;
    readonly scope: string;
}
export declare function withStore(store: SyncStateStore): ScopedActSync;
export declare function withStore(store: AsyncStateStore): ScopedActAsync;
export declare function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync;
//# sourceMappingURL=act.d.ts.map