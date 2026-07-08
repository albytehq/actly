import { InMemoryStore } from '../stores/memory.js'
import { withStore } from './act.js'
import type { ScopedActSync, ScopedActAsync } from './act.js'
import type { AsyncStateStore } from '../stores/base.js'
import { LIMITS } from '../utils/limits.js'

export interface TenantStoreOptions {
  maxSize?: number
  autoCleanup?: boolean
  cleanupIntervalMs?: number
  /**
   * Max tenants tracked by the manager. When `get(tenantId)` would create a
   * new tenant that exceeds this cap, the manager evicts the
   * least-recently-used tenant (calling `store.destroy()` first to release
   * its cleanup interval + Map). The `Map` preserves insertion order in JS,
   * so a `delete + set` cycle moves a tenant to the MRU position on access:
   * true LRU semantics.
   *
   * Defaults to `LIMITS.MAX_TENANTS` (10 000). Pass `Infinity` for
   * unbounded (not recommended; leaks memory + intervals under high
   * cardinality).
   */
  maxTenants?: number
}

export interface TenantManager {
  get(tenantId: string): ScopedActSync | ScopedActAsync
  evict(tenantId: string): void
  size(): number
  destroy(): void
}

/**
 * Manages per-tenant stores for multi-tenant isolation. Each tenant gets
 * its own InMemoryStore; cache/dedupe entries cannot leak across tenants.
 *
 * Bounded by `maxTenants` (default 10 000) with LRU eviction. Without the
 * bound, a SaaS that creates a tenant store per request or per user-session
 * would accumulate tenant entries + their cleanup intervals for the
 * lifetime of the process.
 */
export function createTenantStore(options: TenantStoreOptions = {}): TenantManager {
  const maxSize = options.maxSize ?? LIMITS.DEFAULT_STORE_MAX_SIZE
  const autoCleanup = options.autoCleanup ?? true
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000
  const maxTenants = options.maxTenants ?? LIMITS.MAX_TENANTS

  const tenants = new Map<string, { store: InMemoryStore; scoped: ScopedActSync }>()

  return {
    get(tenantId: string) {
      let entry = tenants.get(tenantId)
      if (entry) {
        // LRU refresh: delete+set moves to MRU so eviction tracks recent
        // access, not insertion order.
        tenants.delete(tenantId)
        tenants.set(tenantId, entry)
        return entry.scoped
      }
      // New tenant; check capacity and evict LRU if needed.
      if (maxTenants !== Number.POSITIVE_INFINITY && tenants.size >= maxTenants) {
        // Map iteration order is insertion order; first key is LRU.
        const lruId = tenants.keys().next().value
        if (lruId !== undefined) {
          const lru = tenants.get(lruId)
          if (lru) {
            try { lru.store.destroy() } catch { /* best-effort */ }
          }
          tenants.delete(lruId)
        }
      }
      const store = new InMemoryStore({ maxSize, autoCleanup, cleanupIntervalMs })
      const scoped = withStore(store) as ScopedActSync
      entry = { store, scoped }
      tenants.set(tenantId, entry)
      return entry.scoped
    },

    evict(tenantId: string) {
      const entry = tenants.get(tenantId)
      if (entry) {
        entry.store.destroy()
        tenants.delete(tenantId)
      }
    },

    size() {
      return tenants.size
    },

    destroy() {
      for (const [, entry] of tenants) {
        entry.store.destroy()
      }
      tenants.clear()
    },
  }
}

/**
 * Async tenant manager for async stores (Redis, DynamoDB, etc). Each tenant
 * gets its own store instance with prefixed keys. Bounded by `maxTenants`
 * (default 10 000) with LRU eviction; mirrors the sync `createTenantStore`.
 */
export function createAsyncTenantStore(
  storeFactory: (tenantId: string) => AsyncStateStore,
  options: { maxTenants?: number } = {},
): {
  get: (tenantId: string) => ScopedActAsync
  evict: (tenantId: string) => void
  size: () => number
  destroy: () => void
} {
  const maxTenants = options.maxTenants ?? LIMITS.MAX_TENANTS
  const tenants = new Map<string, { store: AsyncStateStore; scoped: ScopedActAsync }>()

  const safeDestroy = (store: AsyncStateStore): void => {
    try {
      const result = (store as { destroy?: () => void | Promise<void> }).destroy?.()
      if (result && typeof (result as Promise<void>).then === 'function') {
        ;(result as Promise<void>).catch(() => {})
      }
    } catch {
      // best-effort cleanup; ignore throw.
    }
  }

  return {
    get(tenantId: string) {
      let entry = tenants.get(tenantId)
      if (entry) {
        // LRU refresh.
        tenants.delete(tenantId)
        tenants.set(tenantId, entry)
        return entry.scoped
      }
      // New tenant; check capacity and evict LRU if needed.
      if (maxTenants !== Number.POSITIVE_INFINITY && tenants.size >= maxTenants) {
        const lruId = tenants.keys().next().value
        if (lruId !== undefined) {
          const lru = tenants.get(lruId)
          if (lru) safeDestroy(lru.store)
          tenants.delete(lruId)
        }
      }
      const store = storeFactory(tenantId)
      const scoped = withStore(store) as ScopedActAsync
      entry = { store, scoped }
      tenants.set(tenantId, entry)
      return entry.scoped
    },

    evict(tenantId: string) {
      // call destroy() on the evicted store so it can release its resources
      // (Redis connection, DynamoDB doc client, timer, etc.). Without this,
      // a multi-tenant SaaS that creates/evicts tenants at runtime leaks a
      // connection pool per eviction; eventually exhausts file descriptors /
      // connections.
      const entry = tenants.get(tenantId)
      if (entry) {
        safeDestroy(entry.store)
        tenants.delete(tenantId)
      }
    },

    size() {
      return tenants.size
    },

    // destroy all tenant stores; without this, async tenant stores
    // (Redis clients etc.) leak when the manager itself is torn down.
    destroy() {
      for (const [, entry] of tenants) {
        safeDestroy(entry.store)
      }
      tenants.clear()
    },
  }
}
