import type { ObservabilityHooks, ActlyEventType } from '../observability.js';
export declare function waitForObsHook<K extends keyof ObservabilityHooks>(hooks: ObservabilityHooks, hookName: K, timeoutMs?: number): Promise<Parameters<NonNullable<ObservabilityHooks[K]>>[0]> & {
    cancel: () => void;
};
export declare function isActlyEventType(value: unknown): value is ActlyEventType;
//# sourceMappingURL=index.d.ts.map