import { LIMITS } from './limits.js'

const RESERVED_PREFIXES = ['dedupe:', 'cache:', 'inflight:', 'tenant:'] as const

const FORBIDDEN_LITERALS = new Set([
  '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString',
  'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
])

// C0 controls, DEL, CR; LF and TAB stay allowed for structured keys.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHAR = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/

/**
 * Validate a user-supplied key. Throws synchronously on invalid input.
 * Rejects prototype-pollution vectors, control characters, reserved
 * internal prefixes, and keys over {@link LIMITS.MAX_KEY_LENGTH}.
 * @returns the same `key`; never transforms it.
 */
export function sanitizeKey(key: string): string {
  if (typeof key !== 'string') {
    throw new TypeError(`Actly: key must be a string, got ${key === null ? 'null' : typeof key}`)
  }
  if (key.length === 0) {
    throw new RangeError(
      'Actly: key must be non-empty. An empty key collapses every caller onto the same dedupe/cache slot.',
    )
  }
  if (key.length > LIMITS.MAX_KEY_LENGTH) {
    throw new RangeError(
      `Actly: key length ${key.length} exceeds limit ${LIMITS.MAX_KEY_LENGTH}. Hash externally if you need longer keys.`,
    )
  }
  if (FORBIDDEN_LITERALS.has(key)) {
    throw new RangeError(
      `Actly: key ${JSON.stringify(key)} is forbidden (prototype-pollution vector).`,
    )
  }
  if (UNSAFE_CHAR.test(key)) {
    throw new RangeError(
      `Actly: key contains control characters or CRLF. Got ${JSON.stringify(key)}.`,
    )
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw new RangeError(
        `Actly: key must not start with reserved prefix "${prefix}" (got ${JSON.stringify(key)}).`,
      )
    }
  }
  return key
}
