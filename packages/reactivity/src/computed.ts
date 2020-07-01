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
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
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

  let dirty = true
  let value: T
  let computed: ComputedRef<T>

  const runner = effect(getter, {
    lazy: true,
    // mark effect as computed so that it gets priority during trigger
    // trigger时根据computed标识提取computed，优先于普通effect进行更新
    computed: true,
    scheduler: () => { // 当通知computed effect更新时，当dirty重新设置为true(即需要重新计算并缓存值)，并执行trigger通知依赖computed的那些effect更新，然后就会取computed.value重新计算缓存
      if (!dirty) {
        dirty = true
        trigger(computed, TriggerOpTypes.SET, 'value')
      }
    }
  })
  computed = {
    __v_isRef: true,
    // expose effect so computed can be stopped
    effect: runner,
    get value() {
      if (dirty) { // dirty为true，计算缓存值并依赖收集(被computed依赖的数据添加这个computed effect依赖)
        value = runner()
        dirty = false
      }
      track(computed, TrackOpTypes.GET, 'value') // 依赖收集(依赖computed的那些effect)
      return value
    },
    set value(newValue: T) { // 不会触发响应式更新？？？
      setter(newValue)
    }
  } as any
  return computed
}
