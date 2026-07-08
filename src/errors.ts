/**
 * Actly error taxonomy.
 *
 * One abstract base plus nine concrete classes. Each carries a stable
 * `code` so consumers can switch on strings instead of `instanceof`
 * across realm boundaries (workers, vm modules, iframes).
 *
 * `code` is the stable identifier - class names may shift across versions.
 */

/**
 * Base for all actly errors. `instanceof ActlyError` works within a single
 * realm; for cross-realm (worker_threads, vm, iframes) switch on `.code`
 * or use the `isActlyError(e)` helper.
 */
export abstract class ActlyError extends Error {
  /** Stable identifier for telemetry / switch statements. */
  abstract readonly code: string
  /** Key associated with the failure, if applicable. */
  readonly key?: string

  constructor(message: string, options?: { key?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = new.target.name
    if (options?.key !== undefined) {
      Object.defineProperty(this, 'key', { value: options.key, enumerable: true })
    }
    // es2022 targets can strip the Error prototype chain; restore it.
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /**
   * JSON serialization for log shipping. Picks up subclass fields
   * (attempts, ms, current, limit, ...) via Object.keys(this).
   * Pass `{ redact: true }` to HTML-escape + length-cap the message.
   */
  toJSON(opts?: { redact?: boolean }): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: opts?.redact ? sanitizeErrorMessageForJSON(this.message) : this.message,
    }
    if (this.key !== undefined) obj.key = this.key
    if (this.stack !== undefined) obj.stack = this.stack
    // Pull in subclass-specific own props (attempts, lastError, errors,
    // ms, current, limit, field). Error's own fields are non-enumerable
    // so they won't shadow what we set above.
    for (const prop of Object.keys(this)) {
      if (!(prop in obj)) {
        try {
          obj[prop] = (this as Record<string, unknown>)[prop]
        } catch {
          // a throwing getter shouldn't break toJSON
        }
      }
    }
    return obj
  }
}

/**
 * Realm-safe predicate: checks `.code` starts with `ACTLY_`. Use this
 * instead of `instanceof ActlyError` when crossing realms.
 */
export function isActlyError(e: unknown): e is ActlyError {
  return (
    e != null &&
    typeof e === 'object' &&
    typeof (e as { code?: unknown }).code === 'string' &&
    String((e as { code?: unknown }).code).startsWith('ACTLY_')
  )
}

// Inline copy of sanitizeErrorMessage to avoid a circular import
// (errors.ts is imported by utils/sanitize.ts).
function sanitizeErrorMessageForJSON(msg: unknown): string {
  let str: string
  if (msg instanceof Error) {
    str = String(msg.message ?? '')
  } else {
    str = String(msg ?? '')
  }
  if (str.length > 4096) str = str.slice(0, 4096) + '…[truncated]'
  return str.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
}

/**
 * Caller signal, per-attempt timeout, or total timeout aborted the call.
 * `cause` carries the original abort reason.
 */
export class ActlyAbortError extends ActlyError {
  readonly code = 'ACTLY_ABORT' as const

  constructor(options?: { key?: string; cause?: unknown }) {
    const causeMsg =
      options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? 'aborted')
    super(`Actly operation aborted: ${causeMsg}`, options)
  }
}

/**
 * Per-attempt `timeout` deadline fired. Carries the configured `ms`.
 *
 * @example
 * if (!result.ok && result.error instanceof TimeoutError) {
 *   console.log(`attempt timed out after ${result.error.ms}ms`)
 * }
 */
export class TimeoutError extends ActlyError {
  readonly code = 'ACTLY_TIMEOUT' as const
  readonly ms: number

  constructor(ms: number, options?: { key?: string; cause?: unknown }) {
    super(`ACT timed out after ${ms}ms`, options)
    this.ms = ms
  }
}

/**
 * Operation-wide `totalTimeout` budget fired. Distinct from `TimeoutError`
 * (per-attempt) so callers can tell which deadline tripped.
 */
export class TotalTimeoutError extends ActlyError {
  readonly code = 'ACTLY_TOTAL_TIMEOUT' as const
  readonly ms: number

  constructor(ms: number, options?: { key?: string; cause?: unknown }) {
    super(`ACT total timeout exceeded after ${ms}ms`, options)
    this.ms = ms
  }
}

/**
 * All retry attempts failed. `lastError` is the final attempt's error;
 * `errors` holds the full history for debugging patterns across retries.
 *
 * Thrown only when `attempts > 1`, every attempt failed, and `shouldRetry`
 * returned true for at least one failure. If `shouldRetry` returns false
 * on the first attempt the raw error is thrown (no retries = not exhausted).
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
    this.attempts = options.attempts
    this.lastError = options.lastError
    this.errors = options.errors
  }
}

/**
 * Invalid options / keys / store contract. Programmer error - surfaces
 * synchronously rather than as an ActFailure because the caller's code
 * is broken.
 */
export class ValidationError extends ActlyError {
  readonly code = 'ACTLY_VALIDATION' as const

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super(message, options)
    if (options?.field !== undefined) {
      Object.defineProperty(this, 'field', { value: options.field, enumerable: true })
    }
  }
  readonly field?: string
}

// ─── Hardening error classes ─────────────────────────────────────────────────

/** Thrown when a circuit breaker is open and blocks the call. */
export class CircuitBreakerOpenError extends ActlyError {
  readonly code = 'ACTLY_CIRCUIT_OPEN' as const
  declare readonly key: string

  constructor(key: string, ms: number, options?: { cause?: unknown }) {
    super(`Circuit breaker open for key "${key}" — retry after ${ms}ms`, { key, cause: options?.cause })
  }
}

/** Thrown when a bulkhead is full (maxConcurrent reached, queue timed out). */
export class BulkheadOverflowError extends ActlyError {
  readonly code = 'ACTLY_BULKHEAD_FULL' as const
  declare readonly key: string

  constructor(key: string, maxConcurrent: number, options?: { cause?: unknown }) {
    super(`Bulkhead full for key "${key}" — maxConcurrent ${maxConcurrent} reached`, { key, cause: options?.cause })
  }
}

/** Thrown when a rate limit is exceeded. */
export class RateLimitError extends ActlyError {
  readonly code = 'ACTLY_RATE_LIMIT' as const
  declare readonly key: string

  constructor(key: string, maxCalls: number, windowMs: number, options?: { cause?: unknown }) {
    super(`Rate limit exceeded for key "${key}" — ${maxCalls} calls per ${windowMs}ms`, { key, cause: options?.cause })
  }
}

/**
 * Process-wide in-flight `act()` count exceeded `LIMITS.MAX_GLOBAL_INFLIGHT`
 * (default 100_000). Self-DoS guard: a buggy caller spawning unbounded
 * concurrent calls would otherwise exhaust memory and event-loop slots.
 *
 * Rejects synchronously as an ActFailure with `failedBy: 'validation'`.
 * Set `ACTLY_NO_INFLIGHT_LIMIT=1` to opt out (process-wide, intentional).
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
    this.current = current
    this.limit = limit
  }
}

/**
 * Neither the primary nor the hedge settled before `hedge.delayMs` elapsed
 * (after the hedge was dispatched). Carries the configured `delayMs`.
 */
export class HedgeTimeoutError extends ActlyError {
  readonly code = 'ACTLY_HEDGE_TIMEOUT' as const
  readonly delayMs: number

  constructor(options?: { key?: string; delayMs?: number; cause?: unknown }) {
    const ms = options?.delayMs ?? 0
    super(`ACT hedge timed out after ${ms}ms`, options)
    this.delayMs = ms
  }
}
