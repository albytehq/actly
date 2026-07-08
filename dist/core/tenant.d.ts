import type { ScopedActSync, ScopedActAsync } from './act.js';
import type { AsyncStateStore } from '../stores/base.js';
export interface TenantStoreOptions {
    maxSize?: number;
    autoCleanup?: boolean;
    cleanupIntervalMs?: number;
    maxTenants?: number;
}
export interface TenantManager {
    get(tenantId: string): ScopedActSync | ScopedActAsync;
    evict(tenantId: string): void;
    size(): number;
    destroy(): void;
}
export declare function createTenantStore(options?: TenantStoreOptions): TenantManager;
export declare function createAsyncTenantStore(storeFactory: (tenantId: string) => AsyncStateStore, options?: {
    maxTenants?: number;
}): {
    get: (tenantId: string) => ScopedActAsync;
    evict: (tenantId: string) => void;
    size: () => number;
    destroy: () => void;
};
//# sourceMappingURL=tenant.d.ts.map