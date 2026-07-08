import type { PolicyApplier, TimeoutOptions } from '../types/index.js';
import { TimeoutError, TotalTimeoutError } from '../errors.js';
export { TimeoutError, TotalTimeoutError };
export declare function timeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
export declare function totalTimeoutPolicy<T>(opts: TimeoutOptions): PolicyApplier<T>;
//# sourceMappingURL=timeout.d.ts.map