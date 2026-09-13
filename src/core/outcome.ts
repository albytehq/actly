import type { ActlyFailedBy, ActSource, AuditOptions } from '../types.js'
import { sanitizeError, sanitizeErrorMessage } from '../errors.js'
import type { FinalFailureEvent, ObservabilityContext } from '../observability.js'
import { safeCall } from '../safeCall.js'
import { recordError, recordSuccess } from './health.js'

/**
 * Map a caught error to its `failedBy` bucket. Code-string checks keep this
 * realm-safe; `instanceof Error` gates the name sniffing so plain objects
 * cannot spoof it.
 */
export function classifyFailure(error: unknown): ActlyFailedBy {
  if (error == null || typeof error !== 'object') return 'fn-error'
  const code = (error as { code?: string }).code
  switch (code) {
    case 'ACTLY_ABORT':                return 'abort'
    case 'ACTLY_TIMEOUT':              return 'timeout'
    case 'ACTLY_TOTAL_TIMEOUT':        return 'total-timeout'
    case 'ACTLY_RETRY_EXHAUSTED':      return 'retry-exhausted'
    case 'ACTLY_VALIDATION':           return 'validation'
    case 'ACTLY_CIRCUIT_OPEN':         return 'circuit-open'
    case 'ACTLY_BULKHEAD_FULL':        return 'bulkhead-full'
    case 'ACTLY_RATE_LIMIT':           return 'rate-limited'
    case 'ACTLY_RESOURCE_EXHAUSTED':   return 'resource-exhausted'
    case 'ACTLY_HEDGE_TIMEOUT':        return 'hedge-timeout'
  }
  if (error instanceof Error && (error as { name?: string }).name === 'AbortError') {
    return 'abort'
  }
  return 'fn-error'
}

/**
 * One place that reports an outcome: health recording, observability
 * final-event, and the audit entry. Previously this triple was copy-pasted
 * at every exit point of act()/scopedAct() and had already drifted.
 */
export interface ReportContext {
  scope: string
  key: string
  observability?: ObservabilityContext
  effectiveTraceId?: string
  audit?: AuditOptions
}

function emitFinalFailure(
  rc: ReportContext,
  failedBy: ActlyFailedBy,
  error: unknown,
  attempts: number,
  durationMs: number,
  fallbackError?: unknown,
): void {
  if (rc.observability) {
    const event: FinalFailureEvent = {
      type: 'final-failure',
      key: rc.key,
      traceId: rc.observability.traceId,
      timestamp: Date.now(),
      attempts,
      durationMs,
      failedBy,
      error,
      ...(fallbackError !== undefined && { fallbackError }),
    }
    safeCall(rc.observability.hooks.onFinalFailure, event)
  }
  if (rc.audit) {
    safeCall(rc.audit.log, {
      key: rc.key,
      traceId: rc.effectiveTraceId ?? '',
      timestamp: Date.now(),
      durationMs,
      ok: false,
      attempts,
      failedBy,
      error: sanitizeError(error),
    })
  }
}

/** Record health state, emit the final event, and write the audit entry. */
export function reportFailure(
  rc: ReportContext,
  failedBy: ActlyFailedBy,
  error: unknown,
  attempts: number,
  durationMs: number,
): void {
  recordError(rc.scope, failedBy, sanitizeErrorMessage(error))
  emitFinalFailure(rc, failedBy, error, attempts, durationMs)
}

/**
 * Emit the final event and audit entry without touching health state.
 * `fallbackError` is set when a fallback was configured and itself threw;
 * the surfaced error is still the original one.
 */
export function reportFailureNoRecord(
  rc: ReportContext,
  failedBy: ActlyFailedBy,
  error: unknown,
  attempts: number,
  durationMs: number,
  fallbackError?: unknown,
): void {
  emitFinalFailure(rc, failedBy, error, attempts, durationMs, fallbackError)
}

/** Record success, emit the final event, and write the audit entry. */
export function reportSuccess(
  rc: ReportContext,
  source: ActSource,
  attempts: number,
  durationMs: number,
): void {
  recordSuccess(rc.scope)
  emitFinalSuccess(rc, source, attempts, durationMs)
}

/**
 * Emit success without recording health state: used when a fallback
 * produced the value — health keeps the masked downstream failure visible.
 */
export function reportFallbackSuccess(
  rc: ReportContext,
  source: ActSource,
  attempts: number,
  durationMs: number,
): void {
  emitFinalSuccess(rc, source, attempts, durationMs)
}

function emitFinalSuccess(
  rc: ReportContext,
  source: ActSource,
  attempts: number,
  durationMs: number,
): void {
  if (rc.observability) {
    safeCall(rc.observability.hooks.onFinalSuccess, {
      type: 'final-success',
      key: rc.key,
      traceId: rc.observability.traceId,
      timestamp: Date.now(),
      source,
      attempts,
      durationMs,
    })
  }
  if (rc.audit) {
    safeCall(rc.audit.log, {
      key: rc.key,
      traceId: rc.effectiveTraceId ?? '',
      timestamp: Date.now(),
      durationMs,
      ok: true,
      attempts,
    })
  }
}
