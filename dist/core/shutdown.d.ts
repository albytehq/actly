export declare function registerDrainable(scope?: string): void;
export declare function unregisterDrainable(scope?: string): void;
/**
 * Wait for all in-flight act() calls in this scope to settle.
 * Returns true if all settled within timeoutMs, false if timed out.
 */
export declare function drain(timeoutMs: number, scope?: string): Promise<boolean>;
//# sourceMappingURL=shutdown.d.ts.map