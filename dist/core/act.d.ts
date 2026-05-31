import type { ActFn, ActOptions, ActResult } from '../types/index.js';
/**
 * Execute fn with the given reliability policies.
 *
 * @param key     Stable identifier for this action. Scopes dedupe + cache.
 * @param fn      The async work to run.
 * @param options Which policies to apply and how. All fields are optional.
 *
 * @returns       ActResult<T> — always resolves, never throws.
 *                Check result.ok before reading result.value.
 *
 * @example
 * const result = await act('user:42', () => fetchUser(42), {
 *   retry:   { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout: { ms: 5_000 },
 *   dedupe:  true,
 *   cache:   { ttl: 60_000 },
 * })
 *
 * if (result.ok) {
 *   console.log(result.value, result.source, result.attempts)
 * } else {
 *   console.error(result.error)
 * }
 */
export declare function act<T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>;
//# sourceMappingURL=act.d.ts.map