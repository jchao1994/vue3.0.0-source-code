import {
  Component,
  Data,
  validateComponentName,
  PublicAPIComponent
} from './component'
import { ComponentOptions } from './componentOptions'
import { ComponentPublicInstance } from './componentProxy'
import { Directive, validateDirectiveName } from './directives'
import { RootRenderFunction } from './renderer'
import { InjectionKey } from './apiInject'
import { isFunction, NO, isObject } from '@vue/shared'
import { warn } from './warning'
import { createVNode, cloneVNode, VNode } from './vnode'
import { RootHydrateFunction } from './hydration'

export interface App<HostElement = any> {
  config: AppConfig
  use(plugin: Plugin, ...options: any[]): this
  mixin(mixin: ComponentOptions): this
  component(name: string): PublicAPIComponent | undefined
  component(name: string, component: PublicAPIComponent): this
  directive(name: string): Directive | undefined
  directive(name: string, directive: Directive): this
  mount(
    rootContainer: HostElement | string,
    isHydrate?: boolean
  ): ComponentPublicInstance
  unmount(rootContainer: HostElement | string): void
  provide<T>(key: InjectionKey<T> | string, value: T): this

  // internal. We need to expose these for the server-renderer
  _component: Component
  _props: Data | null
  _container: HostElement | null
  _context: AppContext
}

export type OptionMergeFunction = (
  to: unknown,
  from: unknown,
  instance: any,
  key: string
) => any

export interface AppConfig {
  // @private
  readonly isNativeTag?: (tag: string) => boolean

  devtools: boolean
  performance: boolean
  optionMergeStrategies: Record<string, OptionMergeFunction>
  globalProperties: Record<string, any>
  isCustomElement: (tag: string) => boolean
  errorHandler?: (
    err: unknown,
    instance: ComponentPublicInstance | null,
    info: string
  ) => void
  warnHandler?: (
    msg: string,
    instance: ComponentPublicInstance | null,
    trace: string
  ) => void
}

export interface AppContext {
  config: AppConfig
  mixins: ComponentOptions[]
  components: Record<string, PublicAPIComponent>
  directives: Record<string, Directive>
  provides: Record<string | symbol, any>
  reload?: () => void // HMR only
}

type PluginInstallFunction = (app: App, ...options: any[]) => any

export type Plugin =
  | PluginInstallFunction & { install?: PluginInstallFunction }
  | {
      install: PluginInstallFunction
    }

// 创建app上下文 包括config mixins components directives provides
export function createAppContext(): AppContext {
  return {
    config: {
      isNativeTag: NO,
      devtools: true,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      isCustomElement: NO,
      errorHandler: undefined,
      warnHandler: undefined
    },
    mixins: [],
    components: {},
    directives: {},
    provides: Object.create(null)
  }
}

export type CreateAppFunction<HostElement> = (
  rootComponent: PublicAPIComponent,
  rootProps?: Data | null
) => App<HostElement>

