"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTenantStore = createTenantStore;
exports.createAsyncTenantStore = createAsyncTenantStore;
const memory_js_1 = require("../stores/memory.js");
const act_js_1 = require("./act.js");
const limits_js_1 = require("../utils/limits.js");
function createTenantStore(options = {}) {
    const maxSize = options.maxSize ?? limits_js_1.LIMITS.DEFAULT_STORE_MAX_SIZE;
    const autoCleanup = options.autoCleanup ?? true;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    const maxTenants = options.maxTenants ?? limits_js_1.LIMITS.MAX_TENANTS;
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
            const store = new memory_js_1.InMemoryStore({ maxSize, autoCleanup, cleanupIntervalMs });
            const scoped = (0, act_js_1.withStore)(store);
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
function createAsyncTenantStore(storeFactory, options = {}) {
    const maxTenants = options.maxTenants ?? limits_js_1.LIMITS.MAX_TENANTS;
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
            const scoped = (0, act_js_1.withStore)(store);
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
