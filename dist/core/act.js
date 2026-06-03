import { execute } from './executor.js';
import { retryPolicy } from '../policies/retry.js';
import { timeoutPolicy, totalTimeoutPolicy } from '../policies/timeout.js';
import { dedupePolicy } from '../policies/dedupe.js';
import { cachePolicy } from '../policies/cache.js';
import { InMemoryStore } from '../stores/memory.js';
// Module-level default store so cache and dedupe persist across calls.
// Always an InMemoryStore (SyncStateStore) — required because the default
// chain may include dedupePolicy, which mandates synchronous store access.
// For SSR isolation or per-test control, construct an InMemoryStore and
// call execute() directly with an explicit store.
const defaultStore = new InMemoryStore();
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
export async function act(key, fn, options = {}) {
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
        policies.push(totalTimeoutPolicy(options.totalTimeout)); // 0. hardest outer wall
    }
    if (options.cache && options.cache.ttl > 0) {
        policies.push(cachePolicy(options.cache)); // 1. skip all on hit
    }
    if (dedupe?.enabled) {
        policies.push(dedupePolicy()); // 2. collapse concurrent callers
    }
    if (options.retry && options.retry.attempts > 1) {
        policies.push(retryPolicy(options.retry)); // 3. own the attempt loop
    }
    if (options.timeout && options.timeout.ms > 0) {
        policies.push(timeoutPolicy(options.timeout)); // 4. innermost — per-attempt clock
    }
    try {
        const value = await execute({ key, fn, policies, store: defaultStore, meta });
        return { ok: true, value, source: meta.source, attempts: meta.attempts };
    }
    catch (error) {
        return { ok: false, error, attempts: meta.attempts };
    }
}
//# sourceMappingURL=act.js.map