export declare function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal;
export declare function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
export declare function sleep(ms: number, signal?: AbortSignal, opts?: {
    unref?: boolean;
}): Promise<void>;
export declare function isAbortError(err: unknown): boolean;
export declare function linkSignal(parent: AbortSignal, child: AbortController): () => void;
//# sourceMappingURL=abort.d.ts.map