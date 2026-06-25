"use strict";
// ─── Primary API ──────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalTimeoutError = exports.TimeoutError = exports.isAsyncStore = exports.isSyncStore = exports.InMemoryStore = exports.REQUIRES_SYNC_STORE = exports.execute = exports.withStore = exports.invalidate = exports.act = void 0;
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
var timeout_js_1 = require("./policies/timeout.js");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return timeout_js_1.TimeoutError; } });
Object.defineProperty(exports, "TotalTimeoutError", { enumerable: true, get: function () { return timeout_js_1.TotalTimeoutError; } });
