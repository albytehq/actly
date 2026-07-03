"use strict";
// ─── Primary API ──────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.poolSize = exports.releaseController = exports.acquireController = exports.sanitizeError = exports.sanitizeErrorMessage = exports.createAsyncTenantStore = exports.createTenantStore = exports.drain = exports.createHealthCheck = exports.RateLimitError = exports.BulkheadOverflowError = exports.CircuitBreakerOpenError = exports.LIMITS = exports.computeDelay = exports.sanitizeKey = exports.isAbortError = exports.linkSignal = exports.sleep = exports.raceAbort = exports.anySignal = exports.ValidationError = exports.RetryExhaustedError = exports.TotalTimeoutError = exports.TimeoutError = exports.ActlyAbortError = exports.ActlyError = exports.isAsyncStore = exports.isSyncStore = exports.InMemoryStore = exports.REQUIRES_SYNC_STORE = exports.execute = exports.withStore = exports.invalidate = exports.act = void 0;
var act_js_1 = require("./core/act.js");
Object.defineProperty(exports, "act", { enumerable: true, get: function () { return act_js_1.act; } });
Object.defineProperty(exports, "invalidate", { enumerable: true, get: function () { return act_js_1.invalidate; } });
Object.defineProperty(exports, "withStore", { enumerable: true, get: function () { return act_js_1.withStore; } });
// ─── Execution engine (for custom policy chains) ──────────────────────────────
var executor_js_1 = require("./core/executor.js");
Object.defineProperty(exports, "execute", { enumerable: true, get: function () { return executor_js_1.execute; } });
Object.defineProperty(exports, "REQUIRES_SYNC_STORE", { enumerable: true, get: function () { return executor_js_1.REQUIRES_SYNC_STORE; } });
// ─── Stores ───────────────────────────────────────────────────────────────────
var memory_js_1 = require("./stores/memory.js");
Object.defineProperty(exports, "InMemoryStore", { enumerable: true, get: function () { return memory_js_1.InMemoryStore; } });
var base_js_1 = require("./stores/base.js");
Object.defineProperty(exports, "isSyncStore", { enumerable: true, get: function () { return base_js_1.isSyncStore; } });
Object.defineProperty(exports, "isAsyncStore", { enumerable: true, get: function () { return base_js_1.isAsyncStore; } });
// ─── Error classes ────────────────────────────────────────────────────────────
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "ActlyError", { enumerable: true, get: function () { return errors_js_1.ActlyError; } });
Object.defineProperty(exports, "ActlyAbortError", { enumerable: true, get: function () { return errors_js_1.ActlyAbortError; } });
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return errors_js_1.TimeoutError; } });
Object.defineProperty(exports, "TotalTimeoutError", { enumerable: true, get: function () { return errors_js_1.TotalTimeoutError; } });
Object.defineProperty(exports, "RetryExhaustedError", { enumerable: true, get: function () { return errors_js_1.RetryExhaustedError; } });
Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function () { return errors_js_1.ValidationError; } });
// ─── Utilities (for custom policy authors) ────────────────────────────────────
var abort_js_1 = require("./utils/abort.js");
Object.defineProperty(exports, "anySignal", { enumerable: true, get: function () { return abort_js_1.anySignal; } });
Object.defineProperty(exports, "raceAbort", { enumerable: true, get: function () { return abort_js_1.raceAbort; } });
Object.defineProperty(exports, "sleep", { enumerable: true, get: function () { return abort_js_1.sleep; } });
Object.defineProperty(exports, "linkSignal", { enumerable: true, get: function () { return abort_js_1.linkSignal; } });
Object.defineProperty(exports, "isAbortError", { enumerable: true, get: function () { return abort_js_1.isAbortError; } });
var key_js_1 = require("./utils/key.js");
Object.defineProperty(exports, "sanitizeKey", { enumerable: true, get: function () { return key_js_1.sanitizeKey; } });
var backoff_js_1 = require("./utils/backoff.js");
Object.defineProperty(exports, "computeDelay", { enumerable: true, get: function () { return backoff_js_1.computeDelay; } });
var limits_js_1 = require("./utils/limits.js");
Object.defineProperty(exports, "LIMITS", { enumerable: true, get: function () { return limits_js_1.LIMITS; } });
// ─── Hardening: new error classes ────────────────────────────────────────────
var errors_js_2 = require("./errors.js");
Object.defineProperty(exports, "CircuitBreakerOpenError", { enumerable: true, get: function () { return errors_js_2.CircuitBreakerOpenError; } });
Object.defineProperty(exports, "BulkheadOverflowError", { enumerable: true, get: function () { return errors_js_2.BulkheadOverflowError; } });
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function () { return errors_js_2.RateLimitError; } });
// ─── Hardening: health check & graceful shutdown ─────────────────────────────
var health_js_1 = require("./core/health.js");
Object.defineProperty(exports, "createHealthCheck", { enumerable: true, get: function () { return health_js_1.createHealthCheck; } });
var shutdown_js_1 = require("./core/shutdown.js");
Object.defineProperty(exports, "drain", { enumerable: true, get: function () { return shutdown_js_1.drain; } });
// ─── Hardening: tenant isolation ─────────────────────────────────────────────
var tenant_js_1 = require("./core/tenant.js");
Object.defineProperty(exports, "createTenantStore", { enumerable: true, get: function () { return tenant_js_1.createTenantStore; } });
Object.defineProperty(exports, "createAsyncTenantStore", { enumerable: true, get: function () { return tenant_js_1.createAsyncTenantStore; } });
// ─── Hardening: error sanitization ───────────────────────────────────────────
var sanitize_js_1 = require("./utils/sanitize.js");
Object.defineProperty(exports, "sanitizeErrorMessage", { enumerable: true, get: function () { return sanitize_js_1.sanitizeErrorMessage; } });
Object.defineProperty(exports, "sanitizeError", { enumerable: true, get: function () { return sanitize_js_1.sanitizeError; } });
// ─── Hardening: AbortController pool ─────────────────────────────────────────
var abortPool_js_1 = require("./utils/abortPool.js");
Object.defineProperty(exports, "acquireController", { enumerable: true, get: function () { return abortPool_js_1.acquireController; } });
Object.defineProperty(exports, "releaseController", { enumerable: true, get: function () { return abortPool_js_1.releaseController; } });
Object.defineProperty(exports, "poolSize", { enumerable: true, get: function () { return abortPool_js_1.poolSize; } });
