"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
exports.createDefaultStore = createDefaultStore;
const limits_js_1 = require("../utils/limits.js");
function isUnrefable(t) {
    return typeof t.unref === 'function';
}
class InMemoryStore {
    _sync = true;
    static finalizer;
    static {
        if (typeof FinalizationRegistry === 'function') {
            InMemoryStore.finalizer = new FinalizationRegistry((timer) => {
                try {
                    clearInterval(timer);
                }
                catch { }
            });
        }
    }
    map = new Map();
    maxSize;
    head;
    tail;
    cleanupTimer;
    memoryListener;
    constructor(options = {}) {
        const { autoCleanup = false, cleanupIntervalMs = 30_000, maxSize = limits_js_1.LIMITS.DEFAULT_STORE_MAX_SIZE, memoryPressureCleanup = false, } = options;
        if (!Number.isFinite(maxSize) || maxSize <= 0) {
            if (maxSize !== Number.POSITIVE_INFINITY) {
                throw new RangeError(`Actly: InMemoryStore maxSize must be a positive finite number or Infinity, got ${maxSize}`);
            }
        }
        if (maxSize !== Number.POSITIVE_INFINITY && !Number.isInteger(maxSize)) {
            throw new RangeError(`Actly: InMemoryStore maxSize must be a positive integer or Infinity, got ${maxSize}`);
        }
        this.maxSize = maxSize;
        if (autoCleanup) {
            const timer = setInterval(() => this.sweep(), cleanupIntervalMs);
            if (isUnrefable(timer))
                timer.unref();
            this.cleanupTimer = timer;
            InMemoryStore.finalizer?.register(this, timer, this);
        }
        if (memoryPressureCleanup) {
            const processOn = process.on;
            if (typeof processOn === 'function') {
                const memoryListener = () => {
                    try {
                        this.sweep();
                    }
                    catch { }
                };
                processOn.call(process, 'memory', memoryListener);
                this.memoryListener = memoryListener;
            }
        }
    }
    get(key) {
        const node = this.map.get(key);
        if (!node)
            return undefined;
        if (node.expiresAt !== null && Date.now() > node.expiresAt) {
            this.removeNode(node);
            this.map.delete(key);
            return undefined;
        }
        this.moveToTail(node);
        return node.value;
    }
    set(key, value, ttlMs) {
        const existing = this.map.get(key);
        const now = Date.now();
        if (existing) {
            existing.value = value;
            existing.expiresAt = ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null;
            existing.insertedAt = now;
            this.moveToTail(existing);
            return;
        }
        while (this.map.size >= this.maxSize && this.head) {
            const evict = this.head;
            this.removeNode(evict);
            this.map.delete(evict.key);
        }
        const node = {
            key,
            value,
            expiresAt: ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null,
            insertedAt: now,
        };
        this.map.set(key, node);
        this.appendTail(node);
    }
    delete(key) {
        const node = this.map.get(key);
        if (!node)
            return;
        this.removeNode(node);
        this.map.delete(key);
    }
    has(key) {
        const node = this.map.get(key);
        if (!node)
            return false;
        if (node.expiresAt !== null && Date.now() > node.expiresAt) {
            this.removeNode(node);
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
    size() {
        return this.map.size;
    }
    destroy() {
        if (this.cleanupTimer !== undefined) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
            InMemoryStore.finalizer?.unregister(this);
        }
        if (this.memoryListener) {
            const processOff = process.off;
            if (typeof processOff === 'function') {
                processOff.call(process, 'memory', this.memoryListener);
            }
            this.memoryListener = undefined;
        }
        this.map.clear();
        this.head = undefined;
        this.tail = undefined;
    }
    appendTail(node) {
        if (this.tail) {
            this.tail.next = node;
            node.prev = this.tail;
            node.next = undefined;
        }
        else {
            this.head = node;
        }
        this.tail = node;
    }
    removeNode(node) {
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
    moveToTail(node) {
        if (this.tail === node)
            return;
        this.removeNode(node);
        this.appendTail(node);
    }
    sweep() {
        try {
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
                    this.removeNode(node);
                    this.map.delete(key);
                }
            }
        }
        catch {
        }
    }
}
exports.InMemoryStore = InMemoryStore;
function createDefaultStore() {
    return new InMemoryStore({
        maxSize: limits_js_1.LIMITS.DEFAULT_STORE_MAX_SIZE,
        autoCleanup: true,
        cleanupIntervalMs: limits_js_1.LIMITS.DEFAULT_STORE_CLEANUP_INTERVAL_MS,
    });
}
