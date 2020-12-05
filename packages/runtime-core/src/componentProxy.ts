import { ComponentInternalInstance, Data } from './component'
import { nextTick, queueJob } from './scheduler'
import { instanceWatch } from './apiWatch'
import {
  EMPTY_OBJ,
  hasOwn,
  isGloballyWhitelisted,
  NOOP,
  extend
} from '@vue/shared'
import {
  ReactiveEffect,
  UnwrapRef,
  toRaw,
  shallowReadonly,
  ReactiveFlags,
  track,
  TrackOpTypes
} from '@vue/reactivity'
import {
  ExtractComputedReturns,
  ComponentOptionsBase,
  ComputedOptions,
  MethodOptions,
  ComponentOptionsMixin,
  OptionTypesType,
  OptionTypesKeys,
  resolveMergedOptions
} from './componentOptions'
import { normalizePropsOptions } from './componentProps'
import { EmitsOptions, EmitFn } from './componentEmits'
import { Slots } from './componentSlots'
import {
  currentRenderingInstance,
  markAttrsAccessed
} from './componentRenderUtils'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'

/**
 * Custom properties added to component instances in any way and can be accessed through `this`
 *
 * @example
 * Here is an example of adding a property `$router` to every component instance:
 * ```ts
 * import { createApp } from 'vue'
 * import { Router, createRouter } from 'vue-router'
 *
 * declare module '@vue/runtime-core' {
 *   interface ComponentCustomProperties {
 *     $router: Router
 *   }
 * }
 *
 * // effectively adding the router to every component instance
 * const app = createApp({})
 * const router = createRouter()
 * app.config.globalProperties.$router = router
 *
 * const vm = app.mount('#app')
 * // we can access the router from the instance
 * vm.$router.push('/')
 * ```
 */
export interface ComponentCustomProperties {}

type IsDefaultMixinComponent<T> = T extends ComponentOptionsMixin
  ? ComponentOptionsMixin extends T ? true : false
  : false

type MixinToOptionTypes<T> = T extends ComponentOptionsBase<
  infer P,
  infer B,
  infer D,
  infer C,
  infer M,
  infer Mixin,
  infer Extends,
  any
>
  ? OptionTypesType<P & {}, B & {}, D & {}, C & {}, M & {}> &
      IntersectionMixin<Mixin> &
      IntersectionMixin<Extends>
  : never

// ExtractMixin(map type) is used to resolve circularly references
type ExtractMixin<T> = {
  Mixin: MixinToOptionTypes<T>
}[T extends ComponentOptionsMixin ? 'Mixin' : never]

type IntersectionMixin<T> = IsDefaultMixinComponent<T> extends true
  ? OptionTypesType<{}, {}, {}, {}, {}>
  : UnionToIntersection<ExtractMixin<T>>

type UnwrapMixinsType<
  T,
  Type extends OptionTypesKeys
> = T extends OptionTypesType ? T[Type] : never

type EnsureNonVoid<T> = T extends void ? {} : T

export type CreateComponentPublicInstance<
  P = {},
  B = {},
  D = {},
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  Mixin extends ComponentOptionsMixin = ComponentOptionsMixin,
  Extends extends ComponentOptionsMixin = ComponentOptionsMixin,
  E extends EmitsOptions = {},
  PublicProps = P,
  PublicMixin = IntersectionMixin<Mixin> & IntersectionMixin<Extends>,
  PublicP = UnwrapMixinsType<PublicMixin, 'P'> & EnsureNonVoid<P>,
  PublicB = UnwrapMixinsType<PublicMixin, 'B'> & EnsureNonVoid<B>,
  PublicD = UnwrapMixinsType<PublicMixin, 'D'> & EnsureNonVoid<D>,
  PublicC extends ComputedOptions = UnwrapMixinsType<PublicMixin, 'C'> &
    EnsureNonVoid<C>,
  PublicM extends MethodOptions = UnwrapMixinsType<PublicMixin, 'M'> &
    EnsureNonVoid<M>
> = ComponentPublicInstance<
  PublicP,
  PublicB,
  PublicD,
  PublicC,
  PublicM,
  E,
  PublicProps,
  ComponentOptionsBase<P, B, D, C, M, Mixin, Extends, E>
