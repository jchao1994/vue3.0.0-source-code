import { reactive, readonly, toRaw, ReactiveFlags } from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { track, trigger, ITERATE_KEY } from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  extend
} from '@vue/shared'
import { isRef } from './ref'

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

// 重写数组方法includes indexOf lastIndexOf 对数组中的每一项进行依赖收集
// 数组内的项发生改变，可能会引起includes indexOf lastIndexOf的结果的变化
// 所以这里对用到includes indexOf lastIndexOf的数组中的每一项都进行了依赖收集
const arrayInstrumentations: Record<string, Function> = {}
;['includes', 'indexOf', 'lastIndexOf'].forEach(key => {
  arrayInstrumentations[key] = function(...args: any[]): any {
    // 数组的原始值
    const arr = toRaw(this) as any
    // 对数组中的每一项进行依赖收集
    for (let i = 0, l = (this as any).length; i < l; i++) {
      track(arr, TrackOpTypes.GET, i + '')
    }
    // we run the method using the original args first (which may be reactive)
    // 执行数组的原始方法
    const res = arr[key](...args)
    if (res === -1 || res === false) {
      // if that didn't work, run it again using raw values.
      // 没有找到，将args进行toRaw处理再执行一遍原始方法
      return arr[key](...args.map(toRaw))
    } else {
      return res
    }
  }
})

// 响应式的get方法，进行依赖收集
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: object, key: string | symbol, receiver: object) {
    // 处理特殊的key  __v_isReactive __v_isReadonly __v_raw
    if (key === ReactiveFlags.isReactive) { // key === '__v_isReactive'
      return !isReadonly
    } else if (key === ReactiveFlags.isReadonly) { // key === '__v_isReadonly'
      return isReadonly
    } else if (
      key === ReactiveFlags.raw && // key === '__v_raw'
      receiver ===
        (isReadonly
          ? (target as any).__v_readonly
          : (target as any).__v_reactive)
    ) {
      return target
    }

    const targetIsArray = isArray(target)
    // 重写数组的includes indexOf lastIndexOf，对数组中每一项进行依赖收集
    if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 取值target[key]
    const res = Reflect.get(target, key, receiver)

    if ((isSymbol(key) && builtInSymbols.has(key)) || key === '__proto__') {
      return res
    }

    // 非readonly，就进行track收集依赖
    // object的属性在这里正常依赖收集
    // array的内容和length在这里正常依赖收集(index作为key)
    // object和array的方法呢???
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅层响应式，直接返回res，这里已经完成了浅层每个key的代理，后续的深层嵌套代理直接跳过
    if (shallow) {
      return res
    }

    // reactive对象内部的ref解套
    // reactive数组内部的ref不解套
    // 这里会取ref.value，也就是会进行依赖收集，当ref.value变化了，当前这个effect会更新
    // 而在ref内部已经对其进行深层reactive了，所以这里直接返回，不用重复reactive
    // 这里也就是为什么，模板中直接取ref而不用取ref.value的原因
    // setupState最后会被reactive处理，也就是取setupState.ref会自动解套取到setupState.ref.value并添加依赖
    // 但是setup内部取ref时，由于没有reactive，还是需要操作ref.value的
    if (isRef(res)) {
      // ref unwrapping, only for Objects, not for Arrays.
      return targetIsArray ? res : res.value
    }

    // 递归进行readonly或者reactive，深层嵌套响应式代理
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

// 响应式的set方法
// 如果是自由属性，触发依赖 这个key的 effect更新
// 如果是新添加的属性或是原型链上的，触发依赖 遍历target 的effect更新，这个Vue2.x不具备的，Vue2.x只能通过Vue.set(obj,key,value)触发更新
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    // 老value
    const oldValue = (target as any)[key]
    if (!shallow) { // 深度响应式
      value = toRaw(value) // 取原始对象
      // 老值是ref，新值不值ref，说明是直接修改的老ref.value
      // 这里oldValue.value = value会触发ref内部的响应式更新，也就是通知effect更新
      // 所以这里可以直接return true，不需要下面的trigger
      // 如果target是数组，且oldValue是ref，这种情况下会将整个ref做替换，触发更新，而不会更新ref.value
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else { // 浅层响应式，只需要触发依赖target当前这个key的effect更新，而不用管深层的响应式
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey = hasOwn(target, key) // key是否是target的自有属性(key是新添加的属性，或者是原型链上的)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) { // key是原型链上的方法或是新添加的，会触发依赖key为Symbol(__DEV__ ? 'iterate' : '')的effect更新
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) { // key是自有属性
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 响应式的delete，会触发对应依赖的更新，包括依赖 这个key 或是 遍历target
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) { // 删除自有属性成功，执行trigger触发更新
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 响应式的has，会对这个key进行依赖收集
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  // has会进行依赖收集，因为当前effect依赖has的结果，所有has的这个key对应的value发生改变时，会触发更新
  track(target, TrackOpTypes.HAS, key)
  return result
}

// 拦截Object.getOwnPropertyNames(proxy) Object.getOwnPropertySymbols(proxy) Object.keys(proxy) for in等
// 对依赖遍历效果的effect进行收集，key为ITERATE_KEY，也就是Symbol(__DEV__ ? 'iterate' : '')
function ownKeys(target: object): (string | number | symbol)[] {
  track(target, TrackOpTypes.ITERATE, ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  // 响应式的get方法，进行依赖收集
  get,
  // 响应式的set方法
  // 如果是自由属性，触发依赖 这个key的 effect更新
  // 如果是新添加的属性或是原型链上的，触发依赖 遍历target 的effect更新，这个Vue2.x不具备的，Vue2.x只能通过Vue.set(obj,key,value)触发更新
  set,
  // 响应式的delete，会触发对应依赖的更新，包括依赖 这个key 或是 遍历target
  deleteProperty,
  // 响应式的has，会对这个key进行依赖收集
  has,
  // 拦截Object.getOwnPropertyNames(proxy) Object.getOwnPropertySymbols(proxy) Object.keys(proxy) for in等
  // 对依赖遍历效果的effect进行收集，key为ITERATE_KEY，也就是Symbol(__DEV__ ? 'iterate' : '')
  ownKeys
}

// readonly的get不进行依赖收集，因为set和delete都不会trigger触发更新，自然不需要依赖收集
// 为啥has和ownKeys还是会进行依赖收集呢???
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet, // createGetter(true)  isReadonly标志为true，不会进行依赖收集
  has,
  ownKeys,
  set(target, key) { // readonly没有set方法
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) { // readonly没有delete方法
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers: ProxyHandler<object> = extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
