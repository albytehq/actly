import { InMemoryStore } from '../stores/memory.js'
import { withStore } from './act.js'
import type { ScopedActSync, ScopedActAsync } from './act.js'
import type { AsyncStateStore } from '../stores/contract.js'
import { LIMITS } from '../limits.js'

export interface TenantStoreOptions {
  maxSize?: number
  autoCleanup?: boolean
  cleanupIntervalMs?: number
  /**
   * Max tenants tracked. `get()` evicts the least-recently-used tenant
   * (destroying its store) when the cap is exceeded. Default
   * `LIMITS.MAX_TENANTS` (10 000); pass `Infinity` for unbounded.
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
 * Per-tenant store isolation: each tenant gets its own InMemoryStore, so
 * cache/dedupe entries cannot leak across tenants. Bounded by `maxTenants`
 * with LRU eviction (Map delete+set refreshes recency).
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
        tenants.delete(tenantId)
        tenants.set(tenantId, entry)
        return entry.scoped
      }
      if (maxTenants !== Number.POSITIVE_INFINITY && tenants.size >= maxTenants) {
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
 * Async tenant manager: each tenant gets its own store instance from
 * `storeFactory` (Redis, DynamoDB, ...). Same bounded-LRU semantics as
 * {@link createTenantStore}; `destroy()` is best-effort on every store.
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
      // best-effort
    }
  }

  return {
    get(tenantId: string) {
      let entry = tenants.get(tenantId)
      if (entry) {
        tenants.delete(tenantId)
        tenants.set(tenantId, entry)
        return entry.scoped
      }
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
      const entry = tenants.get(tenantId)
      if (entry) {
        safeDestroy(entry.store)
        tenants.delete(tenantId)
      }
    },

    size() {
      return tenants.size
    },

    destroy() {
      for (const [, entry] of tenants) {
        safeDestroy(entry.store)
      }
      tenants.clear()
    },
  }
}
