"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TotalTimeoutError = exports.TimeoutError = exports.InMemoryStore = exports.act = void 0;
var act_js_1 = require("./core/act.js");
Object.defineProperty(exports, "act", { enumerable: true, get: function () { return act_js_1.act; } });
// Exported so consumers can build isolated stores (e.g. per-request in SSR)
var store_js_1 = require("./state/store.js");
Object.defineProperty(exports, "InMemoryStore", { enumerable: true, get: function () { return store_js_1.InMemoryStore; } });
// Exported so callers can instanceof-check against timeout failures
var timeout_js_1 = require("./policies/timeout.js");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return timeout_js_1.TimeoutError; } });
Object.defineProperty(exports, "TotalTimeoutError", { enumerable: true, get: function () { return timeout_js_1.TotalTimeoutError; } });