// 这个函数返回的function才是真正的createApp方法
// createApp(App).use(store).use(router).mount('#app')
export function createAppAPI<HostElement>(
  render: RootRenderFunction,
  hydrate?: RootHydrateFunction
): CreateAppFunction<HostElement> {
  
  // rootComponent 根组件选项，一般为App
  // rootProps 一般不传
  // 创建app对象并返回，带use mixin component directive mount unmount provide方法
  return function createApp(rootComponent, rootProps = null) {
    // rootProps只能是null或者object
    if (rootProps != null && !isObject(rootProps)) {
      __DEV__ && warn(`root props passed to app.mount() must be an object.`)
      rootProps = null
    }

    // 初始化上下文context(包括config mixins components directives provides)和已加载插件installedPlugins
    const context = createAppContext()
    const installedPlugins = new Set()

    // 标记是否已经挂载
    let isMounted = false

    // 创建app对象并返回，带use mixin component directive mount unmount provide方法
    const app: App = {
      _component: rootComponent as Component, // 根组件选项
      _props: rootProps, // 根props，一般为null
      _container: null,
      _context: context, // 根上下文，包括config mixins components directives provides

      // 获取context.config
      get config() {
        return context.config
      },

      // 不能修改context.config
      set config(v) {
        if (__DEV__) {
          warn(
            `app.config cannot be replaced. Modify individual options instead.`
          )
        }
      },

      // Vue.use全局注册插件方法，添加到installedPlugins中，同Vue2.x
      // 支持plugin是 带install方法的object 或 function(将自身作为install方法)
      // 返回app用于链式调用
      use(plugin: Plugin, ...options: any[]) {
        if (installedPlugins.has(plugin)) {
          // 不能重复注册，dev模式下会报警
          __DEV__ && warn(`Plugin has already been applied to target app.`)
        } else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin)
          plugin.install(app, ...options)
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin)
          plugin(app, ...options)
        } else if (__DEV__) {
          warn(
            `A plugin must either be a function or an object with an "install" ` +
              `function.`
          )
        }
        // 返回app用于链式调用
        return app
      },

      // Vue.mixin全局混入方法，添加到context.mixins中，同Vue2.x
      // 只适用于Options API，不适用于Composition API
      // 返回app用于链式调用
      mixin(mixin: ComponentOptions) {
        if (__FEATURE_OPTIONS__) {
          // Options API支持mixins
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin)
          } else if (__DEV__) {
            // dev模式下重复会报警
            warn(
              'Mixin has already been applied to target app' +
                (mixin.name ? `: ${mixin.name}` : '')
            )
          }
        } else if (__DEV__) {
          // Composition API不支持mixins，直接用useHooks代替mixins
          warn('Mixins are only available in builds supporting Options API')
        }
        // 返回app用于链式调用
        return app
      },

      // Vue.component全局注册组件，添加到context.components中，同Vue2.x
      // context.components中存放的是name-组件选项
      // 返回app用于链式调用
      component(name: string, component?: PublicAPIComponent): any {
        // 不能使用内建tag或者原生tag
        if (__DEV__) {
          validateComponentName(name, context.config)
        }
        // 不传入component，就是get方法，返回注册的同名component
        if (!component) {
          return context.components[name]
        }
        // 不能重复注册component
        if (__DEV__ && context.components[name]) {
          warn(`Component "${name}" has already been registered in target app.`)
        }
        // 传入component，就是set方法
        context.components[name] = component
        // 返回app用于链式调用
        return app
      },

      // Vue.directive全局注册指令，添加到context.directives中，同Vue2.x
      // context.directives中存放的是name-指令选项(自定义指令 API 已更改为与组件生命周期一致，Vue3.x的改动)
      // 返回app用于链式调用
      directive(name: string, directive?: Directive) {
        // 不能是内建指令名字
        if (__DEV__) {
          validateDirectiveName(name)
        }

        // 不传入directive，就是get方法，返回注册的同名指令
        if (!directive) {
          return context.directives[name] as any
        }
        // 不能重复注册directive
        if (__DEV__ && context.directives[name]) {
          warn(`Directive "${name}" has already been registered in target app.`)
        }
        // 传入directive，就是set方法
        context.directives[name] = directive
        // 返回app用于链式调用
        return app
      },

      // 挂载
      // 1. createVNode生成vnode虚拟dom
      // 2. render(核心逻辑就是patch)
      // createApp(App).use(store).use(router).mount('#app')
      // rootContainer一般为'#app'
      mount(rootContainer: HostElement, isHydrate?: boolean): any {
        if (!isMounted) {
          // 创建根组件vnode
          // 这里已经完成了组件类型二进制标志shapeFlag和children的处理
          const vnode = createVNode(rootComponent as Component, rootProps)
          // store app context on the root VNode.
          // this will be set on the root instance on initial mount.
          // 根vnode绑定上下文appContext
          vnode.appContext = context

          // HMR root reload
          if (__DEV__) {
            context.reload = () => {
              render(cloneVNode(vnode), rootContainer)
            }
          }

          if (isHydrate && hydrate) {
            // SSR
            hydrate(vnode as VNode<Node, Element>, rootContainer as any)
          } else {
            // 非SSR，走render渲染
            render(vnode, rootContainer)
          }
          // 标记已经挂载
          isMounted = true
          // 将根容器绑定到app._container上
          app._container = rootContainer
          // !非空断言
          // 返回的是什么???作用???
          return vnode.component!.proxy
        } else if (__DEV__) {
          // dev模式下重复挂载报警
          warn(
            `App has already been mounted.\n` +
              `If you want to remount the same app, move your app creation logic ` +
              `into a factory function and create fresh app instances for each ` +
              `mount - e.g. \`const createMyApp = () => createApp(App)\``
          )
        }
      },

      // 卸载
      unmount() {
        if (isMounted) {
          render(null, app._container)
        } else if (__DEV__) {
          // dev模式下对未挂载的app卸载会报警
          warn(`Cannot unmount an app that is not mounted.`)
        }
      },

      // 根app的provide，添加到context.provides中
      // 返回app用于链式调用
      provide(key, value) {
        if (__DEV__ && key in context.provides) {
          // dev模式下重复定义provide会报警
          warn(
            `App already provides property with key "${String(key)}". ` +
              `It will be overwritten with the new value.`
          )
        }
        // TypeScript doesn't allow symbols as index type
        // https://github.com/Microsoft/TypeScript/issues/24587
        context.provides[key as string] = value
        // 返回app用于链式调用
        return app
      }
    }

    // createApp(App)的返回值，用于链式调用use mixin component directive mount unmount provide
    return app
  }
}
