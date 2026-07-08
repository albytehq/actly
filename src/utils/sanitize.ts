import { LIMITS } from './limits.js'
import { ActlyError } from '../errors.js'

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/g
// eslint-disable-next-line @typescript-eslint/naming-convention
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' } as const

export function sanitizeErrorMessage(msg: unknown): string {
  let str: string
  if (msg instanceof Error) {
    // Error.message is typed as string but can be assigned anything at
    // runtime - coerce so .replace can't crash the audit path.
    str = String(msg.message ?? '')
  } else if (typeof msg === 'string') {
    str = msg
  } else {
    str = String(msg ?? '')
  }
  str = str.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c as keyof typeof HTML_ENTITIES])
  str = str.replace(FORBIDDEN_CHARS, '')
  // Cap so a 10MB error message can't bloat health state or audit logs.
  if (str.length > LIMITS.MAX_SANITIZED_ERROR_LENGTH) {
    str = str.slice(0, LIMITS.MAX_SANITIZED_ERROR_LENGTH - 3) + '...'
  }
  return str
}

/**
 * Sanitize an error for safe logging / serialisation. Preserves the
 * stable `code` and `key` fields from ActlyError so operators switching
 * on `entry.error.code` keep working, and chains the original via `cause`
 * so debuggers can still find the real throw site.
 */
export function sanitizeError(err: unknown): unknown {
  if (err instanceof Error) {
    const sanitized = new Error(sanitizeErrorMessage(err.message))
    sanitized.name = err.name
    try { sanitized.stack = err.stack } catch { /* frozen/sealed error */ }
    if (err instanceof ActlyError) {
      const code = (err as ActlyError).code
      const key = (err as ActlyError).key
      Object.defineProperty(sanitized, 'code', { value: code, enumerable: true })
      if (key !== undefined) {
        Object.defineProperty(sanitized, 'key', { value: key, enumerable: true })
      }
    }
    try {
      Object.defineProperty(sanitized, 'cause', { value: err, enumerable: false })
    } catch { /* old runtimes */ }
    return sanitized
  }
  return sanitizeErrorMessage(err)
}
