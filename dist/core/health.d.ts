import type { InMemoryStore } from '../stores/memory.js';
import type { AnyStateStore } from '../types/index.js';
import type { ObservabilityHooks } from '../observability.js';
export declare function registerStoreScope(store: AnyStateStore, scope: string): void;
export declare function resolveStoreScope(store: AnyStateStore): string | undefined;
export interface HealthStatus {
    storeSize: number;
    pendingInflight: number;
    uptimeMs: number;
    lastError?: {
        code: string;
        message: string;
        timestamp: number;
    };
    lastSuccessAt?: number;
}
export declare function registerInflight(scope: string): void;
export declare function unregisterInflight(scope: string): void;
export declare function enableWatchdog(thresholdMs?: number, hooks?: ObservabilityHooks): void;
export declare function registerWatchdogHooks(hooks: ObservabilityHooks): void;
export declare function unregisterWatchdogHooks(hooks: ObservabilityHooks): void;
export declare function disableWatchdog(): void;
export declare function recordError(scope: string, code: string, message: string): void;
export declare function recordSuccess(scope: string): void;
export interface HealthCheckFn {
    (): HealthStatus;
    dispose(): void;
}
export declare function createHealthCheck(store: InMemoryStore, options?: {
    scope?: string;
    probeIntervalMs?: number;
}): HealthCheckFn;
//# sourceMappingURL=health.d.ts.map