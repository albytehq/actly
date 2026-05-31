export class InMemoryStore {
    constructor() {
        this.entries = new Map();
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value, ttlMs) {
        // ttlMs = 0 or undefined -> no expiry (sentinel null)
        const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null;
        this.entries.set(key, { value, expiresAt });
    }
    delete(key) {
        this.entries.delete(key);
    }
    has(key) {
        // Reuse get() so expired entries are evicted on access
        return this.get(key) !== undefined;
    }
    /** Drop everything. Handy in tests or for manual cache invalidation. */
    clear() {
        this.entries.clear();
    }
    /** Count of live (non-expired) entries. */
    get size() {
        for (const key of this.entries.keys())
            this.has(key);
        return this.entries.size;
    }
}
//# sourceMappingURL=store.js.map