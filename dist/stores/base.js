// ─── Store interfaces ─────────────────────────────────────────────────────────
// ─── Type guards ──────────────────────────────────────────────────────────────
/**
 * Narrows `AnyStateStore` to `SyncStateStore` via the `_sync` discriminant.
 * Used by `execute()` and `cachePolicy` to branch between sync and async paths.
 */
export function isSyncStore(store) {
    return store._sync === true;
}
/**
 * Narrows `AnyStateStore` to `AsyncStateStore` via the `_sync` discriminant.
 * Provided for symmetry; prefer `isSyncStore` for the common guard pattern.
 */
export function isAsyncStore(store) {
    return store._sync === false;
}
//# sourceMappingURL=base.js.map