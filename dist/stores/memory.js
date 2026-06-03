function isUnrefable(t) {
    return typeof t.unref === 'function';
}
// ─── Implementation ───────────────────────────────────────────────────────────
export class InMemoryStore {
    constructor(options = {}) {
        // Discriminant read by isSyncStore() in execute() to enforce the dedupe
        // constraint at runtime for JS callers who bypass TypeScript.
        this._sync = true;
        this.entries = new Map();
        const { autoCleanup = false, cleanupIntervalMs = 30000 } = options;
        if (autoCleanup) {
            const timer = setInterval(() => this._sweep(), cleanupIntervalMs);
            // Prevent the interval from keeping the Node.js process alive when the
            // application has otherwise finished its work. Safe no-op in browsers.
            if (isUnrefable(timer))
                timer.unref();
            this.cleanupTimer = timer;
        }
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
        // ttlMs = 0 or undefined → no expiry (sentinel null)
        const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null;
        this.entries.set(key, { value, expiresAt });
    }
    delete(key) {
        this.entries.delete(key);
    }
    has(key) {
        // Delegate to get() so expired entries are evicted on access.
        return this.get(key) !== undefined;
    }
    /**
     * Remove all entries.
     * After this call, size() returns 0.
     */
    clear() {
        this.entries.clear();
    }
    /**
     * Return the count of live (non-expired) entries.
     *
     * Expired entries are evicted during the scan, so repeated calls are
     * slightly cheaper as the map self-prunes. O(n) in the number of entries.
     */
    size() {
        // Evict expired entries as we scan — keeps the map tidy between sweeps
        // and ensures the returned count reflects only observable entries.
        for (const key of this.entries.keys())
            this.has(key);
        return this.entries.size;
    }
    /**
     * Stop the background cleanup timer and release internal state.
     * Safe to call multiple times — subsequent calls are no-ops.
     *
     * Call destroy() when discarding a long-lived store instance to prevent
     * timer leaks. Stores without autoCleanup enabled have nothing to release,
     * but destroy() is safe to call on them regardless.
     */
    destroy() {
        if (this.cleanupTimer !== undefined) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
    }
    // Sweep all entries and remove those past their expiry time.
    // Called by the autoCleanup interval — not part of the public contract.
    _sweep() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt !== null && now > entry.expiresAt) {
                this.entries.delete(key);
            }
        }
    }
}
//# sourceMappingURL=memory.js.map