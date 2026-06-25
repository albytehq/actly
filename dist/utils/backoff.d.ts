import type { RetryOptions } from '../types/index.js';
/**
 * Compute the delay before the next retry attempt, applying backoff, cap, and
 * jitter in that order.
 *
 * Order matters:
 *  1. `backoff` grows the base delay geometrically/linearly.
 *  2. `maxDelay` caps the result (prevents exponential blowup).
 *  3. `jitter` randomises within `[0, delay]` (prevents thundering herd).
 *
 * Returns 0 if `delayMs` is 0 or undefined — skipping the sleep entirely.
 */
export declare function computeDelay(attempt: number, opts: RetryOptions): number;
//# sourceMappingURL=backoff.d.ts.map