import type { PolicyApplier, DedupeOptions } from '../types/index.js';
/**
 * Collapse concurrent calls that share the same key into one in-flight Promise.
 *
 * # Properties
 *
 *  - **Generation-safe cleanup**: stale originators never delete newer
 *    entries when `inflightTtl` triggers replacement.
 *  - **Joiner isolation**: originator's caller-signal abort does NOT
 *    propagate to joiners. Each joiner races the shared in-flight promise
 *    against their OWN signal only.
 *  - **Truthful joiner attempts**: joiners that abort before the originator
 *    settles report `attempts: 0` (they did no work), not the originator's
 *    in-progress count.
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