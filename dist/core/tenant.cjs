"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTenantStore = createTenantStore;
exports.createAsyncTenantStore = createAsyncTenantStore;
const memory_js_1 = require("../stores/memory.js");
const act_js_1 = require("./act.js");
const limits_js_1 = require("../utils/limits.js");
/**
 * Manages per-tenant stores for multi-tenant isolation.
 * Each tenant gets its own InMemoryStore — cache/dedupe entries
 * cannot leak across tenants.
 */
function createTenantStore(options = {}) {
    const maxSize = options.maxSize ?? limits_js_1.LIMITS.DEFAULT_STORE_MAX_SIZE;
    const autoCleanup = options.autoCleanup ?? true;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    const tenants = new Map();
    return {
        get(tenantId) {
            let entry = tenants.get(tenantId);
            if (!entry) {
                const store = new memory_js_1.InMemoryStore({ maxSize, autoCleanup, cleanupIntervalMs });
                const scoped = (0, act_js_1.withStore)(store);
                entry = { store, scoped };
                tenants.set(tenantId, entry);
            }
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
/**
 * Async tenant manager for async stores (Redis, DynamoDB, etc).
 * Each tenant gets its own store instance with prefixed keys.
 */
function createAsyncTenantStore(storeFactory) {
    const tenants = new Map();
    return {
        get(tenantId) {
            let entry = tenants.get(tenantId);
            if (!entry) {
                const store = storeFactory(tenantId);
                const scoped = (0, act_js_1.withStore)(store);
                entry = { store, scoped };
                tenants.set(tenantId, entry);
            }
            return entry.scoped;
        },
        evict(tenantId) {
            tenants.delete(tenantId);
        },
        size() {
            return tenants.size;
        },
    };
}
