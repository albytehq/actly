"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerInflight = registerInflight;
exports.unregisterInflight = unregisterInflight;
exports.recordError = recordError;
exports.recordSuccess = recordSuccess;
exports.createHealthCheck = createHealthCheck;
let globalInflight = 0;
let startTime = Date.now();
let globalLastError;
let globalLastSuccessAt;
function registerInflight(_scope) {
    globalInflight++;
}
function unregisterInflight(_scope) {
    globalInflight = Math.max(0, globalInflight - 1);
}
function recordError(_scope, code, message) {
    globalLastError = { code, message, timestamp: Date.now() };
}
function recordSuccess(_scope) {
    globalLastSuccessAt = Date.now();
}
function createHealthCheck(store) {
    return () => {
        return {
            storeSize: store.size(),
            pendingInflight: globalInflight,
            uptimeMs: Date.now() - startTime,
            lastError: globalLastError,
            lastSuccessAt: globalLastSuccessAt,
        };
    };
}
