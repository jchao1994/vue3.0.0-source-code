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

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: (...args: any[]) => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(...args: unknown[]): unknown {
    if (!effect.active) { // 失活effect
      return options.scheduler ? undefined : fn(...args)
    }
    // 新的effect
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

export function track(target: object, type: TrackOpTypes, key: unknown) { // 依赖收集
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

export function trigger( // 通知更新
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) { // 没有观察者，直接返回
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>() // 普通effects集合
  const computedRunners = new Set<ReactiveEffect>() // computed集合
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        // 排除activeEffect和不需要track的effect
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
      if (key === 'length' || key >= (newValue as number)) { // 通知length和索引大于等于newValue对应的effect更新
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      add(depsMap.get(key))
    }
    // also run for iteration key on ADD | DELETE | Map.SET
    const isAddOrDelete =
      type === TriggerOpTypes.ADD || // 执行add
      (type === TriggerOpTypes.DELETE && !isArray(target)) // 非数组执行delete
    if (
      isAddOrDelete ||
      (type === TriggerOpTypes.SET && target instanceof Map) // map执行set
    ) {
      add(depsMap.get(isArray(target) ? 'length' : ITERATE_KEY)) // iterate？？？
    }
    if (isAddOrDelete && target instanceof Map) {
      add(depsMap.get(MAP_KEY_ITERATE_KEY)) // Map key iterate？？？
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
    // 如果effect自己配置了scheduler，则使用调度器运行effect
    // computed effect中有设置scheduler方法，执行scheduler会通知computed effect更新缓存值并通知对应的依赖进行更新
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  computedRunners.forEach(run)
  effects.forEach(run)
}
