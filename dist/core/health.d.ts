import type { InMemoryStore } from '../stores/memory.js';
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
export declare function registerInflight(_scope: string): void;
export declare function unregisterInflight(_scope: string): void;
export declare function recordError(_scope: string, code: string, message: string): void;
export declare function recordSuccess(_scope: string): void;
export declare function createHealthCheck(store: InMemoryStore): () => HealthStatus;
//# sourceMappingURL=health.d.ts.map