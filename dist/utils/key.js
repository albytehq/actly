import { LIMITS } from './limits.js';
const RESERVED_PREFIXES = ['dedupe:', 'cache:', 'inflight:', 'tenant:'];
const FORBIDDEN_LITERALS = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'hasOwnProperty',
    'toString',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
]);
const UNSAFE_CHAR = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/;
export function sanitizeKey(key) {
    if (typeof key !== 'string') {
        throw new TypeError(`Actly: key must be a string, got ${key === null ? 'null' : typeof key}`);
    }
    if (key.length === 0) {
        throw new RangeError("Actly: key must be non-empty. An empty key collapses every caller " +
            "onto the same dedupe/cache slot — almost certainly a bug.");
    }
    if (key.length > LIMITS.MAX_KEY_LENGTH) {
        throw new RangeError(`Actly: key length ${key.length} exceeds limit ${LIMITS.MAX_KEY_LENGTH}. ` +
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
