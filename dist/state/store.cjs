"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
/**
 * @deprecated import from `'actly'` directly.
 *
 * This re-export shim exists for backwards compatibility with code that
 * imported `InMemoryStore` from `'actly/state/store'`. It will be removed
 * in a future major release.
 *
 * The implementation lives in `src/stores/memory.ts`.
 */
var memory_js_1 = require("../stores/memory.js");
Object.defineProperty(exports, "InMemoryStore", { enumerable: true, get: function () { return memory_js_1.InMemoryStore; } });
