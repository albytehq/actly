import { redactMessage } from './redact.js'

/**
 * Actly error taxonomy: one abstract base plus concrete classes, each with a
 * stable `code`. `code` is the stable identifier for cross-realm consumers
 * (workers, vm) where `instanceof` fails.
 */

/** All `code` values produced by this package. */
const ACTLY_CODES = new Set([
  'ACTLY_ABORT',
  'ACTLY_TIMEOUT',
  'ACTLY_TOTAL_TIMEOUT',
  'ACTLY_RETRY_EXHAUSTED',
  'ACTLY_VALIDATION',
  'ACTLY_CIRCUIT_OPEN',
  'ACTLY_BULKHEAD_FULL',
  'ACTLY_RATE_LIMIT',
  'ACTLY_RESOURCE_EXHAUSTED',
  'ACTLY_HEDGE_TIMEOUT',
])

/**
 * Base for all actly errors. `instanceof` works within a single realm; for
 * cross-realm checks use `isActlyError` or switch on `.code`.
 */
export abstract class ActlyError extends Error {
  abstract readonly code: string
  readonly key?: string

  constructor(message: string, options?: { key?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    // Subclasses pin their own `this.name` string: `new.target.name` breaks
    // under minification (the class identifier is mangled), and esbuild's
    // `keepNames` was measured to cost ~30% on the policy path.
    this.name = new.target.name
    if (options?.key !== undefined) {
      Object.defineProperty(this, 'key', { value: options.key, enumerable: true })
    }
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /**
   * JSON serialization for log shipping. Picks up subclass fields via
   * `Object.keys(this)`. Pass `{ redact: true }` to HTML-escape and
   * length-cap the message.
   */
  toJSON(opts?: { redact?: boolean }): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: opts?.redact ? redactMessage(this.message) : this.message,
    }
    if (this.key !== undefined) obj.key = this.key
    if (this.stack !== undefined) obj.stack = this.stack
    for (const prop of Object.keys(this)) {
      if (!(prop in obj)) {
        try {
          obj[prop] = (this as Record<string, unknown>)[prop]
        } catch {
          // a throwing getter must not break toJSON
        }
      }
    }
    return obj
  }
}

/**
 * Realm-safe predicate: an Error-shaped object whose `code` is one of the
 * codes this package produces. Heuristic by necessity (codes are the public
 * contract); a deliberately forged `{ code, message }` cannot be told apart.
 */
export function isActlyError(e: unknown): e is ActlyError {
  if (e == null || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  if (typeof code !== 'string' || !code.startsWith('ACTLY_')) return false
  if (!ACTLY_CODES.has(code) && !(e instanceof ActlyError)) return false
  return typeof (e as { message?: unknown }).message === 'string'
}

/**
 * Sanitize an error for safe logging: redacts the message, preserves `name`,
 * `code`, `key`, and chains the original via `cause`.
 */
export function sanitizeError(err: unknown): unknown {
  if (err instanceof Error) {
    const sanitized = new Error(redactMessage(err.message))
    sanitized.name = err.name
    try { sanitized.stack = err.stack } catch { /* frozen error */ }
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
  return redactMessage(err)
}

/** Caller signal, per-attempt timeout, or total timeout aborted the call. */
export class ActlyAbortError extends ActlyError {
  readonly code = 'ACTLY_ABORT' as const

  constructor(options?: { key?: string; cause?: unknown }) {
    const causeMsg =
      options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? 'aborted')
    super(`Actly operation aborted: ${causeMsg}`, options)
    this.name = 'ActlyAbortError'
  }
}

/** Per-attempt `timeout` deadline fired. Carries the configured `ms`. */
export class TimeoutError extends ActlyError {
  readonly code = 'ACTLY_TIMEOUT' as const
  readonly ms: number

  constructor(ms: number, options?: { key?: string; cause?: unknown }) {
    super(`ACT timed out after ${ms}ms`, options)
    this.name = 'TimeoutError'
    this.ms = ms
  }
}

/** Operation-wide `totalTimeout` budget fired. */
export class TotalTimeoutError extends ActlyError {
  readonly code = 'ACTLY_TOTAL_TIMEOUT' as const
  readonly ms: number

  constructor(ms: number, options?: { key?: string; cause?: unknown }) {
    super(`ACT total timeout exceeded after ${ms}ms`, options)
    this.name = 'TotalTimeoutError'
    this.ms = ms
  }
}

/**
 * All retry attempts failed. `lastError` is the final attempt's error;
 * `errors` holds the recent history.
 */
export class RetryExhaustedError extends ActlyError {
  readonly code = 'ACTLY_RETRY_EXHAUSTED' as const
  readonly attempts: number
  readonly lastError: unknown
  readonly errors: readonly unknown[]

  constructor(options: {
    key?: string
    attempts: number
    lastError: unknown
    errors: readonly unknown[]
  }) {
    const lastMsg =
      options.lastError instanceof Error ? options.lastError.message : String(options.lastError)
    super(
      `ACT retry exhausted after ${options.attempts} attempts; last error: ${lastMsg}`,
      { key: options.key, cause: options.lastError },
    )
    this.name = 'RetryExhaustedError'
    this.attempts = options.attempts
    this.lastError = options.lastError
    this.errors = options.errors
  }
}

/**
 * Invalid options / keys / store contract. Programmer error: throws
 * synchronously from `act()` before any work starts.
 */
export class ValidationError extends ActlyError {
  readonly code = 'ACTLY_VALIDATION' as const

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super(message, options)
    this.name = 'ValidationError'
    if (options?.field !== undefined) {
      Object.defineProperty(this, 'field', { value: options.field, enumerable: true })
    }
  }
  readonly field?: string
}

