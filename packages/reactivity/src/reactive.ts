import { isObject, toRawType, def, hasOwn, makeMap } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers
} from './collectionHandlers'
import { UnwrapRef, Ref } from './ref'

export const enum ReactiveFlags {
  skip = '__v_skip',
  isReactive = '__v_isReactive',
  isReadonly = '__v_isReadonly',
  raw = '__v_raw',
  reactive = '__v_reactive',
  readonly = '__v_readonly'
}

interface Target {
  __v_skip?: boolean
  __v_isReactive?: boolean
  __v_isReadonly?: boolean
  __v_raw?: any
  __v_reactive?: any
  __v_readonly?: any
}

const collectionTypes = new Set<Function>([Set, Map, WeakMap, WeakSet])
const isObservableType = /*#__PURE__*/ makeMap(
  'Object,Array,Map,Set,WeakMap,WeakSet'
)

// 判断value是否需要观察
const canObserve = (value: Target): boolean => {
  return (
    !value[ReactiveFlags.skip] && // 非__v_skip
    isObservableType(toRawType(value)) && // 类型为Object,Array,Map,Set,WeakMap,WeakSet中的一种
    !Object.isFrozen(value) // 没有被冻结
  )
}

// only unwrap nested ref
type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRef<T>

export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  // 如果target已经被readonly，直接返回
  if (target && (target as Target)[ReactiveFlags.isReadonly]) {
    return target
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers, // baseHandlers
    mutableCollectionHandlers // collectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are reactive, and does NOT unwrap refs nor recursively convert
// returned properties.
export function shallowReactive<T extends object>(target: T): T {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers
  )
}

export function readonly<T extends object>(
  target: T
): Readonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers, // baseHandlers
    readonlyCollectionHandlers // collectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are readonly, and does NOT unwrap refs nor recursively convert
// returned properties.
// This is used for creating the props proxy object for stateful components.
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    readonlyCollectionHandlers
  )
}

function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  // target不是引用类型，发出警告
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  // target已经readonly且没有reactive，直接返回
  // __v_raw？？？
  if (
    target[ReactiveFlags.raw] &&
    !(isReadonly && target[ReactiveFlags.isReactive])
  ) {
    return target
  }
  // target already has corresponding Proxy
  // target已经有了对应的Proxy(readonly或者reactive)，直接返回相应的Proxy
  if (
    hasOwn(target, isReadonly ? ReactiveFlags.readonly : ReactiveFlags.reactive)
  ) {
    return isReadonly
      ? target[ReactiveFlags.readonly]
      : target[ReactiveFlags.reactive]
  }
  // only a whitelist of value types can be observed.
  // 不具备观察的条件，直接返回
  if (!canObserve(target)) {
    return target
  }
  // Set, Map, WeakMap, WeakSet中的一种执行collectionHandlers  只代理get方法？？？
  // 其他执行baseHandlers  get set deleteProperty has ownKeys
  const observed = new Proxy(
    target,
    collectionTypes.has(target.constructor) ? collectionHandlers : baseHandlers
  )
  // 将Proxy对象定义为target.__v_readonly或者target.__v_reactive
  def(
    target,
    isReadonly ? ReactiveFlags.readonly : ReactiveFlags.reactive,
    observed
  )
  return observed
}

// 判断是否reactive
export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) { // 如果readonly，就取原始对象再进行判断
    return isReactive((value as Target)[ReactiveFlags.raw])
  }
  // 直接取原始对象进行判断
  return !!(value && (value as Target)[ReactiveFlags.isReactive])
}

// 判断是否readonly
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.isReadonly])
}

// 判断是否reactive或者readonly
export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

// 获取原始对象__v_raw
export function toRaw<T>(observed: T): T {
  return (
    (observed && toRaw((observed as Target)[ReactiveFlags.raw])) || observed
  )
}

export function markRaw<T extends object>(value: T): T {
  def(value, ReactiveFlags.skip, true)
  return value
}
