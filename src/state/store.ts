import type { StateStore } from '../types/index.js'

interface Entry<T> {
  value: T
  // null = never expires (used by dedupe's in-flight promises)
  expiresAt: number | null
}

export class InMemoryStore implements StateStore {
  private entries = new Map<string, Entry<unknown>>()

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }

    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    // ttlMs = 0 or undefined -> no expiry (sentinel null)
    const expiresAt =
      ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null
    this.entries.set(key, { value, expiresAt })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  has(key: string): boolean {
    // Reuse get() so expired entries are evicted on access
    return this.get(key) !== undefined
  }

  /** Drop everything. Handy in tests or for manual cache invalidation. */
  clear(): void {
    this.entries.clear()
  }

  /** Count of live (non-expired) entries. */
  get size(): number {
    for (const key of this.entries.keys()) this.has(key)
    return this.entries.size
  }
}
