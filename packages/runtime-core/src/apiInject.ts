import { currentInstance } from './component'
import { currentRenderingInstance } from './componentRenderUtils'
import { warn } from './warning'

export interface InjectionKey<T> extends Symbol {}

// currentInstance.provides的原型链指向currentInstance.parent.provides，用于后代inject获取
// 将自身的provide都添加到currentInstance.provides中
export function provide<T>(key: InjectionKey<T> | string, value: T) {
  if (!currentInstance) {
    if (__DEV__) {
      warn(`provide() can only be used inside setup().`)
    }
  } else {
    let provides = currentInstance.provides
    // by default an instance inherits its parent's provides object
    // but when it needs to provide values of its own, it creates its
    // own provides object using parent provides object as prototype.
    // this way in `inject` we can simply look up injections from direct
    // parent and let the prototype chain do the work.
    const parentProvides =
      currentInstance.parent && currentInstance.parent.provides
    if (parentProvides === provides) {
      provides = currentInstance.provides = Object.create(parentProvides)
    }
    // TS doesn't allow symbol as index type
    provides[key as string] = value
  }
}

export function inject<T>(key: InjectionKey<T> | string): T | undefined
export function inject<T>(key: InjectionKey<T> | string, defaultValue: T): T
// 由于instance.provides的原型链指向instance.parent.provides
// 所以这里的provides可以获取到父组件以及祖先组件的provides
// 而inject处理早于provides，所以不会获取到自身组件的provides
// 如果没有找到对应provide，就取defaultValue
export function inject(
  key: InjectionKey<any> | string,
  defaultValue?: unknown
) {
  // fallback to `currentRenderingInstance` so that this can be called in
  // a functional component
  const instance = currentInstance || currentRenderingInstance
  if (instance) {
    // 由于instance.provides的原型链指向instance.parent.provides
    // 所以这里的provides可以获取到父组件以及祖先组件的provides
    // 而inject处理早于provides，所以不会获取到自身组件的provides
    const provides = instance.provides
    if (key in provides) {
      // TS doesn't allow symbol as index type
      return provides[key as string]
    } else if (arguments.length > 1) { // 如果没有找到对应provide，就取defaultValue
      return defaultValue
    } else if (__DEV__) {
      warn(`injection "${String(key)}" not found.`)
    }
  } else if (__DEV__) {
    warn(`inject() can only be used inside setup() or functional components.`)
  }
}
