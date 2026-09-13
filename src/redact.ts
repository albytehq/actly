import { LIMITS } from './limits.js'

// eslint-disable-next-line @typescript-eslint/naming-convention
const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const ENTITY_TEST = /[&<>"']/
const ENTITY_REPLACE = /[&<>"']/g

/**
 * Escape an arbitrary message for safe logging and serialization.
 * Strips control characters, HTML-escapes five entities, caps length.
 * The only message-redaction implementation in the package: `ActlyError.toJSON`
 * and health-state recording share it so behaviour cannot drift.
 */
export function redactMessage(msg: unknown, maxLength: number = LIMITS.MAX_SANITIZED_ERROR_LENGTH): string {
  let str: string
  if (msg instanceof Error) {
    str = String(msg.message ?? '')
  } else if (typeof msg === 'string') {
    str = msg
  } else {
    str = String(msg ?? '')
  }
  if (ENTITY_TEST.test(str)) {
    str = str.replace(ENTITY_REPLACE, (c) => HTML_ENTITIES[c]!)
  }
  if (CONTROL_CHARS.test(str)) {
    str = str.replace(CONTROL_CHARS, '')
    CONTROL_CHARS.lastIndex = 0
  }
  if (str.length > maxLength) {
    str = str.slice(0, maxLength - 3) + '...'
  }
  return str
}
