import type { ScopedActSync, ScopedActAsync } from './act.js';
import type { AsyncStateStore } from '../stores/base.js';
export interface TenantStoreOptions {
    maxSize?: number;
    autoCleanup?: boolean;
    cleanupIntervalMs?: number;
}
export interface TenantManager {
    get(tenantId: string): ScopedActSync | ScopedActAsync;
    evict(tenantId: string): void;
    size(): number;
    destroy(): void;
}
/**
 * Manages per-tenant stores for multi-tenant isolation.
 * Each tenant gets its own InMemoryStore — cache/dedupe entries
 * cannot leak across tenants.
 */
export declare function createTenantStore(options?: TenantStoreOptions): TenantManager;
/**
 * Async tenant manager for async stores (Redis, DynamoDB, etc).
 * Each tenant gets its own store instance with prefixed keys.
 */
export declare function createAsyncTenantStore(storeFactory: (tenantId: string) => AsyncStateStore): {
    get: (tenantId: string) => ScopedActAsync;
    evict: (tenantId: string) => void;
    size: () => number;
};
//# sourceMappingURL=tenant.d.ts.map