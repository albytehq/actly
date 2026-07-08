"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HedgeTimeoutError = exports.ResourceExhaustedError = exports.RateLimitError = exports.BulkheadOverflowError = exports.CircuitBreakerOpenError = exports.ValidationError = exports.RetryExhaustedError = exports.TotalTimeoutError = exports.TimeoutError = exports.ActlyAbortError = exports.ActlyError = void 0;
exports.isActlyError = isActlyError;
class ActlyError extends Error {
    key;
    constructor(message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        if (options?.key !== undefined) {
            Object.defineProperty(this, 'key', { value: options.key, enumerable: true });
        }
        Object.setPrototypeOf(this, new.target.prototype);
    }
    toJSON(opts) {
        const obj = {
            name: this.name,
            code: this.code,
            message: opts?.redact ? sanitizeErrorMessageForJSON(this.message) : this.message,
        };
        if (this.key !== undefined)
            obj.key = this.key;
        if (this.stack !== undefined)
            obj.stack = this.stack;
        for (const prop of Object.keys(this)) {
            if (!(prop in obj)) {
                try {
                    obj[prop] = this[prop];
                }
                catch {
                }
            }
        }
        return obj;
    }
}
exports.ActlyError = ActlyError;
function isActlyError(e) {
    return (e != null &&
        typeof e === 'object' &&
        typeof e.code === 'string' &&
        String(e.code).startsWith('ACTLY_'));
}
function sanitizeErrorMessageForJSON(msg) {
    let str;
    if (msg instanceof Error) {
        str = String(msg.message ?? '');
    }
    else {
        str = String(msg ?? '');
    }
    if (str.length > 4096)
        str = str.slice(0, 4096) + '…[truncated]';
    return str.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
}
class ActlyAbortError extends ActlyError {
    code = 'ACTLY_ABORT';
    constructor(options) {
        const causeMsg = options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? 'aborted');
        super(`Actly operation aborted: ${causeMsg}`, options);
    }
}
exports.ActlyAbortError = ActlyAbortError;
class TimeoutError extends ActlyError {
    code = 'ACTLY_TIMEOUT';
    ms;
    constructor(ms, options) {
        super(`ACT timed out after ${ms}ms`, options);
        this.ms = ms;
    }
}
exports.TimeoutError = TimeoutError;
class TotalTimeoutError extends ActlyError {
    code = 'ACTLY_TOTAL_TIMEOUT';
    ms;
    constructor(ms, options) {
        super(`ACT total timeout exceeded after ${ms}ms`, options);
        this.ms = ms;
    }
}
exports.TotalTimeoutError = TotalTimeoutError;
class RetryExhaustedError extends ActlyError {
    code = 'ACTLY_RETRY_EXHAUSTED';
    attempts;
    lastError;
    errors;
    constructor(options) {
        const lastMsg = options.lastError instanceof Error ? options.lastError.message : String(options.lastError);
        super(`ACT retry exhausted after ${options.attempts} attempts; last error: ${lastMsg}`, { key: options.key, cause: options.lastError });
        this.attempts = options.attempts;
        this.lastError = options.lastError;
        this.errors = options.errors;
    }
}
exports.RetryExhaustedError = RetryExhaustedError;
class ValidationError extends ActlyError {
    code = 'ACTLY_VALIDATION';
    constructor(message, options) {
        super(message, options);
        if (options?.field !== undefined) {
            Object.defineProperty(this, 'field', { value: options.field, enumerable: true });
        }
    }
    field;
}
exports.ValidationError = ValidationError;
class CircuitBreakerOpenError extends ActlyError {
    code = 'ACTLY_CIRCUIT_OPEN';
    constructor(key, ms, options) {
        super(`Circuit breaker open for key "${key}" — retry after ${ms}ms`, { key, cause: options?.cause });
    }
}
exports.CircuitBreakerOpenError = CircuitBreakerOpenError;
class BulkheadOverflowError extends ActlyError {
    code = 'ACTLY_BULKHEAD_FULL';
    constructor(key, maxConcurrent, options) {
        super(`Bulkhead full for key "${key}" — maxConcurrent ${maxConcurrent} reached`, { key, cause: options?.cause });
    }
}
exports.BulkheadOverflowError = BulkheadOverflowError;
class RateLimitError extends ActlyError {
    code = 'ACTLY_RATE_LIMIT';
    constructor(key, maxCalls, windowMs, options) {
        super(`Rate limit exceeded for key "${key}" — ${maxCalls} calls per ${windowMs}ms`, { key, cause: options?.cause });
    }
}
exports.RateLimitError = RateLimitError;
class ResourceExhaustedError extends ActlyError {
    code = 'ACTLY_RESOURCE_EXHAUSTED';
    current;
    limit;
    constructor(current, limit, options) {
        super(`Actly: resource exhausted — ${current} in-flight calls exceed process limit ${limit}. ` +
            `Set ACTLY_NO_INFLIGHT_LIMIT=1 to disable this guard (at your own risk).`, options);
        this.current = current;
        this.limit = limit;
    }
}
exports.ResourceExhaustedError = ResourceExhaustedError;
class HedgeTimeoutError extends ActlyError {
    code = 'ACTLY_HEDGE_TIMEOUT';
    delayMs;
    constructor(options) {
        const ms = options?.delayMs ?? 0;
        super(`ACT hedge timed out after ${ms}ms`, options);
        this.delayMs = ms;
    }
}
exports.HedgeTimeoutError = HedgeTimeoutError;
