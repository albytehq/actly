import { LIMITS } from '../utils/limits.js';
function isUnrefable(t) {
    return typeof t.unref === 'function';
}
// ─── Implementation ───────────────────────────────────────────────────────────
/**
 * Reference `SyncStateStore` implementation backed by a `Map` + doubly-linked
 * list for LRU.
 *
 * # Properties
 *
 *  - `size()` is O(1) — tracked via a counter instead of full scan.
 *  - LRU reordering uses an explicit doubly-linked list, avoiding the
 *    `delete + set` Map churn that was 2 Map operations per `get()`.
 *  - Default `maxSize` is bounded (`LIMITS.DEFAULT_STORE_MAX_SIZE`) when
 *    used as the module-level default — prevents unbounded memory growth
 *    in long-running servers.
 *
 * # Expiry
 *
 * Lazy on `get()` / `has()`: expired entries are deleted when touched.
 * Background sweep (optional) reclaims entries that are never re-read.
 */
export class InMemoryStore {
    _sync = true;
    map = new Map();
    maxSize;
    head; // least recently used
    tail; // most recently used
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
        const node = this.map.get(key);
        if (!node)
            return undefined;
        if (node.expiresAt !== null && Date.now() > node.expiresAt) {
            this._removeNode(node);
            this.map.delete(key);
            return undefined;
        }
        // LRU refresh: move to tail (most-recent).
        this._moveToTail(node);
        return node.value;
    }
    set(key, value, ttlMs) {
        const existing = this.map.get(key);
        const now = Date.now();
        if (existing) {
            // Update in place — don't grow size, don't evict.
            existing.value = value;
            existing.expiresAt = ttlMs != null && ttlMs > 0 ? now + ttlMs : null;
            existing.insertedAt = now;
            this._moveToTail(existing);
            return;
        }
        // New key — evict if at capacity.
        while (this.map.size >= this.maxSize && this.head) {
            const evict = this.head;
            this._removeNode(evict);
            this.map.delete(evict.key);
        }
        const node = {
            key,
            value,
            expiresAt: ttlMs != null && ttlMs > 0 ? now + ttlMs : null,
            insertedAt: now,
        };
        this.map.set(key, node);
        this._appendTail(node);
    }
    delete(key) {
        const node = this.map.get(key);
        if (!node)
            return;
        this._removeNode(node);
        this.map.delete(key);
    }
    has(key) {
        // Inline the expiry check to avoid the LRU side-effect of get().
        // `has()` should be a pure query, not a touch.
        const node = this.map.get(key);
        if (!node)
            return false;
        if (node.expiresAt !== null && Date.now() > node.expiresAt) {
            this._removeNode(node);
            this.map.delete(key);
            return false;
        }
        return true;
    }
    clear() {
        this.map.clear();
        this.head = undefined;
        this.tail = undefined;
    }
    /**
     * Return the count of live (non-expired) entries.
     *
     * O(1) — returns the Map size directly. Expired-but-not-yet-
     * evicted entries are counted; they're reclaimed lazily on next access
     * or by the background sweep. This is intentional: a fully-accurate
     * count would require an O(n) scan, defeating the purpose.
     *
     * Pure query — does NOT touch LRU order.
     */
    size() {
        return this.map.size;
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
    // ─── LRU list operations ──────────────────────────────────────────────────
    //
    // All operations are O(1). The list runs head (LRU) → tail (MRU).
    _appendTail(node) {
        if (this.tail) {
            this.tail.next = node;
            node.prev = this.tail;
            node.next = undefined;
        }
        else {
            // Empty list — node is both head and tail.
            this.head = node;
        }
        this.tail = node;
    }
    _removeNode(node) {
        if (node.prev) {
            node.prev.next = node.next;
        }
        else {
            this.head = node.next;
        }
        if (node.next) {
            node.next.prev = node.prev;
        }
        else {
            this.tail = node.prev;
        }
        node.prev = undefined;
        node.next = undefined;
    }
    _moveToTail(node) {
        if (this.tail === node)
            return; // already MRU
        this._removeNode(node);
        this._appendTail(node);
    }
    /**
     * Sweep all entries and remove those past their expiry time.
     * Called by the autoCleanup interval; not part of the public contract.
     *
     * Two-pass to avoid mutating the Map during iteration (spec-safe).
     */
    _sweep() {
        const now = Date.now();
        const expired = [];
        for (const [key, node] of this.map) {
            if (node.expiresAt !== null && now > node.expiresAt) {
                expired.push(key);
            }
        }
        for (const key of expired) {
            const node = this.map.get(key);
            if (node) {
                this._removeNode(node);
                this.map.delete(key);
            }
        }
    }
}
/**
 * Factory for the default module-level store.
 *
 * Bounded by `LIMITS.DEFAULT_STORE_MAX_SIZE` with background sweep —
 * prevents unbounded memory growth in long-running servers without
 * requiring callers to opt in.
 */
export function createDefaultStore() {
    return new InMemoryStore({
        maxSize: LIMITS.DEFAULT_STORE_MAX_SIZE,
        autoCleanup: true,
        cleanupIntervalMs: LIMITS.DEFAULT_STORE_CLEANUP_INTERVAL_MS,
    });
}
//# sourceMappingURL=memory.js.map