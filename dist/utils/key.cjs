"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeKey = sanitizeKey;
const limits_js_1 = require("./limits.js");
const RESERVED_PREFIXES = ['dedupe:', 'cache:', '__inflight:', '__tenant:', 'tenant:'];
/**
 * Strings that, if used as Map keys, are safe — but if used as plain-object
 * keys (e.g. a naive store adapter) enable prototype pollution. Reject them
 * regardless of store type: the contract is "your key is safe everywhere".
 */
const FORBIDDEN_LITERALS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Reject any character in the C0 control range, DEL (0x7f), or CRLF.
 * Allow TAB (0x09) and LF (0x0a) since some callers embed newlines in
 * structured keys legitimately — but CR is always forbidden.
 */
const UNSAFE_CHAR = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/;
/**
 * Validate a user-supplied key. Throws synchronously on invalid input.
 *
 * Programmer errors throw — they must not be swallowed into an `ActFailure`
 * because the caller's code is broken.
 *
 * @returns the same `key` (for chaining); never transforms it.
 */
function sanitizeKey(key) {
    if (typeof key !== 'string') {
        throw new TypeError(`Actly: key must be a string, got ${typeName(key)}`);
    }
    if (key.length === 0) {
        throw new RangeError("Actly: key must be non-empty. An empty key collapses every caller " +
            "onto the same dedupe/cache slot — almost certainly a bug.");
    }
    if (key.length > limits_js_1.LIMITS.MAX_KEY_LENGTH) {
        throw new RangeError(`Actly: key length ${key.length} exceeds limit ${limits_js_1.LIMITS.MAX_KEY_LENGTH}. ` +
            `Long keys bloat stores and slow iteration. Hash externally if you need longer keys.`);
    }
    if (FORBIDDEN_LITERALS.has(key)) {
        throw new RangeError(`Actly: key ${JSON.stringify(key)} is forbidden (prototype-pollution vector). ` +
            `Pick a different key.`);
    }
    if (UNSAFE_CHAR.test(key)) {
        throw new RangeError(`Actly: key contains control characters or CRLF, which break store backends ` +
            `and log serializers. Got ${JSON.stringify(key)}.`);
    }
    for (const prefix of RESERVED_PREFIXES) {
        if (key.startsWith(prefix)) {
            throw new RangeError(`Actly: key must not start with reserved prefix "${prefix}" ` +
                `(got ${JSON.stringify(key)}). These namespaces are used internally.`);
        }
    }
    return key;
}
function typeName(v) {
    if (v === null)
        return 'null';
    return typeof v;
}
