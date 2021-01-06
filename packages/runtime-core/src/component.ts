import { VNode, VNodeChild, isVNode } from './vnode'
import {
  reactive,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
  shallowReadonly
} from '@vue/reactivity'
import {
  CreateComponentPublicInstance,
  ComponentPublicInstance,
  PublicInstanceProxyHandlers,
  RuntimeCompiledPublicInstanceProxyHandlers,
  createRenderContext,
  exposePropsOnRenderContext,
  exposeSetupStateOnRenderContext
} from './componentProxy'
import {
  ComponentPropsOptions,
  NormalizedPropsOptions,
  initProps
} from './componentProps'
import { Slots, initSlots, InternalSlots } from './componentSlots'
import { warn } from './warning'
import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { AppContext, createAppContext, AppConfig } from './apiCreateApp'
import { Directive, validateDirectiveName } from './directives'
import { applyOptions, ComponentOptions } from './componentOptions'
import {
  EmitsOptions,
  ObjectEmitsOptions,
  EmitFn,
  emit
} from './componentEmits'
import {
  EMPTY_OBJ,
  isFunction,
  NOOP,
  isObject,
  NO,
  makeMap,
  isPromise,
  ShapeFlags
} from '@vue/shared'
import { SuspenseBoundary } from './components/Suspense'
import { CompilerOptions } from '@vue/compiler-core'
import {
  currentRenderingInstance,
  markAttrsAccessed
} from './componentRenderUtils'
import { startMeasure, endMeasure } from './profiling'

export type Data = { [key: string]: unknown }

// Note: can't mark this whole interface internal because some public interfaces
// extend it.
export interface ComponentInternalOptions {
  /**
   * @internal
   */
  __props?: NormalizedPropsOptions | []
  /**
   * @internal
   */
  __scopeId?: string
  /**
   * @internal
   */
  __cssModules?: Data
  /**
   * @internal
   */
  __hmrId?: string
  /**
   * This one should be exposed so that devtools can make use of it
   */
  __file?: string
}

export interface FunctionalComponent<
  P = {},
  E extends EmitsOptions = Record<string, any>
> extends ComponentInternalOptions {
  // use of any here is intentional so it can be a valid JSX Element constructor
  (props: P, ctx: SetupContext<E>): any
  props?: ComponentPropsOptions<P>
  emits?: E | (keyof E)[]
  inheritAttrs?: boolean
  inheritRef?: boolean
  displayName?: string
}

export interface ClassComponent {
  new (...args: any[]): ComponentPublicInstance<any, any, any, any, any>
  __vccOpts: ComponentOptions
}

export type Component = ComponentOptions | FunctionalComponent<any>

// A type used in public APIs where a component type is expected.
// The constructor type is an artificial type returned by defineComponent().
export type PublicAPIComponent =
  | Component
  | {
      new (...args: any[]): CreateComponentPublicInstance<
        any,
        any,
        any,
        any,
        any
      >
    }

export { ComponentOptions }

type LifecycleHook = Function[] | null

export const enum LifecycleHooks {
  BEFORE_CREATE = 'bc',
  CREATED = 'c',
  BEFORE_MOUNT = 'bm',
  MOUNTED = 'm',
  BEFORE_UPDATE = 'bu',
  UPDATED = 'u',
  BEFORE_UNMOUNT = 'bum',
  UNMOUNTED = 'um',
  DEACTIVATED = 'da',
  ACTIVATED = 'a',
  RENDER_TRIGGERED = 'rtg',
  RENDER_TRACKED = 'rtc',
  ERROR_CAPTURED = 'ec'
}

export interface SetupContext<E = ObjectEmitsOptions> {
  attrs: Data
  slots: Slots
  emit: EmitFn<E>
}

/**
 * @internal
 */
export type InternalRenderFunction = {
  (
    ctx: ComponentPublicInstance,
    cache: ComponentInternalInstance['renderCache']
  ): VNodeChild
  _rc?: boolean // isRuntimeCompiled
}

/**
 * We expose a subset of properties on the internal instance as they are
 * useful for advanced external libraries and tools.
 */
