let globalInflight = 0;
let startTime = Date.now();
let globalLastError;
let globalLastSuccessAt;
export function registerInflight(_scope) {
    globalInflight++;
}
export function unregisterInflight(_scope) {
    globalInflight = Math.max(0, globalInflight - 1);
}
export function recordError(_scope, code, message) {
    globalLastError = { code, message, timestamp: Date.now() };
}
export function recordSuccess(_scope) {
    globalLastSuccessAt = Date.now();
}
export function createHealthCheck(store) {
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
//# sourceMappingURL=health.js.map