>
// public properties exposed on the proxy, which is used as the render context
// in templates (as `this` in the render option)
export type ComponentPublicInstance<
  P = {}, // props type extracted from props option
  B = {}, // raw bindings returned from setup()
  D = {}, // return from data()
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  E extends EmitsOptions = {},
  PublicProps = P,
  Options = ComponentOptionsBase<any, any, any, any, any, any, any, any>
> = {
  $: ComponentInternalInstance
  $data: D
  $props: P & PublicProps
  $attrs: Data
  $refs: Data
  $slots: Slots
  $root: ComponentPublicInstance | null
  $parent: ComponentPublicInstance | null
  $emit: EmitFn<E>
  $el: any
  $options: Options
  $forceUpdate: ReactiveEffect
  $nextTick: typeof nextTick
  $watch: typeof instanceWatch
} & P &
  UnwrapRef<B> &
  D &
  ExtractComputedReturns<C> &
  M &
  ComponentCustomProperties

export type ComponentPublicInstanceConstructor<
  T extends ComponentPublicInstance
> = {
  new (): T
}

const publicPropertiesMap: Record<
  string,
  (i: ComponentInternalInstance) => any
> = {
  $: i => i,
  $el: i => i.vnode.el,
  $data: i => i.data,
  $props: i => (__DEV__ ? shallowReadonly(i.props) : i.props),
  $attrs: i => (__DEV__ ? shallowReadonly(i.attrs) : i.attrs),
  $slots: i => (__DEV__ ? shallowReadonly(i.slots) : i.slots),
  $refs: i => (__DEV__ ? shallowReadonly(i.refs) : i.refs),
  $parent: i => i.parent && i.parent.proxy,
  $root: i => i.root && i.root.proxy,
  $emit: i => i.emit,
  $options: i => (__FEATURE_OPTIONS__ ? resolveMergedOptions(i) : i.type),
  $forceUpdate: i => () => queueJob(i.update), // i.update是组件对应的render effect
  $nextTick: () => nextTick,
  $watch: __FEATURE_OPTIONS__ ? i => instanceWatch.bind(i) : NOOP // 这里只支持Options API
}

const enum AccessTypes {
  SETUP,
  DATA,
  PROPS,
  CONTEXT,
  OTHER
}

export interface ComponentRenderContext {
  [key: string]: any
  _: ComponentInternalInstance
}

