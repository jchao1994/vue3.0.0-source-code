import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T> // 直接传函数，就当作getter，也可以传入带get和set方法的option
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  if (isFunction(getterOrOptions)) { // 如果传入的是回调函数，默认没有set方法，不可修改
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else { // 如果想要得到可手动修改的computed，必须传入带get方法和set方法的对象
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 标记为脏数据，表示需要重新计算并缓存
  let dirty = true
  let value: T
  let computed: ComputedRef<T>

  const runner = effect(getter, {
    // 标记为lazy
    lazy: true,
    // mark effect as computed so that it gets priority during trigger
    // trigger时根据computed标识提取computed，优先于普通effect进行更新
    computed: true,
    // 当通知computed effect更新时，把dirty重新设置为true，即需要重新计算并缓存值
    // 然后执行trigger通知依赖computed的那些effect更新，然后就会取computed.value重新计算并缓存
    scheduler: () => {
      if (!dirty) {
        dirty = true
        trigger(computed, TriggerOpTypes.SET, 'value')
      }
    }
  })
  computed = {
    __v_isRef: true, // computed的标志也是ref的标志__v_isRef
    // expose effect so computed can be stopped
    effect: runner,
    get value() {
      // dirty为true，计算缓存值并依赖收集(被computed依赖的数据添加这个computed effect依赖)
      if (dirty) {
        // 执行runner，也就是effect时，会进行依赖收集
        value = runner()
        dirty = false
      }
      // 如果dirty为false，直接进行依赖收集并返回缓存值
      track(computed, TrackOpTypes.GET, 'value') // 依赖收集(依赖computed的那些effect)
      return value
    },
    // 因为computed是依赖其他数据的，所以这里set其他值之后自然就会触发自身的更新将dirty重置为true
    set value(newValue: T) {
      setter(newValue)
    }
  } as any
  return computed
}
