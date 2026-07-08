// Centralised numeric limits for actly inputs. Bounding every numeric
// field prevents memory exhaustion (huge TTLs), CPU exhaustion (huge retry
// counts), and timer overflow (huge delays). Values are generous - they
// catch pathological abuse, not legitimate use. Not runtime-configurable.

export const LIMITS = Object.freeze({
  /** Maximum key length in characters. */
  MAX_KEY_LENGTH: 1024,

  /** Hard ceiling on retry.attempts. */
  MAX_RETRY_ATTEMPTS: 100,

  /** Maximum per-attempt / total timeout in ms (~27 hours). */
  MAX_TIMEOUT_MS: 100_000_000,

  /** Maximum cache TTL in ms (~24 hours). */
  MAX_CACHE_TTL: 86_400_000,

  /** Maximum delay between retries in ms (~5 minutes). */
  MAX_RETRY_DELAY_MS: 300_000,

  /** Maximum dedupe inflightTtl in ms (~24 hours). */
  MAX_INFLIGHT_TTL: 86_400_000,

  /**
   * Default dedupe inflightTtl (~5 minutes) when dedupe is enabled without
   * an explicit ttl. Bounds a hung fn so it can't block subsequent callers
   * on that key forever. Pass `Infinity` explicitly to restore unbounded
   * behaviour (at your own risk - pair with a timeout).
   */
  DEFAULT_INFLIGHT_TTL: 5 * 60_000,

  /** Default bound for InMemoryStore when used as the module-level default. */
  DEFAULT_STORE_MAX_SIZE: 10_000,

  /** Background sweep interval for the default store. */
  DEFAULT_STORE_CLEANUP_INTERVAL_MS: 60_000,

  /**
   * Hard cap on the total number of in-flight act() calls across all
   * scopes. Prevents self-DoS from a buggy caller that spawns unbounded
   * concurrent calls (e.g. a missing await in a loop). Hitting the cap
   * throws ResourceExhaustedError synchronously, surfacing as an ActFailure
   * with failedBy: 'validation'.
   *
   * Opt out via ACTLY_NO_INFLIGHT_LIMIT=1 set before the first act() call.
   * The opt-out is process-wide and irreversible. 100k gives ~10× headroom
   * over a typical Node process's comfortable concurrency.
   */
  MAX_GLOBAL_INFLIGHT: 100_000,

  /**
   * Cap on circuitBreaker.countSize / countMinimumCalls. Each ring-buffer
   * slot is ~1 byte; 1M slots = ~1MB. Production breakers rarely exceed 1000.
   */
  MAX_CIRCUIT_BREAKER_WINDOW: 1_000_000,

  /** Cap on bulkhead.maxConcurrent. Each slot holds a Promise + closure. */
  MAX_BULKHEAD_CONCURRENCY: 1_000_000,

  /** Cap on bulkhead.maxQueueSize. Each queued caller holds a resolver + timer. */
  MAX_BULKHEAD_QUEUE: 1_000_000,

  /** Cap on rateLimit.maxCalls. The limiter stores one timestamp per call. */
  MAX_RATE_LIMIT_CALLS: 1_000_000,

  /**
   * Max length of a sanitized error message stored in health state.
   * Longer messages are truncated with an ellipsis marker.
   */
  MAX_SANITIZED_ERROR_LENGTH: 8_192,

  /**
   * Cap on hedge.delayMs. Node's setTimeout clamps to a 32-bit signed int
   * (~24.8 days); larger values fire immediately and provide no hedge.
   */
  MAX_HEDGE_DELAY_MS: 300_000,

  /**
   * Cap on the number of tenants tracked by createTenantStore /
   * createAsyncTenantStore. Larger fleets should shard across processes.
   */
  MAX_TENANTS: 10_000,
})

export type Limits = typeof LIMITS