export interface ComponentInternalInstance {
  uid: number
  type: Component
  parent: ComponentInternalInstance | null
  root: ComponentInternalInstance
  appContext: AppContext
  /**
   * Vnode representing this component in its parent's vdom tree
   */
  vnode: VNode
  /**
   * The pending new vnode from parent updates
   * @internal
   */
  next: VNode | null
  /**
   * Root vnode of this component's own vdom tree
   */
  subTree: VNode
  /**
   * The reactive effect for rendering and patching the component. Callable.
   */
  update: ReactiveEffect
  /**
   * The render function that returns vdom tree.
   * @internal
   */
  render: InternalRenderFunction | null
  /**
   * Object containing values this component provides for its descendents
   * @internal
   */
  provides: Data
  /**
   * Tracking reactive effects (e.g. watchers) associated with this component
   * so that they can be automatically stopped on component unmount
   * @internal
   */
  effects: ReactiveEffect[] | null
  /**
   * cache for proxy access type to avoid hasOwnProperty calls
   * @internal
   */
  accessCache: Data | null
  /**
   * cache for render function values that rely on _ctx but won't need updates
   * after initialized (e.g. inline handlers)
   * @internal
   */
  renderCache: (Function | VNode)[]

  /**
   * Asset hashes that prototypally inherits app-level asset hashes for fast
   * resolution
   * @internal
   */
  components: Record<string, Component>
  /**
   * @internal
   */
  directives: Record<string, Directive>

  // the rest are only for stateful components ---------------------------------

  // main proxy that serves as the public instance (`this`)
  proxy: ComponentPublicInstance | null

  /**
   * alternative proxy used only for runtime-compiled render functions using
   * `with` block
   * @internal
   */
  withProxy: ComponentPublicInstance | null
  /**
   * This is the target for the public instance proxy. It also holds properties
   * injected by user options (computed, methods etc.) and user-attached
   * custom properties (via `this.x = ...`)
   * @internal
   */
  ctx: Data

  // internal state
  data: Data
  props: Data
  attrs: Data
  slots: InternalSlots
  refs: Data
  emit: EmitFn

  /**
   * setup related
   * @internal
   */
  setupState: Data
  /**
   * @internal
   */
  setupContext: SetupContext | null

  /**
   * suspense related
   * @internal
   */
  suspense: SuspenseBoundary | null
  /**
   * @internal
   */
  asyncDep: Promise<any> | null
  /**
   * @internal
   */
  asyncResolved: boolean

  // lifecycle
  isMounted: boolean
  isUnmounted: boolean
  isDeactivated: boolean
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_CREATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.CREATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_MOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.MOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UPDATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UPDATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UNMOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UNMOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRACKED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRIGGERED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.DEACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ERROR_CAPTURED]: LifecycleHook
}

const emptyAppContext = createAppContext()

let uid = 0

// 创建组件实例
export function createComponentInstance(
  vnode: VNode, // 新初始vnode
  parent: ComponentInternalInstance | null, // 父组件实例
  suspense: SuspenseBoundary | null
) {
  // inherit parent app context - or - if root, adopt from root vnode
  // 继承父组件的appContext
  const appContext =
    (parent ? parent.appContext : vnode.appContext) || emptyAppContext
  const instance: ComponentInternalInstance = {
    uid: uid++,
    vnode,
    parent,
    appContext,
    type: vnode.type as Component,
    root: null!, // to be immediately set
    next: null,
    subTree: null!, // will be set synchronously right after creation
    update: null!, // will be set synchronously right after creation
    render: null,
    proxy: null,
    withProxy: null,
    effects: null,
    provides: parent ? parent.provides : Object.create(appContext.provides),
    accessCache: null!,
    renderCache: [],

    // state
    ctx: EMPTY_OBJ,
    data: EMPTY_OBJ,
    props: EMPTY_OBJ,
    attrs: EMPTY_OBJ,
    slots: EMPTY_OBJ,
    refs: EMPTY_OBJ,
    setupState: EMPTY_OBJ,
    setupContext: null,

    // per-instance asset storage (mutable during options resolution)
    components: Object.create(appContext.components),
    directives: Object.create(appContext.directives),

    // suspense related
    suspense,
    asyncDep: null,
    asyncResolved: false,

    // lifecycle hooks
    // not using enums here because it results in computed properties
    isMounted: false,
    isUnmounted: false,
    isDeactivated: false,
    bc: null,
    c: null,
    bm: null,
    m: null,
    bu: null,
    u: null,
    um: null,
    bum: null,
    da: null,
    a: null,
    rtg: null,
    rtc: null,
    ec: null,
    emit: null as any // to be set immediately
  }
  if (__DEV__) {
    instance.ctx = createRenderContext(instance)
  } else {
    instance.ctx = { _: instance }
  }
  // 每一个组件实例的root都指向全局根组件实例
  instance.root = parent ? parent.root : instance
  // 给组件实例绑定emit方法
  // this.$emit(event, ...args)
  instance.emit = emit.bind(null, instance)
  return instance
}

export let currentInstance: ComponentInternalInstance | null = null

