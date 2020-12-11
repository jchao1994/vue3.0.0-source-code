import {
  PublicAPIComponent,
  Component,
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup
} from './component'
import { isFunction, isObject } from '@vue/shared'
import { ComponentPublicInstance } from './componentProxy'
import { createVNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { warn } from './warning'
import { ref } from '@vue/reactivity'
import { handleError, ErrorCodes } from './errorHandling'

export type AsyncComponentResolveResult<T = PublicAPIComponent> =
  | T
  | { default: T } // es modules

export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  loader: AsyncComponentLoader<T>
  loadingComponent?: PublicAPIComponent
  errorComponent?: PublicAPIComponent
  delay?: number
  timeout?: number
  suspensible?: boolean
  onError?: (
    error: Error,
    retry: () => void,
    fail: () => void,
    attempts: number
  ) => any
}

// defineAsyncComponent(() => import('./OtherComponent'))
// defineAsyncComponent({
//   loader: () => import('./OtherComponent'),  异步加载组件
//   loadingComponent?: PublicAPIComponent  loading组件
//   errorComponent?: PublicAPIComponent  error组件
//   delay?: number
//   timeout?: number
//   suspensible?: boolean
//   onError?: (
//     error: Error,
//     retry: () => void,
//     fail: () => void,
//     attempts: number
//   ) => any
// })
// 返回{ __asyncLoader: load, name: 'AsyncComponentWrapper', setup: function }
// 其中load是加载组件异步方法，而setup是返回 生成对应组件(loader loading error)的初始vnode 的render函数
// 一旦当前异步组件的loaded error delayed变化时，其父组件就会更新
// 然后当前异步组件就会重新执行render方法，更新状态
export function defineAsyncComponent<
  T extends PublicAPIComponent = { new (): ComponentPublicInstance }
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // 格式化处理source
  if (isFunction(source)) {
    source = { loader: source }
  }

  const {
    loader, // 异步加载组件
    loadingComponent: loadingComponent, // loading组件
    errorComponent: errorComponent, // error组件
    delay = 200, // 延时
    timeout, // undefined = never times out // 超时报错
    suspensible = true,
    onError: userOnError
  } = source

  let pendingRequest: Promise<Component> | null = null
  let resolvedComp: Component | undefined

  let retries = 0
  // 重试
  const retry = () => {
    retries++
    pendingRequest = null
    return load()
  }

  // 执行load，返回加载完成的组件选项(状态组件，常规vue文件)或是构造函数(无状态组件)
  const load = (): Promise<Component> => {
    let thisRequest: Promise<Component>
    return (
      pendingRequest || // 1逻辑
      (thisRequest = pendingRequest = loader() // 2逻辑
        .catch(err => {
          err = err instanceof Error ? err : new Error(String(err))
          if (userOnError) {
            return new Promise((resolve, reject) => {
              const userRetry = () => resolve(retry())
              const userFail = () => reject(err)
              userOnError(err, userRetry, userFail, retries + 1)
            })
          } else {
            throw err
          }
        })
        .then((comp: any) => {
          // 走1逻辑进来的，thisRequest为null，直接返回pendingRequest
          if (thisRequest !== pendingRequest && pendingRequest) {
            return pendingRequest
          }
          if (__DEV__ && !comp) {
            warn(
              `Async component loader resolved to undefined. ` +
                `If you are using retry(), make sure to return its return value.`
            )
          }
          // interop module default
          // 这里是处理es6的import导入???
          if (
            comp &&
            (comp.__esModule || comp[Symbol.toStringTag] === 'Module')
          ) {
            comp = comp.default
          }
          if (__DEV__ && comp && !isObject(comp) && !isFunction(comp)) {
            throw new Error(`Invalid async component load result: ${comp}`)
          }
          // 返回加载完成的组件选项(状态组件，常规vue文件)或是构造函数(无状态组件)
          resolvedComp = comp
          return comp
        }))
    )
  }

  // 返回{ __asyncLoader: load, name: 'AsyncComponentWrapper', setup: function }
  return defineComponent({
    // 这个在SSR混合中用到了
    __asyncLoader: load,
    name: 'AsyncComponentWrapper',
    // 返回一个 生成对应组件的初始vnode 的render函数
    // 一旦当前异步组件的loaded error delayed变化时，其父组件就会更新
    // 然后当前异步组件就会重新执行render方法，更新状态
    setup() {
      const instance = currentInstance!

      // already resolved
      // 组件已经加载完成
      // SSR混合中的__asyncLoader逻辑会先load完成，拿到resolvedComp，然后走这里的逻辑返回render函数
      if (resolvedComp) {
        // 返回comp对应的初始vnode对象
        return () => createInnerComp(resolvedComp!, instance)
      }

      const onError = (err: Error) => {
        pendingRequest = null
        handleError(err, instance, ErrorCodes.ASYNC_COMPONENT_LOADER)
      }

      // suspense-controlled or SSR.
      // 客户端渲染的suspense中(也就是说这里是suspense内部的defineAsyncComponent异步组件) 或 SSR在服务端执行renderToString
      // 这里setup返回值为promise
      // 在 packages/runtime-core/src/component.ts 上有对setupResult为promise的处理
      // renderToString是在服务端执行的，自然不需要显示页面，也就不需要loading和error
      // 在suspense内部，也不需要loading和error，因为suspense里面有fallback
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__NODE_JS__ && isInSSRComponentSetup)
      ) {
        return load()
          .then(comp => {
            return () => createInnerComp(comp, instance)
          })
          .catch(err => {
            onError(err)
            return () =>
              errorComponent
                ? createVNode(errorComponent as Component, { error: err })
                : null
          })
      }

      // 通过ref，给当前渲染的组件render effect添加依赖
      // 一旦loaded error delayed的value发生改变，会触发当前渲染组件的effect更新
      const loaded = ref(false)
      const error = ref()
      const delayed = ref(!!delay)

      // 设置delay延时
      if (delay) {
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

      // 设置超时报错
      if (timeout != null) {
        setTimeout(() => {
          if (!loaded.value) {
            const err = new Error(
              `Async component timed out after ${timeout}ms.`
            )
            onError(err)
            error.value = err
          }
        }, timeout)
      }

      // 执行load，完成之后loaded.value标记为true
      // 执行完load，resolvedComp就是对应的组件选项或构造函数
      load()
        .then(() => {
          loaded.value = true
        })
        .catch(err => {
          onError(err)
          error.value = err
        })

      // 返回 生成对应组件的初始vnode 的render函数
      return () => {
        if (loaded.value && resolvedComp) { // 加载完成，返回组件对应的初始vnode
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) { // 错误，返回error组件对应的初始vnode
          return createVNode(errorComponent as Component, {
            error: error.value
          })
        } else if (loadingComponent && !delayed.value) { // 未加载完成 且 未出错 且 延时结束，返回loading组件的初始vnode
          return createVNode(loadingComponent as Component)
        }
      }
    }
  }) as any
}

// 返回comp对应的初始vnode对象
function createInnerComp(
  comp: Component,
  { vnode: { props, children } }: ComponentInternalInstance
) {
  return createVNode(comp, props, children)
}
