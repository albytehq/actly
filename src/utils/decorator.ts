import type { ActOptions, ActResult } from '../types/index.js'
import type { act as actType } from '../core/act.js'

/**
 * Method decorator that wraps a class method with `act()`. Retry, timeout,
 * dedupe, etc. are applied per the provided options. The method's `this`
 * context is preserved.
 *
 * Requires TC39 stage-3 decorators (or experimentalDecorators on TS 5+).
 * The wrapped method should be `async` and accept an `AbortSignal` as its
 * first parameter; the decorator passes one through.
 *
 * @example
 * ```ts
 * class UserService {
 *   @usePolicy({ retry: { attempts: 3, delayMs: 100 }, timeout: { ms: 5000 } })
 *   async fetchUser(signal: AbortSignal, id: string): Promise<User> {
 *     const res = await fetch(`/api/users/${id}`, { signal })
 *     if (!res.ok) throw new Error(`HTTP ${res.status}`)
 *     return res.json()
 *   }
 * }
 * ```
 *
 * @param options actly options applied to every call.
 */
export function usePolicy(options: ActOptions): MethodDecorator {
  // `any` is required internally because the decorator wraps arbitrary
  // async methods; type safety is enforced at the call site.
  return function (
    _target: object,
    propertyKey: string | symbol,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    descriptor: TypedPropertyDescriptor<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): TypedPropertyDescriptor<any> | void {
    if (!descriptor || !descriptor.value) {
      throw new Error(
        `Actly: @usePolicy can only be applied to methods with a function value. ` +
        `Got descriptor without value for property "${String(propertyKey)}".`,
      )
    }

    const originalMethod = descriptor.value

    // Resolve act() once and cache. The lazy import still breaks the
    // circular dep at module eval time; we just avoid re-importing on
    // every call.
    type ActFn = typeof actType
    let actPromise: Promise<ActFn> | undefined
    const getAct = (): Promise<ActFn> => {
      if (!actPromise) actPromise = import('../core/act.js').then(m => m.act)
      return actPromise
    }

    const wrappedMethod = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const act = await getAct()
      // Use the instance's constructor name (not `target`) so the key
      // reflects the actual class at call time, not the prototype.
      const ctorName = (this as { constructor?: { name?: string } })?.constructor?.name ?? 'Anonymous'
      const key = `${ctorName}.${String(propertyKey)}`
      // The first arg MAY be an AbortSignal by convention. Duck-type it
      // - instanceof breaks across realms (workers, vm contexts).
      const firstArg = args[0]
      const isSignal = firstArg != null &&
        typeof firstArg === 'object' &&
        typeof (firstArg as { aborted?: unknown }).aborted === 'boolean' &&
        typeof (firstArg as { addEventListener?: unknown }).addEventListener === 'function'
      const signal = isSignal ? (firstArg as AbortSignal) : undefined
      const fnArgs = signal ? args.slice(1) : args

      const result: ActResult<unknown> = await act(
        key,
        async (actSignal: AbortSignal) => originalMethod.apply(this, [actSignal, ...fnArgs]),
        signal ? { ...options, signal } : options,
      )

      if (result.ok) return result.value
      throw result.error
    }

    // Preserve the original method name so stack traces stay readable.
    try {
      Object.defineProperty(wrappedMethod, 'name', {
        value: typeof propertyKey === 'symbol' ? propertyKey.description ?? 'wrapped' : propertyKey,
        configurable: true,
      })
    } catch {
      // Older engines may reject; fail without the name.
    }

    descriptor.value = wrappedMethod
    return descriptor
  }
}
