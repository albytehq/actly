"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.act = act;
const executor_js_1 = require("./executor.js");
const retry_js_1 = require("../policies/retry.js");
const timeout_js_1 = require("../policies/timeout.js");
const dedupe_js_1 = require("../policies/dedupe.js");
const cache_js_1 = require("../policies/cache.js");
const store_js_1 = require("../state/store.js");
// Module-level default store so cache and dedupe persist across calls.
// For SSR isolation or per-test control, construct an InMemoryStore and
// call execute() directly — it accepts any StateStore implementation.
const defaultStore = new store_js_1.InMemoryStore();
/**
 * Execute fn with the given reliability policies.
 *
 * @param key     Stable identifier for this action. Scopes dedupe + cache.
 * @param fn      The async work to run.
 * @param options Which policies to apply and how. All fields are optional.
 *
 * @returns       ActResult<T> — always resolves, never throws.
 *                Check result.ok before reading result.value.
 *
 * @example
 * const result = await act('user:42', () => fetchUser(42), {
 *   retry:   { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout: { ms: 5_000 },
 *   dedupe:  true,
 *   cache:   { ttl: 60_000 },
 * })
 *
 * if (result.ok) {
 *   console.log(result.value, result.source, result.attempts)
 * } else {
 *   console.error(result.error)
 * }
 */
async function act(key, fn, options = {}) {
    const meta = { attempts: 1, source: 'fresh' };
    // Normalise dedupe: true → { enabled: true } so the rest of the function
    // always works with the object form.
    const dedupe = typeof options.dedupe === 'boolean'
        ? { enabled: options.dedupe }
        : options.dedupe;
    // Outermost -> innermost. See executor.ts for why this ordering matters.
    const policies = [];
    // totalTimeout sits before everything — it's a hard wall-clock budget over
    // the entire operation. If it fires, no inner policy can extend the deadline.
    if (options.totalTimeout && options.totalTimeout.ms > 0) {
        policies.push((0, timeout_js_1.totalTimeoutPolicy)(options.totalTimeout)); // 0. hardest outer wall
    }
    if (options.cache && options.cache.ttl > 0) {
        policies.push((0, cache_js_1.cachePolicy)(options.cache)); // 1. skip all on hit
    }
    if (dedupe?.enabled) {
        policies.push((0, dedupe_js_1.dedupePolicy)()); // 2. collapse concurrent callers
    }
    if (options.retry && options.retry.attempts > 1) {
        policies.push((0, retry_js_1.retryPolicy)(options.retry)); // 3. own the attempt loop
    }
    if (options.timeout && options.timeout.ms > 0) {
        policies.push((0, timeout_js_1.timeoutPolicy)(options.timeout)); // 4. innermost — per-attempt clock
    }
    try {
        const value = await (0, executor_js_1.execute)({ key, fn, policies, store: defaultStore, meta });
        return { ok: true, value, source: meta.source, attempts: meta.attempts };
    }
    catch (error) {
        return { ok: false, error, attempts: meta.attempts };
    }
}
