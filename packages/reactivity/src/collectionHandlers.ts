import { toRaw, reactive, readonly, ReactiveFlags } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  isObject,
  capitalize,
  hasOwn,
  hasChanged,
  toRawType
} from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value) : value

const toShallow = <T extends unknown>(value: T): T => value

const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

function get(
  target: MapTypes,
  key: unknown,
  wrap: typeof toReactive | typeof toReadonly | typeof toShallow
) {
  target = toRaw(target)
  const rawKey = toRaw(key)
  // 对key和rawKey都进行track依赖收集
  if (key !== rawKey) {
    track(target, TrackOpTypes.GET, key)
  }
  track(target, TrackOpTypes.GET, rawKey)
  const { has, get } = getProto(target) // 获取target原型上的has和get方法
  // 取值并进行reactive readonly shallow
  if (has.call(target, key)) {
    return wrap(get.call(target, key))
  } else if (has.call(target, rawKey)) {
    return wrap(get.call(target, rawKey))
  }
}

function has(this: CollectionTypes, key: unknown): boolean {
  const target = toRaw(this)
  const rawKey = toRaw(key)
  if (key !== rawKey) {
    track(target, TrackOpTypes.HAS, key)
  }
  track(target, TrackOpTypes.HAS, rawKey)
  const has = getProto(target).has
  return has.call(target, key) || has.call(target, rawKey)
}

// 获取target的大小size
function size(target: IterableCollections) { // Map Set
  target = toRaw(target)
  track(target, TrackOpTypes.ITERATE, ITERATE_KEY)
  return Reflect.get(getProto(target), 'size', target)
}

function add(this: SetTypes, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const proto = getProto(target)
  const hadKey = proto.has.call(target, value)
  const result = proto.add.call(target, value)
  // set中没有才会添加
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return result
}

function set(this: MapTypes, key: unknown, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const { has, get, set } = getProto(target)

  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get.call(target, key)
  const result = set.call(target, key, value)
  if (!hadKey) { // 没有，触发add trigger
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) { // 有，触发set trigger
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return result
}

function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get, delete: del } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = del.call(target, key)
  if (hadKey) { // 删除成功，触发delete trigger
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? target instanceof Map
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = getProto(target).clear.call(target)
  if (hadItems) { // target有内容(size不为0)，说明clear成功，执行clear trigger
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

function createForEach(isReadonly: boolean, shallow: boolean) {
  return function forEach(
    this: IterableCollections, // Map Set
    callback: Function,
    thisArg?: unknown
  ) {
    const observed = this
    const target = toRaw(observed)
    const wrap = isReadonly ? toReadonly : shallow ? toShallow : toReactive
    // 非readonly就执行track依赖收集
    !isReadonly && track(target, TrackOpTypes.ITERATE, ITERATE_KEY)
    // important: create sure the callback is
    // 1. invoked with the reactive map as `this` and 3rd arg
    // 2. the value received should be a corresponding reactive/readonly.
    function wrappedCallback(value: unknown, key: unknown) {
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    }
    return getProto(target).forEach.call(target, wrappedCallback)
  }
}

function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  shallow: boolean
) {
  return function(this: IterableCollections, ...args: unknown[]) {
    const target = toRaw(this)
    const isMap = target instanceof Map
    const isPair = method === 'entries' || (method === Symbol.iterator && isMap)
    const isKeyOnly = method === 'keys' && isMap
    const innerIterator = getProto(target)[method].apply(target, args)
    const wrap = isReadonly ? toReadonly : shallow ? toShallow : toReactive
    !isReadonly &&
      track(
        target,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function { // add set delete clear
  return function(this: CollectionTypes, ...args: unknown[]) { // Map WeakMap Set WeakSet
    if (__DEV__) { // dev模式下readonly发出警告
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this // delete返回false，其他返回this
  }
}

const mutableInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) { // Map WeakMap
    return get(this, key, toReactive)
  },
  get size() { // Map Set
    return size((this as unknown) as IterableCollections)
  },
  has, // Map WeakMap Set WeakSet
  add, // Set WeakSet
  set, // Map WeakMap
  delete: deleteEntry, // Map WeakMap Set WeakSet
  clear, // Map Set
  forEach: createForEach(false, false) // Map Set
}

// shallow与reactive类似，toShallow对应toReactive
const shallowInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, toShallow)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, true)
}

const readonlyInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, toReadonly)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add: createReadonlyMethod(TriggerOpTypes.ADD),
  set: createReadonlyMethod(TriggerOpTypes.SET),
  delete: createReadonlyMethod(TriggerOpTypes.DELETE),
  clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
  forEach: createForEach(true, false)
}

const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
iteratorMethods.forEach(method => {
  mutableInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    false
  )
  readonlyInstrumentations[method as string] = createIterableMethod(
    method,
    true,
    false
  )
  shallowInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    true
  )
})

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 重写get has add set delete clear forEach方法
  const instrumentations = shallow
    ? shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations

  return ( // get方法
    target: CollectionTypes, // Map WeakMap Set WeakSet
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    if (key === ReactiveFlags.isReactive) { // __v_isReactive
      return !isReadonly
    } else if (key === ReactiveFlags.isReadonly) { // __v_isReadonly
      return isReadonly
    } else if (key === ReactiveFlags.raw) { // __v_raw
      return target
    }

    return Reflect.get(
      hasOwn(instrumentations, key) && key in target // get has add set delete clear forEach
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, false)
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, true)
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(true, false)
}

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? `as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
