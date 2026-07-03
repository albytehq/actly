/**
 * Centralised numeric limits for all actly inputs.
 *
 * # Why central?
 *
 * Every numeric input that flows into actly (retry.attempts, timeout.ms,
 * cache.ttl, etc.) must be bounded to prevent:
 *  - memory exhaustion (e.g. `cache: { ttl: 1e15 }` → 31 700-year TTL)
 *  - CPU exhaustion (e.g. `retry: { attempts: 1e9 }`)
 *  - timer overflow (e.g. `setTimeout(fn, 1e16)` wraps to 1ms on some engines)
 *
 * The values are deliberately generous: they prevent pathological abuse,
 * not legitimate use. If you need to exceed one of these limits, you almost
 * certainly have a bug.
 *
 * These limits are constants — they are not runtime-configurable. If you
 * need different limits, fork the source or wrap `act()` with your own
 * validation layer.
 */
export declare const LIMITS: Readonly<{
    /** Maximum key length in characters. Prevents multi-MB keys bloating stores. */
    MAX_KEY_LENGTH: 1024;
    /** Hard ceiling on `retry.attempts`. 100 attempts ≈ 100 fn invocations. */
    MAX_RETRY_ATTEMPTS: 100;
    /** Maximum per-attempt / total timeout in ms. ~27 hours. */
    MAX_TIMEOUT_MS: 100000000;
    /** Maximum cache TTL in ms. ~24 hours. */
    MAX_CACHE_TTL: 86400000;
    /** Maximum delay between retries in ms. ~5 minutes. */
    MAX_RETRY_DELAY_MS: 300000;
    /** Maximum dedupe inflightTtl in ms. ~24 hours. */
    MAX_INFLIGHT_TTL: 86400000;
    /** Default bound for InMemoryStore when used as the module-level default. */
    DEFAULT_STORE_MAX_SIZE: 10000;
    /** Background sweep interval for the default store. */
    DEFAULT_STORE_CLEANUP_INTERVAL_MS: 60000;
}>;
export type Limits = typeof LIMITS;
//# sourceMappingURL=limits.d.ts.map