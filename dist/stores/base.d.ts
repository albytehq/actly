export interface SyncStateStore {
    readonly _sync: true;
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    deleteIfExists?(key: string): boolean;
    clear(): void;
    size(): number;
    destroy?(): void;
}
export interface AsyncStateStore {
    readonly _sync: false;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    deleteIfExists?(key: string): Promise<boolean>;
    clear(): Promise<void>;
    size(): Promise<number>;
    destroy?(): void | Promise<void>;
}
export declare function isSyncStore(store: SyncStateStore | AsyncStateStore): store is SyncStateStore;
export declare function isAsyncStore(store: SyncStateStore | AsyncStateStore): store is AsyncStateStore;
//# sourceMappingURL=base.d.ts.map