import { InMemoryStore } from '../stores/memory.js'
import { withStore } from './act.js'
import type { ScopedActSync, ScopedActAsync } from './act.js'
import { isSyncStore, isAsyncStore } from '../stores/base.js'
import type { SyncStateStore, AsyncStateStore } from '../stores/base.js'
import { LIMITS } from '../utils/limits.js'

export interface TenantStoreOptions {
  maxSize?: number
  autoCleanup?: boolean
  cleanupIntervalMs?: number
}

export interface TenantManager {
  get(tenantId: string): ScopedActSync | ScopedActAsync
  evict(tenantId: string): void
  size(): number
  destroy(): void
}

/**
 * Manages per-tenant stores for multi-tenant isolation.
 * Each tenant gets its own InMemoryStore — cache/dedupe entries
 * cannot leak across tenants.
 */
export function createTenantStore(options: TenantStoreOptions = {}): TenantManager {
  const maxSize = options.maxSize ?? LIMITS.DEFAULT_STORE_MAX_SIZE
  const autoCleanup = options.autoCleanup ?? true
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000

  const tenants = new Map<string, { store: InMemoryStore; scoped: ScopedActSync }>()

  return {
    get(tenantId: string) {
      let entry = tenants.get(tenantId)
      if (!entry) {
        const store = new InMemoryStore({ maxSize, autoCleanup, cleanupIntervalMs })
        const scoped = withStore(store) as ScopedActSync
        entry = { store, scoped }
        tenants.set(tenantId, entry)
      }
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
 * Async tenant manager for async stores (Redis, DynamoDB, etc).
 * Each tenant gets its own store instance with prefixed keys.
 */
export function createAsyncTenantStore(
  storeFactory: (tenantId: string) => AsyncStateStore,
): {
  get: (tenantId: string) => ScopedActAsync
  evict: (tenantId: string) => void
  size: () => number
} {
  const tenants = new Map<string, { store: AsyncStateStore; scoped: ScopedActAsync }>()

  return {
    get(tenantId: string) {
      let entry = tenants.get(tenantId)
      if (!entry) {
        const store = storeFactory(tenantId)
        const scoped = withStore(store) as ScopedActAsync
        entry = { store, scoped }
        tenants.set(tenantId, entry)
      }
      return entry.scoped
    },

    evict(tenantId: string) {
      tenants.delete(tenantId)
    },

    size() {
      return tenants.size
    },
  }
}
