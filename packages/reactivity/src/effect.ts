import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (...args: any[]): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  computed?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) { // fn已经生成过effect，就取原始fn
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  // 普通effect首次执行effect()，直接进行依赖收集
  // computed首次不执行effect()
  if (!options.lazy) {
    effect()
  }
  return effect
}

// 移除effect的响应式
export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    // 这个effect对应的所有dep不再订阅这个effect
    // 然后清空effect的deps
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

// 创建effect并返回
function createReactiveEffect<T = any>(
  fn: (...args: any[]) => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(...args: unknown[]): unknown {
    if (!effect.active) { // 失活effect
      return options.scheduler ? undefined : fn(...args)
    }
    // effectStack是用于存放activeEffect的栈结构
    // effectStack中没有effect才添加，如果有，就跳过，这里做了去重处理
    if (!effectStack.includes(effect)) {
      cleanup(effect) // 清除effect对应的双向存储
      try {
        enableTracking() // 将shouldTrack设为true，准备进行依赖收集
        effectStack.push(effect)
        activeEffect = effect // 当前的活跃effect
        return fn(...args)
      } finally {
        effectStack.pop()
        resetTracking() // 依赖收集结束，将shouldTrack重新设为先前的值
        activeEffect = effectStack[effectStack.length - 1] // 取出栈顶effect作为activeEffect
      }
    }
  } as ReactiveEffect
  effect.id = uid++ // effect自增id
  effect._isEffect = true // effect标识
  effect.active = true // active标志
  effect.raw = fn // 原始回调函数
  effect.deps = [] // 双向存储effect依赖的数据
  effect.options = options // 用户传入的options
  return effect
}

// 清除effect对应的双向存储
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 依赖收集，activeEffect依赖于这个target的key属性
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 不需要track或者不是活跃的，直接返回
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  // targetMap是所有target-depsMap的WeakMap
  // depsMap是某一target上所有key-dep的Map
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key) // key对应一个dep集合
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) { // 还没有收集依赖
    // 双向存储
    dep.add(activeEffect)
    activeEffect.deps.push(dep)
    // onTrack只会在dev环境下执行
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

// 通知观察者 effects 和 computedRunners 更新
// effects和computedRunners都是effect
export function trigger(
  target: object,
  type: TriggerOpTypes, // trigger的类型 set add delete clear
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // targetMap是所有target-depsMap的WeakMap
  // depsMap是某一target上所有key-dep的Map
  const depsMap = targetMap.get(target)
  // 没有观察者，不需要更新，直接返回
  if (!depsMap) {
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>() // 普通effects集合，用set可以去重
  const computedRunners = new Set<ReactiveEffect>() // computed集合，用set可以去重
  // 将effectsToAdd中的effect添加到effects和computedRunners中，用于后续触发更新
  // 这里会去除掉 effect为activeEffect 且 shouldTrack为true 的情况，因为会造成无限循环的更新
  // 这种情况只有可能发生在 修改了自身属性 且 支持track
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        // effect不为activeEffect或shouldTrack为false，就会添加

        // 只有effect为activeEffect且shouldTrack为true，才不会添加
        // 也就是修改了自身属性，如果添加了，就会进入无限循环的更新

        // effect为activeEffect且shouldTrack为false，也会添加
        // 不支持track的情况下，这里对自身属性进行修改，可以添加，因为没有响应式，不会进入无限循环的更新
        // 这里有一个问题，既然不支持track，这里的effect怎么可能出现activeEffect???
        if (effect !== activeEffect || !shouldTrack) {
          if (effect.options.computed) {
            computedRunners.add(effect)
          } else {
            effects.add(effect)
          }
        } else {
          // the effect mutated its own dependency during its execution.
          // this can be caused by operations like foo.value++
          // do not trigger or we end in an infinite loop
          // effect为activeEffect且shouldTrack为true
          // 这个时候如果出现类似foo.value++，就不能继续trigger了，否则会无限循环
          // 所以这里不做处理
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) { // clear 通知depsMap中的所有effect更新
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) { // 修改数组的length
    depsMap.forEach((dep, key) => {
      // 1. 依赖数组的length
      // 2. 依赖大于等于newValue(新长度)的索引，这里是因为设置了小的length之后，相当于对后面的值做了删除，需要对后面的值的依赖进行更新
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // set add delete 都在这里处理

    // void 0 就是undefined，相对于 undefined 节省3个字节，这里是这个原因???
    // void xxx 总是返回undefined
    // 只要key不是undefined，这里已经把key对应的依赖effect添加到effects和computedRunners中了
    if (key !== void 0) {
      add(depsMap.get(key))
    }
    // also run for iteration key on ADD | DELETE | Map.SET
    // 还需要处理一些额外的情况，也就是key还会带来其他变化的依赖也需要更新
    // 比如，添加新属性或者删除属性，会影响到遍历某一个target的结果，这里会对遍历target的依赖进行更新，这是Vue2.x不支持的
    // 添加属性  Vue2.x只能Vue.set(obj, key, value)触发响应式，而Vue3.x这里会做处理触发更新
    const isAddOrDelete =
      type === TriggerOpTypes.ADD || // add  也就是新添加的属性，新添加的属性没有依赖effect，只会触发依赖iterate效果的effect更新，如 obj.xxx = 'xxx'添加新key-value
      (type === TriggerOpTypes.DELETE && !isArray(target)) // delete 且 非array  删除属性也会触发依赖iterate效果的effect更新
    if (
      isAddOrDelete ||
      (type === TriggerOpTypes.SET && target instanceof Map) // map.set
    ) {
      // Symbol(__DEV__ ? 'iterate' : '')
      // 使用ownKeys相关遍历方法的时候会进行ITERATE_KEY的依赖收集
      // Object.getOwnPropertyNames(proxy) Object.getOwnPropertySymbols(proxy) Object.keys(proxy) for in等
      add(depsMap.get(isArray(target) ? 'length' : ITERATE_KEY))
    }
    if (isAddOrDelete && target instanceof Map) { // map.add  map.delete
      // Symbol(__DEV__ ? 'Map key iterate' : '') 这是什么意思???
      add(depsMap.get(MAP_KEY_ITERATE_KEY))
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) { // dev环境下可以传入onTrigger进行调试
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    // 只有render effect和computed effect(watch effect也是用computed effect实现的)有scheduler方法
    // computed effect  执行scheduler会通知依赖computed的effect(这个effect也会走到这里，并放入queue队列，走异步更新)更新，在更新过程中重新取computed的value才会触发computed的重新计算并缓存
    // render effect  scheduler也就是queueJob，也就是在queue队列中添加effect，然后queueFlush(内部是通过nextTick进行异步渲染)
    // 这里一定是把所有的render effect都放入queue(带去重，避免重复更新)之后，才会异步更新
    // 由于computed effect的scheduler只是通知它自己的依赖effect进行异步更新，所以computed effect的scheduler本身是同步执行的，没有问题
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  // Vue3.0.0  这里computed必须先执行，这样在后面依赖这个computed的effect中就可以获取到正确的值了，否则还会用前一个缓存的值
  // 其实上面说的情况不存在，这里无所谓先后，在Vue3.0.3中也将两者合并在一起了
  // 因为最后的结果总是将所有render effect放入queue队列进行异步更新，而推入异步队列queue之前，computed effect的dirty已经重置为true了
  // 所以即使异步更新时render effect 或 watch effect(异步watch)先更新，此时去取computed的value，也会重新计算
  computedRunners.forEach(run)
  effects.forEach(run)
}
