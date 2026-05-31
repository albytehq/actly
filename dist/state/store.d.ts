import type { StateStore } from '../types/index.js';
export declare class InMemoryStore implements StateStore {
    private entries;
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    /** Drop everything. Handy in tests or for manual cache invalidation. */
    clear(): void;
    /** Count of live (non-expired) entries. */
    get size(): number;
}
//# sourceMappingURL=store.d.ts.map