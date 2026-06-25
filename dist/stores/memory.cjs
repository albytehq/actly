"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
function isUnrefable(t) {
    return typeof t.unref === 'function';
}
// ─── Implementation ───────────────────────────────────────────────────────────
/**
 * Reference `SyncStateStore` implementation backed by a `Map`.
 *
 * # LRU semantics
 *
 * `Map` iteration order is insertion order, so we implement LRU by
 * `delete` + `set` on every access — the most-recently-touched key ends up
 * at the end of the iteration, and the oldest is `entries.keys().next().value`.
 *
 * # Expiry
 *
 * Lazy on `get()` / `has()`: expired entries are deleted when touched.
 * Background sweep (optional) reclaims entries that are never re-read.
 */
class InMemoryStore {
    _sync = true;
    entries = new Map();
    maxSize;
    cleanupTimer;
    constructor(options = {}) {
        const { autoCleanup = false, cleanupIntervalMs = 30_000, maxSize = Number.POSITIVE_INFINITY, } = options;
        if (!Number.isFinite(maxSize) || maxSize <= 0) {
            // Infinity is allowed (unbounded); any other non-positive finite value
            // is a programmer error.
            if (maxSize !== Number.POSITIVE_INFINITY) {
                throw new RangeError(`Actly: InMemoryStore maxSize must be a positive finite number or Infinity, got ${maxSize}`);
            }
        }
        this.maxSize = maxSize;
        if (autoCleanup) {
            const timer = setInterval(() => this._sweep(), cleanupIntervalMs);
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
        // LRU refresh: move to most-recent position.
        // delete + set is the canonical pattern for reordering a Map.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key, value, ttlMs) {
        // Evict if at capacity AND adding a new key (updates don't grow size).
        if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined)
                this.entries.delete(oldest);
        }
        const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null;
        // delete + set ensures the key is moved to the most-recent position
        // even on update, keeping LRU order consistent.
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt });
    }
    delete(key) {
        this.entries.delete(key);
    }
    has(key) {
        // Inline the expiry check to avoid the LRU side-effect of get().
        // `has()` should be a pure query, not a touch.
        const entry = this.entries.get(key);
        if (!entry)
            return false;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            this.entries.delete(key);
            return false;
        }
        return true;
    }
    clear() {
        this.entries.clear();
    }
    /**
     * Return the count of live (non-expired) entries.
     *
     * Pure query — does NOT touch LRU order. Expired entries discovered during
     * the scan are evicted opportunistically (they were already invisible to
     * `get()`, so eviction has no observable effect beyond memory reclamation).
     *
     * Two-pass to avoid mutating the Map during iteration (spec-safe).
     */
    size() {
        const now = Date.now();
        const expired = [];
        let count = 0;
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt !== null && entry.expiresAt <= now) {
                expired.push(key);
            }
            else {
                count++;
            }
        }
        for (const key of expired)
            this.entries.delete(key);
        return count;
    }
    /**
     * Stop the background cleanup timer and release internal state.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    destroy() {
        if (this.cleanupTimer !== undefined) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
    }
    /**
     * Sweep all entries and remove those past their expiry time.
     * Called by the autoCleanup interval; not part of the public contract.
     */
    _sweep() {
        const now = Date.now();
        const expired = [];
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt !== null && now > entry.expiresAt) {
                expired.push(key);
            }
        }
        for (const key of expired)
            this.entries.delete(key);
    }
}
exports.InMemoryStore = InMemoryStore;
