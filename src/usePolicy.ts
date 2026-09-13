import type { ActOptions, ActResult } from './types.js'
import { act } from './core/act.js'

// Stable per-constructor ids: constructor.name collides for anonymous
// classes and is unreliable in minified builds (two distinct classes can
// minify to the same short name). The id is process-stable, which is all
// dedupe/cache keys need — stores are process-local by default.
const classIds = new WeakMap<object, number>()
let nextClassId = 0

function classTag(ctor: unknown): string {
  const name = (ctor as { name?: unknown } | undefined)?.name
  const readable = typeof name === 'string' && name.length > 0 && name !== 'Anonymous' && name !== 'Object'
    ? name
    : 'class'
  if (ctor == null || (typeof ctor !== 'object' && typeof ctor !== 'function')) {
    return readable
  }
  let id = classIds.get(ctor as object)
  if (id === undefined) {
    id = ++nextClassId
    classIds.set(ctor as object, id)
  }
  return `${readable}#${id}`
}

/**
 * Method decorator that wraps a class method with `act()`; the method's
 * `this` is preserved. Requires TC39 stage-3 decorators or
 * `experimentalDecorators`. The wrapped method should be `async` and
 * accept an `AbortSignal` as its first parameter.
 *
 * The dedupe/cache key is `<Class>#<id>.<method>`: readable in stack
 * traces and collision-free across classes that share a name after
 * minification (since 1.4 — previously two minified classes could share
 * a key and dedupe into each other).
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

    const wrappedMethod = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      // the instance's constructor (not `target`) so subclass calls key
      // under the actual class
      const ctor = (this as { constructor?: unknown })?.constructor
      const key = `${classTag(ctor)}.${String(propertyKey)}`
      // the first arg MAY be an AbortSignal by convention; duck-type it —
      // instanceof breaks across realms
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

    // preserve the original method name for readable stack traces
    try {
      Object.defineProperty(wrappedMethod, 'name', {
        value: typeof propertyKey === 'symbol' ? propertyKey.description ?? 'wrapped' : propertyKey,
        configurable: true,
      })
    } catch {
      // older engines
    }

    descriptor.value = wrappedMethod
    return descriptor
  }
}
