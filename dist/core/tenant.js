import { InMemoryStore } from '../stores/memory.js';
import { withStore } from './act.js';
import { LIMITS } from '../utils/limits.js';
export function createTenantStore(options = {}) {
    const maxSize = options.maxSize ?? LIMITS.DEFAULT_STORE_MAX_SIZE;
    const autoCleanup = options.autoCleanup ?? true;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    const maxTenants = options.maxTenants ?? LIMITS.MAX_TENANTS;
    const tenants = new Map();
    return {
        get(tenantId) {
            let entry = tenants.get(tenantId);
            if (entry) {
                tenants.delete(tenantId);
                tenants.set(tenantId, entry);
                return entry.scoped;
            }
            if (maxTenants !== Number.POSITIVE_INFINITY && tenants.size >= maxTenants) {
                const lruId = tenants.keys().next().value;
                if (lruId !== undefined) {
                    const lru = tenants.get(lruId);
                    if (lru) {
                        try {
                            lru.store.destroy();
                        }
                        catch { }
                    }
                    tenants.delete(lruId);
                }
            }
            const store = new InMemoryStore({ maxSize, autoCleanup, cleanupIntervalMs });
            const scoped = withStore(store);
            entry = { store, scoped };
            tenants.set(tenantId, entry);
            return entry.scoped;
        },
        evict(tenantId) {
            const entry = tenants.get(tenantId);
            if (entry) {
                entry.store.destroy();
                tenants.delete(tenantId);
            }
        },
        size() {
            return tenants.size;
        },
        destroy() {
            for (const [, entry] of tenants) {
                entry.store.destroy();
            }
            tenants.clear();
        },
    };
}
export function createAsyncTenantStore(storeFactory, options = {}) {
    const maxTenants = options.maxTenants ?? LIMITS.MAX_TENANTS;
    const tenants = new Map();
    const safeDestroy = (store) => {
        try {
            const result = store.destroy?.();
            if (result && typeof result.then === 'function') {
                ;
                result.catch(() => { });
            }
        }
        catch {
        }
    };
    return {
        get(tenantId) {
            let entry = tenants.get(tenantId);
            if (entry) {
                tenants.delete(tenantId);
                tenants.set(tenantId, entry);
                return entry.scoped;
            }
            if (maxTenants !== Number.POSITIVE_INFINITY && tenants.size >= maxTenants) {
                const lruId = tenants.keys().next().value;
                if (lruId !== undefined) {
                    const lru = tenants.get(lruId);
                    if (lru)
                        safeDestroy(lru.store);
                    tenants.delete(lruId);
                }
            }
            const store = storeFactory(tenantId);
            const scoped = withStore(store);
            entry = { store, scoped };
            tenants.set(tenantId, entry);
            return entry.scoped;
        },
        evict(tenantId) {
            const entry = tenants.get(tenantId);
            if (entry) {
                safeDestroy(entry.store);
                tenants.delete(tenantId);
            }
        },
        size() {
            return tenants.size;
        },
        destroy() {
            for (const [, entry] of tenants) {
                safeDestroy(entry.store);
            }
            tenants.clear();
        },
    };
}
