import type { PolicyApplier } from '../types/index.js';
/**
 * Collapses concurrent calls that share the same key into one in-flight Promise.
 *
 * The first caller starts the work. Every subsequent caller that arrives before
 * the first resolves gets the same Promise back — no duplicate work.
 *
 * Known tradeoff (v1): deduped callers see attempts=1 in their ActResult because
 * the retry counter belongs to the originating call's meta object.
 */
export declare function dedupePolicy<T>(): PolicyApplier<T>;
//# sourceMappingURL=dedupe.d.ts.map