export const getCurrentInstance: () => ComponentInternalInstance | null = () =>
  currentInstance || currentRenderingInstance

export const setCurrentInstance = (
  instance: ComponentInternalInstance | null
) => {
  currentInstance = instance
}

const isBuiltInTag = /*#__PURE__*/ makeMap('slot,component')

export function validateComponentName(name: string, config: AppConfig) {
  const appIsNativeTag = config.isNativeTag || NO
  if (isBuiltInTag(name) || appIsNativeTag(name)) {
    warn(
      'Do not use built-in or reserved HTML elements as component id: ' + name
    )
  }
}

export let isInSSRComponentSetup = false

// 初始化props和slots
// 执行传入的setup函数，就可以知道是否传入了render函数
// 然后决定是否编译模板生成render函数
// 最后对Options API做兼容处理
// 这里只有在SSR的情况下才有返回值，返回值是一个promise
export function setupComponent(
  instance: ComponentInternalInstance,
  isSSR = false
) {
  isInSSRComponentSetup = isSSR

  const { props, children, shapeFlag } = instance.vnode
  // 有状态组件，也就是普通vue文件
  const isStateful = shapeFlag & ShapeFlags.STATEFUL_COMPONENT
  // 初始化instance上的props，将处理后的大部分存放在instance.props中，小部分存放到instance.attrs中
  // instance.vnode.props(setup的返回props)和instance.type.props(传入的props)都进行了处理
  // 客户端渲染在这里会对props进行浅层proxy响应式，服务端渲染则不会
  initProps(instance, props, isStateful, isSSR)
  // 初始化slots
  // 处理带slot标签的具名插槽和没有slot标签的默认插槽，更新到intance.slots上，默认插槽的名字为default
  initSlots(instance, children)

  const setupResult = isStateful
    // 状态组件都会走这一步，无论是否有setup函数
    // setup函数是一个可以返回render函数的Composition API
    // 根据setup的返回值，决定是否编译模板生成render函数
    // 然后对Options API做兼容处理
    // 这里只有在SSR的情况下才有返回值，返回值是一个promise
    ? setupStatefulComponent(instance, isSSR)
    : undefined
  // 重置isInSSRComponentSetup为false
  isInSSRComponentSetup = false
  return setupResult
}

// 状态组件都会走这一步，无论是否有setup函数
// setup函数是一个可以返回render函数的Composition API
// 根据setup的返回值，决定是否编译模板生成render函数
// 然后对Options API做兼容处理
// 这里只有在SSR的情况下才有返回值，返回值是一个promise
function setupStatefulComponent(
  instance: ComponentInternalInstance, // 组件实例
  isSSR: boolean
) {
  // 组件选项
  const Component = instance.type as ComponentOptions

  if (__DEV__) {
    if (Component.name) {
      validateComponentName(Component.name, instance.appContext.config)
    }
    if (Component.components) {
      const names = Object.keys(Component.components)
      for (let i = 0; i < names.length; i++) {
        validateComponentName(names[i], instance.appContext.config)
      }
    }
    if (Component.directives) {
      const names = Object.keys(Component.directives)
      for (let i = 0; i < names.length; i++) {
        validateDirectiveName(names[i])
      }
    }
  }
  // 0. create render proxy property access cache
  // 创建render代理属性访问的缓存
  instance.accessCache = {}
  // 1. create public instance / render proxy
  // also mark it raw so it's never observed
  // instance.proxy是instance.ctx._的代理，instance.proxy.xxx实际取的时instance.ctx._.xxx
  // instance.ctx._指向原始instance
  // 这里是的时机是组件初始化之后，还没执行setup，也就是还没有进行模板编译
  // 后续的render函数，会将上下文context替换为 instance.withProxy || instance.proxy，也就是说这里的代理会在render过程中生效
  // applyOptions兼容Options API时将需要this的API，用instance.proxy当作原类语法的this
  instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers)
  if (__DEV__) {
    exposePropsOnRenderContext(instance)
  }
  // 2. call setup()
  const { setup } = Component
  if (setup) { // Vue3 setup语法
    // setupContext = { attrs: instance.attrs, slots: instance.slots, emit: instance.emit }
    // setup上下文，带attrs slots emit
    const setupContext = (instance.setupContext =
      setup.length > 1 ? createSetupContext(instance) : null)
    
    // 当前组件实例指向这个instance
    currentInstance = instance
    // 暂停Track
    pauseTracking()
    // 执行setup()，传入props和setupContext作为参数，过程中不进行track依赖收集
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      ErrorCodes.SETUP_FUNCTION,
      [__DEV__ ? shallowReadonly(instance.props) : instance.props, setupContext]
    )
    // 重置Track和currentInstance
    resetTracking()
    currentInstance = null

    if (isPromise(setupResult)) { // setupResult为promise，主要用于SSR???
      // SSR在服务端执行renderToString时遇到defineAsyncComponent异步组件，这时的setupResult会是一个promise

      if (isSSR) { // SSR在服务端执行renderToString
        // return the promise so server-renderer can wait on it
        // 这里的resolvedResult是 生成初始vnode的render函数 () => createInnerComp(comp, instance)
        // 这里同步返回出去的还是一个promise，返回到 packages/server-renderer/src/renderToString.ts 的 renderComponentVNode 中
        return setupResult.then((resolvedResult: unknown) => {
          // 将返回的render函数放在instance.render上
          // 但这里没有进一步的mount
          handleSetupResult(instance, resolvedResult, isSSR)
        })
      } else if (__FEATURE_SUSPENSE__) { // 客户端渲染的suspense中，也就是说这里是suspense内部的defineAsyncComponent异步组件
        // async setup returned Promise.
        // bail here and wait for re-entry.
        // setupResult是一个promise，这里promise内部完成异步加载组件，然后把setup的返回值render函数放到instance.render上
        // render和hydrate都会走到这里
        instance.asyncDep = setupResult
      } else if (__DEV__) {
        warn(
          `setup() returned a Promise, but the version of Vue you are using ` +
            `does not support it yet.`
        )
      }
    } else {
      // setupResult为function，替换instance.render
      // setupResult为字面量对象，就reactive处理之后赋值给instance.setupState
      // 最后也会做如下操作
      // 模板编译生成render函数(如果setup没有返回render函数的话)，放在instance.render上
      // 如果要使用Vue2.x Options API，这个会做兼容处理
      handleSetupResult(instance, setupResult, isSSR)
    }
  } else { // 没有传入setup
    // 这里才知道是否传入了render，然后决定是否编译模板生成render函数
    // 模板编译生成render函数(如果setup没有返回render函数的话)，放在instance.render上
    // 如果要使用Vue2.x Options API，这个会做兼容处理
    finishComponentSetup(instance, isSSR)
  }
}

