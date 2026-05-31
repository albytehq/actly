import type { PolicyApplier, RetryOptions } from '../types/index.js';
/**
 * Retries fn up to opts.attempts times on any thrown error.
 * Writes the live attempt count into ctx.meta.attempts.
 */
export declare function retryPolicy<T>(opts: RetryOptions): PolicyApplier<T>;
//# sourceMappingURL=retry.d.ts.map