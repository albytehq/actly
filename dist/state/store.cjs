"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
// Re-export shim — implementation moved to src/stores/memory.ts in v1.1.
// Kept for one version to preserve git blame and ease internal refactors.
var memory_js_1 = require("../stores/memory.js");
Object.defineProperty(exports, "InMemoryStore", { enumerable: true, get: function () { return memory_js_1.InMemoryStore; } });