// 得到setup函数的返回值setupResult后进行的操作
// 根据setupResult的类型，决定处理成render还是setupState
// 然后决定是否通过模板编译生成render
// 最后看是否要兼容处理Options API
export function handleSetupResult(
  instance: ComponentInternalInstance,
  setupResult: unknown, // setup()的返回值
  isSSR: boolean
) {
  if (isFunction(setupResult)) { // setupResult是function，就作为instance.render函数
    // setup returned an inline render function
    instance.render = setupResult as InternalRenderFunction
  } else if (isObject(setupResult)) {
    if (__DEV__ && isVNode(setupResult)) { // setupResult不能直接是vnode
      warn(
        `setup() should not return VNodes directly - ` +
          `return a render function instead.`
      )
    }
    // setup returned bindings.
    // assuming a render function compiled from template is present.
    // setupResult是object，将其reactive处理，赋给instance.setupState
    instance.setupState = reactive(setupResult)
    if (__DEV__) {
      exposeSetupStateOnRenderContext(instance)
    }
  } else if (__DEV__ && setupResult !== undefined) {
    warn(
      `setup() should return an object. Received: ${
        setupResult === null ? 'null' : typeof setupResult
      }`
    )
  }
  // 这里才知道是否传入了render，然后决定是否编译模板生成render函数
  // 包括模板编译生成render函数(如果setup没有返回render函数的话)，放在instance.render上
  // 如果要使用Vue2.x Options API，这个会做兼容处理
  finishComponentSetup(instance, isSSR)
}

type CompileFunction = (
  template: string | object,
  options?: CompilerOptions
) => InternalRenderFunction

let compile: CompileFunction | undefined

/**
 * For runtime-dom to register the compiler.
 * Note the exported method uses any to avoid d.ts relying on the compiler types.
 */
// 执行_compile这个函数就会走编译逻辑，返回render函数
export function registerRuntimeCompiler(_compile: any) {
  compile = _compile
}

