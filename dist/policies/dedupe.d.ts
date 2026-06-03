import type { PolicyApplier } from '../types/index.js';
/**
 * Collapses concurrent calls that share the same key into one in-flight Promise.
 *
 * The first caller starts the work. Every subsequent caller that arrives before
 * the first resolves gets the same Promise back — no duplicate work.
 *
 * INVARIANT: requires a SyncStateStore — see stores/base.ts.
 * The read-then-write that makes deduplication work must happen in a single
 * synchronous frame. An async store would introduce an await between get() and
 * set(), letting two concurrent callers both see a miss and both launch work.
 * The REQUIRES_SYNC_STORE symbol on the returned PolicyApplier lets execute()
 * enforce this at runtime for JS callers that bypass TypeScript.
 *
 * Known tradeoff (v1): deduped callers see attempts=1 in their ActResult because
 * the retry counter belongs to the originating call's meta object.
 */
export declare function dedupePolicy<T>(): PolicyApplier<T>;
//# sourceMappingURL=dedupe.d.ts.map