import type { PolicyApplier, DedupeOptions } from '../types/index.js';
/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # How it works
 *
 * The first caller (originator) starts the work and stores
 * `{ promise, meta }` in the store under `dedupe:<key>`. Every subsequent
 * caller that arrives before the promise settles receives the SAME promise
 * — no duplicate work.
 *
 * # Shared `meta` (fixes v1.0 trade-off)
 *
 * The originator's `ctx.meta` reference is stored alongside the promise.
 * Inner policies (e.g. `retryPolicy`) mutate it as they run. After the
 * promise settles, joiners copy `attempts` and `source` from the shared
 * meta into their own `ctx.meta`. This means a joiner's `ActResult.attempts`
 * reflects the real effort (e.g. `3` if the originator retried twice), not
 * the misleading default of `1`.
 *
 * # Abort safety (fixes hung-fn block)
 *
 * Joiners race the in-flight promise against their own AbortSignal via
 * `raceAbort`. If a joiner's signal aborts (e.g. their `totalTimeout`
 * fires), they reject immediately — they don't have to wait for the
 * originator to finish. The originator's promise continues in the
 * background for any other joiners that haven't aborted.
 *
 * If `inflightTtl` is set, the store entry is also TTL'd: if the
 * originator never settles, new callers can start fresh after the TTL
 * expires (the original promise still leaks unless an outer timeout
 * fires, but new callers aren't blocked).
 *
 * # INVARIANT: requires SyncStateStore
 *
 * The read-then-write that makes deduplication work must happen in a single
 * synchronous frame. An async store would introduce an `await` between
 * `get()` and `set()`, letting two concurrent callers both see a miss and
 * both launch work. The `REQUIRES_SYNC_STORE` symbol on the returned
 * `PolicyApplier` lets `execute()` enforce this at runtime for JS callers
 * that bypass TypeScript.
 */
export declare function dedupePolicy<T>(opts?: DedupeOptions): PolicyApplier<T>;
//# sourceMappingURL=dedupe.d.ts.map