// 这里才知道是否传入了render，然后决定是否编译模板生成render函数
// 模板编译生成render函数(如果setup没有返回render函数的话)，放在instance.render上
// 如果要使用Vue2.x Options API，这个会做兼容处理
function finishComponentSetup(
  instance: ComponentInternalInstance,
  isSSR: boolean
) {
  // 组件选项
  const Component = instance.type as ComponentOptions

  // template / render function normalization
  if (__NODE_JS__ && isSSR) { // SSR在服务端执行renderToString
    if (Component.render) {
      instance.render = Component.render as InternalRenderFunction
    }
  } else if (!instance.render) { // 没有直接提供render函数，通过template走compile编译出render函数
    if (compile && Component.template && !Component.render) {
      if (__DEV__) {
        startMeasure(instance, `compile`)
      }
      // 模板编译，生成render函数放在instance.type.render上
      Component.render = compile(Component.template, {
        isCustomElement: instance.appContext.config.isCustomElement || NO
      })
      if (__DEV__) {
        endMeasure(instance, `compile`)
      }
      // mark the function as runtime compiled
      // 标记组件的render函数是已经完成模板编译了
      ;(Component.render as InternalRenderFunction)._rc = true
    }

    if (__DEV__ && !Component.render) {
      /* istanbul ignore if */
      if (!compile && Component.template) {
        warn(
          `Component provided template option but ` +
            `runtime compilation is not supported in this build of Vue.` +
            (__ESM_BUNDLER__
              ? ` Configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js".`
              : __ESM_BROWSER__
                ? ` Use "vue.esm-browser.js" instead.`
                : __GLOBAL__
                  ? ` Use "vue.global.js" instead.`
                  : ``) /* should not happen */
        )
      } else {
        warn(`Component is missing template or render function.`)
      }
    }

    // 将模板编译成的render函数再放到instance.render上
    instance.render = (Component.render || NOOP) as InternalRenderFunction

    // for runtime-compiled render functions using `with` blocks, the render
    // proxy used needs a different `has` handler which is more performant and
    // also only allows a whitelist of globals to fallthrough.
    // _rc => runtime compile
    // 完成模板编译后，_rc为true，intance.withProxy指向instance.ctx的代理
    // intance.withProxy.xxx 代理到 intance.ctx._.xxx
    // RuntimeCompiledPublicInstanceProxyHandlers相对于PublicInstanceProxyHandlers，扩充了get的一个判断，改写了has
    // 也就是instance.withProxy相对于instance.proxy，扩充了get的一个判断，改写了has
    // 这里的时机是在模板编译完成，生成render函数之后，紧接着做代理
    // 后续的render函数，会将上下文context替换为 instance.withProxy || instance.proxy，也就是说这里的代理会在render过程中生效
    if (instance.render._rc) {
      instance.withProxy = new Proxy(
        instance.ctx,
        RuntimeCompiledPublicInstanceProxyHandlers
      )
    }
  }

  // 到这里完成了模板编译，并且instance.render指向了新生成的render函数

  // support for 2.x options  Options API
  // 兼容Vue2.x语法
  if (__FEATURE_OPTIONS__) {
    currentInstance = instance
    applyOptions(instance, Component)
    currentInstance = null
  }
}

const attrHandlers: ProxyHandler<Data> = {
  get: (target, key: string) => {
    if (__DEV__) {
      markAttrsAccessed()
    }
    return target[key]
  },
  set: () => {
    warn(`setupContext.attrs is readonly.`)
    return false
  },
  deleteProperty: () => {
    warn(`setupContext.attrs is readonly.`)
    return false
  }
}

// { attrs: instance.attrs, slots: instance.slots, emit: instance.emit }
function createSetupContext(instance: ComponentInternalInstance): SetupContext {
  if (__DEV__) {
    // We use getters in dev in case libs like test-utils overwrite instance
    // properties (overwrites should not be done in prod)
    return Object.freeze({
      get attrs() {
        return new Proxy(instance.attrs, attrHandlers)
      },
      get slots() {
        return shallowReadonly(instance.slots)
      },
      get emit() {
        return (event: string, ...args: any[]) => instance.emit(event, ...args)
      }
    })
  } else {
    return {
      attrs: instance.attrs,
      slots: instance.slots,
      emit: instance.emit
    }
  }
}

// record effects created during a component's setup() so that they can be
// stopped when the component unmounts
export function recordInstanceBoundEffect(effect: ReactiveEffect) {
  if (currentInstance) {
    ;(currentInstance.effects || (currentInstance.effects = [])).push(effect)
  }
}

const classifyRE = /(?:^|[-_])(\w)/g
const classify = (str: string): string =>
  str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '')

export function formatComponentName(
  Component: Component,
  isRoot = false
): string {
  let name = isFunction(Component)
    ? Component.displayName || Component.name
    : Component.name
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.vue$/)
    if (match) {
      name = match[1]
    }
  }
  return name ? classify(name) : isRoot ? `App` : `Anonymous`
}