export const PublicInstanceProxyHandlers: ProxyHandler<any> = {
  // 取值
  // 对非保留属性，会存储到accessCache上进行缓存，性能优化
  // 其他以$开头的属性，大部分都是直接取，有个别有特殊处理
  get({ _: instance }: ComponentRenderContext, key: string) {
    const {
      ctx,
      setupState, // setup()的返回值
      data,
      props,
      accessCache,
      type,
      appContext
    } = instance

    // let @vue/reatvitiy know it should never observe Vue public instances.
    if (key === ReactiveFlags.skip) {
      return true
    }

    // data / props / ctx
    // This getter gets called for every property access on the render context
    // during render and is a major hotspot. The most expensive part of this
    // is the multiple hasOwn() calls. It's much faster to do a simple property
    // access on a plain object, so we use an accessCache object (with null
    // prototype) to memoize what access type a key corresponds to.
    // 多个hasOwn会很耗性能，所以这里用accessCache对象存储所有数据的key和AccessTypes
    // 这样只要一次取过一次，就有缓存，下次就可以直接取，性能优化

    // 非保留key
    // 第一次会遍历各个数据源找到对应值，然后存放在accessCache中key-AccessTypes
    // 之后每次取值都直接从accessCache中取缓存
    if (key[0] !== '$') {
      const n = accessCache![key]
      // 如果accessCache中有缓存，直接取
      // 如果accessCache中没有缓存，先做缓存，再返回对应源中的值，每个数据的第一遍都会走这里，下一次就直接取缓存了
      if (n !== undefined) {
        // accessCache中有缓存，直接根据对应的AccessTypes去对应的数据源中获取值
        switch (n) {
          case AccessTypes.SETUP:
            return setupState[key]
          case AccessTypes.DATA:
            return data[key]
          case AccessTypes.CONTEXT:
            return ctx[key]
          case AccessTypes.PROPS:
            return props![key]
          // default: just fallthrough // 没有其他情况
        }
      } else if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) { // setupState
        accessCache![key] = AccessTypes.SETUP
        return setupState[key]
      } else if (data !== EMPTY_OBJ && hasOwn(data, key)) { // data
        accessCache![key] = AccessTypes.DATA
        return data[key]
      } else if (
        // only cache other properties when instance has declared (thus stable)
        // props
        type.props &&
        hasOwn(normalizePropsOptions(type)[0]!, key)
      ) { // 父组件传入的props
        accessCache![key] = AccessTypes.PROPS
        return props![key]
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) { // ctx
        accessCache![key] = AccessTypes.CONTEXT
        return ctx[key]
      } else { // 其他
        accessCache![key] = AccessTypes.OTHER
      }
    }

    // key[0] === '$'，也就是以$开头的key、
    // 以$开头的保留key存放在instance上
    // 以$开头的自定义key存放在instance.ctx上

    // 保留key
    // $ $el $data $props $attrs $slots $refs $parent $root
    // $emit $options $forceUpdate $nextTick $watch
    const publicGetter = publicPropertiesMap[key]
    let cssModule, globalProperties
    // public $xxx properties
    if (publicGetter) { // publicPropertiesMap中的保留key
      // publicPropertiesMap中的保留key，也直接取
      // 对$attrs做track处理，因为$attrs指向的是父组件中给子组件的外壳节点添加的属性，不包括class和props
      // 子组件用到$attrs时会进行依赖收集
      if (key === '$attrs') {
        track(instance, TrackOpTypes.GET, key)
        __DEV__ && markAttrsAccessed()
      }
      return publicGetter(instance)
    } else if ( // type.__cssModules[key]，这个什么作用???
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) &&
      (cssModule = cssModule[key])
    ) {
      return cssModule
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) { // 用户传入的以$开头的自定义属性
      // user may set custom properties to `this` that start with `$`
      accessCache![key] = AccessTypes.CONTEXT
      return ctx[key]
    } else if (
      // global properties
      ((globalProperties = appContext.config.globalProperties),
      hasOwn(globalProperties, key))
    ) { // globalProperties 全局属性
      // app.config.globalProperties.foo = 'bar'
      // this.foo就可以取到全局属性foo
      return globalProperties[key]
    } else if (
      __DEV__ &&
      currentRenderingInstance &&
      // #1091 avoid internal isRef/isVNode checks on component instance leading
      // to infinite warning loop
      key.indexOf('__v') !== 0
    ) {
      if (data !== EMPTY_OBJ && key[0] === '$' && hasOwn(data, key)) {
        warn(
          `Property ${JSON.stringify(
            key
          )} must be accessed via $data because it starts with a reserved ` +
            `character and is not proxied on the render context.`
        )
      } else {
        warn(
          `Property ${JSON.stringify(key)} was accessed during render ` +
            `but is not defined on instance.`
        )
      }
    }
  },

  // 修改值
  // 判断是哪个源的，修改对应源的数据
  // props和以$开头的保留key不可修改
  // 全局属性也不做修改，而且添加一个新属性到intance.ctx上
  set(
    { _: instance }: ComponentRenderContext,
    key: string,
    value: any
  ): boolean {
    const { data, setupState, ctx } = instance
    if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) { // setupState
      setupState[key] = value
    } else if (data !== EMPTY_OBJ && hasOwn(data, key)) { // data
      data[key] = value
    } else if (key in instance.props) { // props，数据单向流，props不可修改
      __DEV__ &&
        warn(
          `Attempting to mutate prop "${key}". Props are readonly.`,
          instance
        )
      return false
    }
    if (key[0] === '$' && key.slice(1) in instance) { // 以$开头的保留key，不可修改，用户自定义的以$开头key存放在instance.ctx上
      __DEV__ &&
        warn(
          `Attempting to mutate public property "${key}". ` +
            `Properties starting with $ are reserved and readonly.`,
          instance
        )
      return false
    } else {
      if (__DEV__ && key in instance.appContext.config.globalProperties) { // 全局属性，修改的时候不动全局属性，而是在intance.ctx上创建一个新属性
        Object.defineProperty(ctx, key, {
          enumerable: true,
          configurable: true,
          value
        })
      } else { // 其他情况，直接更新在ctx上，用户自定义的以$开头的属性在这里处理
        ctx[key] = value
      }
    }
    return true
  },

  // 判断是否有这个属性
  // 依次判断数据源是否有
  // accessCache缓存 data setupState props ctx publicPropertiesMap(以$开头的保留key) appContext.config.globalProperties(全局属性)
  has(
    {
      _: { data, setupState, accessCache, ctx, type, appContext }
    }: ComponentRenderContext,
    key: string
  ) {
    return (
      accessCache![key] !== undefined ||
      (data !== EMPTY_OBJ && hasOwn(data, key)) ||
      (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) ||
      (type.props && hasOwn(normalizePropsOptions(type)[0]!, key)) ||
      hasOwn(ctx, key) ||
      hasOwn(publicPropertiesMap, key) ||
      hasOwn(appContext.config.globalProperties, key)
    )
  }
}