/** Thrown when a circuit breaker is open and blocks the call. */
export class CircuitBreakerOpenError extends ActlyError {
  readonly code = 'ACTLY_CIRCUIT_OPEN' as const
  declare readonly key: string

  constructor(key: string, ms: number, options?: { cause?: unknown }) {
    super(`Circuit breaker open for key "${key}" — retry after ${ms}ms`, { key, cause: options?.cause })
    this.name = 'CircuitBreakerOpenError'
  }
}

/** Thrown when a bulkhead is full. */
export class BulkheadOverflowError extends ActlyError {
  readonly code = 'ACTLY_BULKHEAD_FULL' as const
  declare readonly key: string

  constructor(key: string, maxConcurrent: number, options?: { cause?: unknown }) {
    super(`Bulkhead full for key "${key}" — maxConcurrent ${maxConcurrent} reached`, { key, cause: options?.cause })
    this.name = 'BulkheadOverflowError'
  }
}

/** Thrown when a rate limit is exceeded. */
export class RateLimitError extends ActlyError {
  readonly code = 'ACTLY_RATE_LIMIT' as const
  declare readonly key: string

  constructor(key: string, maxCalls: number, windowMs: number, options?: { cause?: unknown }) {
    super(`Rate limit exceeded for key "${key}" — ${maxCalls} calls per ${windowMs}ms`, { key, cause: options?.cause })
    this.name = 'RateLimitError'
  }
}

/**
 * Process-wide in-flight count exceeded `LIMITS.MAX_GLOBAL_INFLIGHT`.
 * Opt out via `ACTLY_NO_INFLIGHT_LIMIT=1` before the first `act()` call.
 */
export class ResourceExhaustedError extends ActlyError {
  readonly code = 'ACTLY_RESOURCE_EXHAUSTED' as const
  readonly current: number
  readonly limit: number

  constructor(current: number, limit: number, options?: { cause?: unknown }) {
    super(
      `Actly: resource exhausted — ${current} in-flight calls exceed process limit ${limit}. ` +
      `Set ACTLY_NO_INFLIGHT_LIMIT=1 to disable this guard (at your own risk).`,
      options,
    )
    this.name = 'ResourceExhaustedError'
    this.current = current
    this.limit = limit
  }
}

/**
 * Marks a hedged call as timed out. Not thrown by actly's own hedge race
 * (the window is internal control flow): construct it in user code to
 * surface a downstream hedge deadline, e.g. when rethrowing the error of
 * a nested `act()` call. A user-thrown instance propagates like any other
 * failure — it never triggers a hedge launch.
 */
export class HedgeTimeoutError extends ActlyError {
  readonly code = 'ACTLY_HEDGE_TIMEOUT' as const
  readonly delayMs: number

  constructor(options?: { key?: string; delayMs?: number; cause?: unknown }) {
    const ms = options?.delayMs ?? 0
    super(`ACT hedge timed out after ${ms}ms`, options)
    this.name = 'HedgeTimeoutError'
    this.delayMs = ms
  }
}

export { redactMessage as sanitizeErrorMessage }
