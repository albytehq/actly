import type { PolicyApplier, RetryOptions } from '../types/index.js';
/**
 * Retry `fn` up to `opts.attempts` times on retryable errors.
 *
 * Writes the live attempt count into `ctx.meta.attempts` so `act()` can
 * report it in the final `ActResult`.
 *
 * # Signal awareness
 *
 * - Before each attempt, checks `parentSignal.aborted`. If the parent (e.g.
 *   `totalTimeout` or caller) has aborted, throws the parent's reason
 *   immediately — no more attempts.
 * - Sleeps between attempts use `sleep(delay, parentSignal)`. If the parent
 *   aborts mid-delay, the sleep rejects immediately instead of blocking
 *   the loop until the timer would have elapsed.
 *
 * # `shouldRetry` invocation
 *
 * Called after EVERY failure, including the last attempt. This preserves the
 * predicate's contract for observers / metrics that rely on it being called
 * per-attempt. The return value is only consulted when `attempt < max`.
 *
 * # Default predicate
 *
 * If `shouldRetry` is omitted, uses `defaultShouldRetry` which retries on
 * every error EXCEPT abort errors (so timeouts and caller cancellations
 * don't waste retry budget).
 */
export declare function retryPolicy<T>(opts: RetryOptions): PolicyApplier<T>;
//# sourceMappingURL=retry.d.ts.map