if (__DEV__ && !__TEST__) {
  PublicInstanceProxyHandlers.ownKeys = (target: ComponentRenderContext) => {
    warn(
      `Avoid app logic that relies on enumerating keys on a component instance. ` +
        `The keys will be empty in production mode to avoid performance overhead.`
    )
    return Reflect.ownKeys(target)
  }
}

// 相对于PublicInstanceProxyHandlers，扩充了get的一个判断，改写了has
export const RuntimeCompiledPublicInstanceProxyHandlers = extend(
  {},
  PublicInstanceProxyHandlers,
  {
    get(target: ComponentRenderContext, key: string) {
      // fast path for unscopables when using `with` block
      if ((key as any) === Symbol.unscopables) {
        return
      }
      return PublicInstanceProxyHandlers.get!(target, key, target)
    },
    // key不是以_开头，且key不是isGloballyWhitelisted全局白名单中的属性，就返回true
    has(_: ComponentRenderContext, key: string) {
      const has = key[0] !== '_' && !isGloballyWhitelisted(key)
      if (__DEV__ && !has && PublicInstanceProxyHandlers.has!(_, key)) {
        warn(
          `Property ${JSON.stringify(
            key
          )} should not start with _ which is a reserved prefix for Vue internals.`
        )
      }
      return has
    }
  }
)

// In dev mode, the proxy target exposes the same properties as seen on `this`
// for easier console inspection. In prod mode it will be an empty object so
// these properties definitions can be skipped.
export function createRenderContext(instance: ComponentInternalInstance) {
  const target: Record<string, any> = {}

  // expose internal instance for proxy handlers
  Object.defineProperty(target, `_`, {
    configurable: true,
    enumerable: false,
    get: () => instance
  })

  // expose public properties
  Object.keys(publicPropertiesMap).forEach(key => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get: () => publicPropertiesMap[key](instance),
      // intercepted by the proxy so no need for implementation,
      // but needed to prevent set errors
      set: NOOP
    })
  })

  // expose global properties
  const { globalProperties } = instance.appContext.config
  Object.keys(globalProperties).forEach(key => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get: () => globalProperties[key],
      set: NOOP
    })
  })

  return target as ComponentRenderContext
}

// dev only
export function exposePropsOnRenderContext(
  instance: ComponentInternalInstance
) {
  const { ctx, type } = instance
  const propsOptions = normalizePropsOptions(type)[0]
  if (propsOptions) {
    Object.keys(propsOptions).forEach(key => {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => instance.props[key],
        set: NOOP
      })
    })
  }
}

// dev only
export function exposeSetupStateOnRenderContext(
  instance: ComponentInternalInstance
) {
  const { ctx, setupState } = instance
  Object.keys(toRaw(setupState)).forEach(key => {
    Object.defineProperty(ctx, key, {
      enumerable: true,
      configurable: true,
      get: () => setupState[key],
      set: NOOP
    })
  })
}
