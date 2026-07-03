const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/g
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }

export function sanitizeErrorMessage(msg: unknown): string {
  let str: string
  if (msg instanceof Error) {
    str = msg.message
  } else if (typeof msg === 'string') {
    str = msg
  } else {
    str = String(msg ?? '')
  }
  str = str.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c as keyof typeof HTML_ENTITIES])
  str = str.replace(FORBIDDEN_CHARS, '')
  return str
}

export function sanitizeError(err: unknown): unknown {
  if (err instanceof Error) {
    const sanitized = new Error(sanitizeErrorMessage(err.message))
    sanitized.name = err.name
    return sanitized
  }
  return sanitizeErrorMessage(err)
}
