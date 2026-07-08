import type { SyncStateStore } from './base.js';
export interface InMemoryStoreOptions {
    autoCleanup?: boolean;
    cleanupIntervalMs?: number;
    maxSize?: number;
    memoryPressureCleanup?: boolean;
}
export declare class InMemoryStore implements SyncStateStore {
    readonly _sync: true;
    private static finalizer;
    private readonly map;
    private readonly maxSize;
    private head?;
    private tail?;
    private cleanupTimer;
    private memoryListener;
    constructor(options?: InMemoryStoreOptions);
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    clear(): void;
    size(): number;
    destroy(): void;
    private appendTail;
    private removeNode;
    private moveToTail;
    private sweep;
}
export declare function createDefaultStore(): InMemoryStore;
//# sourceMappingURL=memory.d.ts.map