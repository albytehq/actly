"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
/**
 * @deprecated since v1.1.5 — import from `'actly'` directly.
 *
 * This re-export shim exists for backwards compatibility with code that
 * imported `InMemoryStore` from `'actly/state/store'`. It will be removed
 * in v2.0.0.
 *
 * The implementation has moved to `src/stores/memory.ts`.
 */
var memory_js_1 = require("../stores/memory.js");
Object.defineProperty(exports, "InMemoryStore", { enumerable: true, get: function () { return memory_js_1.InMemoryStore; } });
