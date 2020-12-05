import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions,
  isReactive
} from '@vue/reactivity'
import { queueJob } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  recordInstanceBoundEffect
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { onBeforeUnmount } from './apiLifecycle'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? V
    : T[K] extends object ? T[K] : never
}

type MapOldSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true ? (V | undefined) : V
    : T[K] extends object
      ? Immediate extends true ? (T[K] | undefined) : T[K]
      : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase {
  flush?: 'pre' | 'post' | 'sync'
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

const invoke = (fn: Function) => fn()

// Simple effect.
// watchEffect API，首次和副作用cb中的依赖项改变之后会执行(执行时间在组件更新完之后，postFlushCbs队列)
// 有点类似React useEffect
export function watchEffect(
  effect: WatchEffect, // 副作用cb
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

// overload #1: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<
  T extends Readonly<Array<WatchSource<unknown> | object>>,
  Immediate extends Readonly<boolean> = false
>(
  sources: T,
  cb: WatchCallback<MapSources<T>, MapOldSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #2: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #3: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
// watch API，数据改变后执行副作用
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[], // getter
  cb: WatchCallback<T>, // handler  xxx(newVal, oldVal)
  options?: WatchOptions // watchOptions[key]
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}

// watch API，数据改变后执行副作用
function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect, // getter | 副作用cb(watchEffect)
  cb: WatchCallback | null, // handler  xxx(newVal, oldVal) | null(watchEffect)
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ // watchOptions[key]
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  const instance = currentInstance

  let getter: () => any
  // 根据source的不同情况，处理得到getter
  // getter是用来根据key取最新值的，取值的同时进行依赖收集
  // source为function的情况会兼容的Vue2.x的watch，其他都是处理Vue3.x中的语法
  if (isArray(source)) { // array，对数组中的多个源进行同时watch，getter返回值为数组
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isRef(source)) { // ref，就取ref.value
    getter = () => source.value
  } else if (isReactive(source)) { // reactive，将deep设为true
    getter = () => source
    deep = true
  } else if (isFunction(source)) { // 常规情况，兼容Vue2.x的watch
    if (cb) {
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      // watchEffect
      // getter就是执行source的函数，也就是执行副作用cb的函数
      getter = () => {
        if (instance && instance.isUnmounted) {
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate] // 可以传入onInvalidate函数，这个函数的执行时机在每次执行副作用cb之前或者停止侦听时，如 传入取消之前的异步操作
        )
      }
    }
  } else { // 其他情况，直接将getter设为NOOP，不做watch
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 递归的取值，在取值的过程中自然地进行依赖收集
  // 这样深层的数据变化，也会触发这里的handler
  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: () => void
  // 可以传入onInvalidate函数，这个函数的执行时机在每次执行副作用cb之前或者停止侦听时，如 传入取消之前的异步操作
  // watchEffect((onInvalidate) => {
  //   const token = performAsyncOperation(id.value)
  //   onInvalidate(() => {
  //     // id 改变时 或 停止侦听时
  //     // 取消之前的异步操作
  //     token.cancel()
  //   })
  // })
  const onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  // SSR这里不需要做响应式，只需要执行副作用cb，然后直接return
  if (__NODE_JS__ && isInSSRComponentSetup) {
    if (!cb) {
      // 这里的getter是watchEffect下的副作用cb
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  // 执行handler
  // watchEffect对应的applyCb为undefined
  const applyCb = cb
    ? () => {
        if (instance && instance.isUnmounted) {
          return
        }
        // 获取新值
        // immediate的情况下这里还会进行依赖收集
        const newValue = runner()
        // deep或者值改变，会执行handler
        // 带deep的引用类型，内部值发生改变，但是引用地址却还是相同，所以这里要多一个判断
        // 如果不是deep，则走到这里的新老value必然不相同，因为就是通过value的改变才触发的effect
        if (deep || hasChanged(newValue, oldValue)) {
          // cleanup before running cb again
          if (cleanup) {
            cleanup()
          }
          // 直接handler
          callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            // 如果传入immediate，这里的oldValue为INITIAL_WATCHER_VALUE
            oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
            // 可以传入onInvalidate函数，这个函数的执行时机在每次执行副作用cb之前或者停止侦听时，如 传入取消之前的异步操作
            onInvalidate
          ])
          // 更新值
          oldValue = newValue
        }
      }
    : void 0

  let scheduler: (job: () => any) => void
  if (flush === 'sync') { // sync 同步触发，很少用到，同步就意味着低效
    scheduler = invoke
  } else if (flush === 'pre') { // pre 组件更新前执行handler
    scheduler = job => {
      if (!instance || instance.isMounted) {
        // 没有instance或者instance已经mount完毕
        // 推入queue队列，这个是组件更新队列
        queueJob(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        // 有instance且还没有mount完毕，也就是在这个instance的mount过程中
        // 这里直接执行就行实现了在组件更新前执行handler
        job()
      }
    }
  } else { // post和watchEffect 组件更新后执行handler
    // 将applyCb推入postFlushCbs队列回调，等到异步更新时执行
    // 这个postFlushCbs队列在组件更新队列queue之后，所以时更新后执行handler
    scheduler = job => queuePostRenderEffect(job, instance && instance.suspense)
  }

  // watch借用computed effect
  // 首次不会执行，因为这里有可能需要返回值，所以统一放在下面进行首次执行
  // 单单用一个computed effect，而不改写get，是不会做effect的结果做缓存的
  // 所以watch是不带缓存的，也不应该缓存，因为每次都是数据改变才触发watch的handler，缓存没有意义
  const runner = effect(getter, {
    lazy: true,
    // so it runs before component update effects in pre flush mode
    computed: true,
    onTrack,
    onTrigger,
    // 有handler就执行handler，没有handler就scheduler(effect)，触发effect的更新
    // 这个scheduler只有在响应式数据触发trigger的时候才会调用
    // watchEffect对应的applyCb为undefined，所以scheduler为job => queuePostRenderEffect(job, instance && instance.suspense)
    // 也就是watchEffect的副作用cb一定是在组件更新后执行的
    scheduler: applyCb ? () => scheduler(applyCb) : scheduler
  })

  // currentInstance.effects.push(runner)
  // 将这个watch effect推入当前实例的effects数组中
  // 这个数组是当前实例包含的所有effects
  recordInstanceBoundEffect(runner)

  // initial run
  // 传入了immediate，则会在初次执行一次handler，此时的handler中的参数只有一个，为newVal
  // 没有传入immediate，仅仅是内部执行getter更新一下oldValue，同时进行依赖收集，用于之后的handler
  // 如果没有handler，就runner一次，也就是进行依赖收集
  if (applyCb) {
    if (immediate) {
      applyCb()
    } else {
      oldValue = runner()
    }
  } else { // watchEffect，会立即执行一次，进行依赖收集
    runner()
  }

  // 返回值函数用于停止响应式watch并卸载
  return () => {
    stop(runner)
    if (instance) {
      remove(instance.effects!, runner)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  cb: Function,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? () => publicThis[source]
    : source.bind(publicThis)
  const stop = watch(getter, cb.bind(publicThis), options)
  // beforeUnmount时卸载watch effect
  onBeforeUnmount(stop, this)
  return stop
}

// 深层遍历取值，依赖收集
function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  if (!isObject(value) || seen.has(value)) {
    return value
  }
  seen.add(value)
  if (isArray(value)) { // array
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (value instanceof Map) { // map
    value.forEach((v, key) => {
      // to register mutation dep for existing keys
      traverse(value.get(key), seen)
    })
  } else if (value instanceof Set) { // set
    value.forEach(v => {
      traverse(v, seen)
    })
  } else { // object
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
