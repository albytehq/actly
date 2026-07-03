/**
 * Key sanitisation — the first line of defence against:
 *
 *  - **Prototype pollution**: `__proto__`, `constructor`, `prototype` as keys
 *    bypass namespace isolation in plain-object store adapters.
 *  - **Control-char injection**: `\x00`–`\x1f`, `\x7f` break some store
 *    backends (Redis Lua, HTTP header logs, JSON-LD contexts).
 *  - **CRLF injection**: `\r\n` in keys can break naive log/HTTP serializers.
 *  - **Memory exhaustion**: unbounded key length lets a caller store a 10MB
 *    string as a key, bloating the store and blocking iteration.
 *  - **Namespace collision**: user keys starting with `dedupe:`, `cache:`,
 *    or `__inflight:` would clobber internal slots.
 *
 * # Why a dedicated module?
 *
 * Key validation is security-sensitive. Centralising it here means every
 * call site (`act()`, `invalidate()`, `withStore().invalidate()`) applies
 * the same rules. Local inlining risks drift.
 */
/**
 * Validate a user-supplied key. Throws synchronously on invalid input.
 *
 * Programmer errors throw — they must not be swallowed into an `ActFailure`
 * because the caller's code is broken.
 *
 * @returns the same `key` (for chaining); never transforms it.
 */
export declare function sanitizeKey(key: string): string;
//# sourceMappingURL=key.d.ts.map