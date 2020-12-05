import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  Component
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'

export type ComponentPropsOptions<P = Data> =
  | ComponentObjectPropsOptions<P>
  | string[]

export type ComponentObjectPropsOptions<P = Data> = {
  [K in keyof P]: Prop<P[K]> | null
}

export type Prop<T> = PropOptions<T> | PropType<T>

type DefaultFactory<T> = () => T | null | undefined

interface PropOptions<T = any> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: T | DefaultFactory<T> | null | undefined
  validator?(value: unknown): boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new (...args: any[]): T & object }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = T extends (...args: any) => any // if is function with args
  ? { new (): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T, MakeDefaultRequired> = {
  [K in keyof T]: T[K] extends
    | { required: true }
    | (MakeDefaultRequired extends true ? { default: any } : never)
    ? K
    : never
}[keyof T]

type OptionalKeys<T, MakeDefaultRequired> = Exclude<
  keyof T,
  RequiredKeys<T, MakeDefaultRequired>
>

type InferPropType<T> = T extends null
  ? any // null & true would fail to infer
  : T extends { type: null | true }
    ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
    : T extends ObjectConstructor | { type: ObjectConstructor }
      ? { [key: string]: any }
      : T extends BooleanConstructor | { type: BooleanConstructor }
        ? boolean
        : T extends Prop<infer V> ? V : T

export type ExtractPropTypes<
  O,
  MakeDefaultRequired extends boolean = true
> = O extends object
  ? { [K in RequiredKeys<O, MakeDefaultRequired>]: InferPropType<O[K]> } &
      { [K in OptionalKeys<O, MakeDefaultRequired>]?: InferPropType<O[K]> }
  : { [K in string]: any }

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

type NormalizedProp =
  | null
  | (PropOptions & {
      [BooleanFlags.shouldCast]?: boolean
      [BooleanFlags.shouldCastTrue]?: boolean
    })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedPropsOptions = [Record<string, NormalizedProp>, string[]]

// 初始化instance上的props，将处理后的大部分存放在props中，小部分存放到attrs中
// instance.vnode.props(setup的返回props)和instance.type.props(传入的props)都进行了处理
// 客户端渲染在这里会对props进行浅层proxy响应式，服务端渲染则不会
export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null, // instance.vnode.props
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {
  const props: Data = {}
  const attrs: Data = {}
  // attrs.__vinternal = 1
  def(attrs, InternalObjectKey, 1)
  // 处理instance.vnode.props和instance.type.props，结果更新到props和attrs数组中
  setFullProps(instance, rawProps, props, attrs)
  // validation
  if (__DEV__) {
    validateProps(props, instance.type)
  }

  if (isStateful) {
    // stateful // 状态组件，vue文件
    // 客户端渲染给props做浅层proxy
    // 服务端渲染不做处理
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    // 函数组件，无状态组件
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      // 函数组件没有传入props选项，那instance.props = attrs
      instance.props = attrs
    } else {
      // functional w/ declared props
      // 函数组件传入props选项，那instance.props = 处理过的props
      instance.props = props
    }
  }
  instance.attrs = attrs
}

// 更新自身的动态props，为啥这里要更新自身的动态props，不是处理父组件传递下来的props吗???
// 根据prop的限制option更新父组件传递下来的props，如果是attrs上的属性，就直接更新到attrs上，保持函数组件的attrs和props一致
// 最后触发依赖这个组件$attrs的带slot的子组件的异步更新
export function updateProps(
  instance: ComponentInternalInstance, // 组件实例
  rawProps: Data | null, // instance.vnode.props 这里是nextVNode.props
  rawPrevProps: Data | null, // instance.vnode.props 这里是preVnode.props
  optimized: boolean // 是否经过模板编译
) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance
  // props是组件上的props，也就是父组件传递下来的props
  const rawCurrentProps = toRaw(props)
  // options是key-option，prop的key-key对应的限制option(包括type default等)
  const [options] = normalizePropsOptions(instance.type)

  if ((optimized || patchFlag > 0) && !(patchFlag & PatchFlags.FULL_PROPS)) {
    // 模板编译的快速diff通道，只需要更新动态props
    // 这里更新的是组件自身的props，而不是父组件传递下来的props???

    if (patchFlag & PatchFlags.PROPS) { // 1 << 3
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      // 需要更新的动态props，在模板编译过程中提取出来的
      // 这里是nextVNode.dynamicProps
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        const key = propsToUpdate[i]
        // PROPS flag guarantees rawProps to be non-null
        const value = rawProps![key]
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          // attrs和props在initProps时就被分离出来了
          if (hasOwn(attrs, key)) {
            attrs[key] = value
          } else {
            const camelizedKey = camelize(key)
            // 根据prop的限制选项type和default决定最终的prop的值并返回
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value
            )
          }
        } else {
          attrs[key] = value
        }
      }
    }
  } else {
    // full props update.
    // 没有快读diff通道，diff整个props

    // 处理instance.vnode.props和instance.type.props，结果更新到props和attrs数组中
    setFullProps(instance, rawProps, props, attrs)
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    let kebabKey: string
    for (const key in rawCurrentProps) {
      if (
        !rawProps ||
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        // 没有rawProps或者rawProps中没有key，也就是说这个key是父组件传递下来的prop
        // 有prop限制选项，才解析父组件传递下来的prop，否则就删除
        // rawProps是组件自身的props
        if (options) {
          if (rawPrevProps && rawPrevProps[kebabKey!] !== undefined) {
            props[key] = resolvePropValue(
              options,
              rawProps || EMPTY_OBJ,
              key,
              undefined
            )
          }
        } else {
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    // 函数组件，attrs和props相同，所以这里如果不同，就要对attrs做删除，保持attrs和props相同
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key)) {
          delete attrs[key]
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  // $attrs指向的是父组件中给插槽添加的属性，这里更新完props需要触发依赖这个$attrs的组件(也就是插槽组件)进行异步更新
  trigger(instance, TriggerOpTypes.SET, '$attrs')

  if (__DEV__ && rawProps) {
    validateProps(props, instance.type)
  }
}

// 处理instance.vnode.props和instance.type.props，结果更新到props和attrs数组中
function setFullProps(
  instance: ComponentInternalInstance, // 组件实例
  rawProps: Data | null, // instance.vnode.props，这个props是在setup中返回的???
  props: Data, // []
  attrs: Data // []
) {
  // 格式化处理instance.type.props选项成统一格式 支持array function object
  // 处理过的[normalized, needCastKeys]赋给comp.__props并返回
  // 这个props是直接在export default中定义的props???
  // options是key-option，prop的key-key对应的限制option(包括type default等)
  const [options, needCastKeys] = normalizePropsOptions(instance.type)
  const emits = instance.type.emits

  if (rawProps) {
    // 遍历instance.vnode.props
    for (const key in rawProps) {
      const value = rawProps[key]
      // key, ref are reserved and never passed down
      // 跳过保留prop  key ref 生命周期
      if (isReservedProp(key)) {
        continue
      }
      // prop option names are camelized during normalization, so to support
      // kebab -> camel conversion here we need to camelize the key.
      let camelKey
      // key在options里面，就添加到props中
      // 在instance.vnode.props和instance.type.props中重复定义，不是会报错吗???
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        props[camelKey] = value
      } else if (!emits || !isEmitListener(emits, key)) {
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        // 没有定义过的key，放在attrs中
        attrs[key] = value
      }
    }
  }

  if (needCastKeys) {
    // 取原始props，也就是没有响应式的版本
    const rawCurrentProps = toRaw(props)
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      // 根据prop的限制选项type和default决定最终的prop的值并返回
      props[key] = resolvePropValue(
        options!,
        rawCurrentProps,
        key,
        rawCurrentProps[key]
      )
    }
  }
}

// 根据prop的限制选项type和default决定最终的prop的值并返回
function resolvePropValue(
  options: NormalizedPropsOptions[0], // options是key-option，prop的key-key对应的限制option(包括type default等)
  props: Data, // toRaw(props)
  key: string, // needCastKeys[i]
  value: unknown // toRaw(props)[key]
) {
  // key的限制选项
  const opt = options[key] as any
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // default values
    if (hasDefault && value === undefined) {
      const defaultValue = opt.default
      value =
        opt.type !== Function && isFunction(defaultValue)
          ? defaultValue()
          : defaultValue
    }
    // boolean casting
    if (opt[BooleanFlags.shouldCast]) {
      if (!hasOwn(props, key) && !hasDefault) {
        value = false
      } else if (
        opt[BooleanFlags.shouldCastTrue] &&
        (value === '' || value === hyphenate(key))
      ) {
        value = true
      }
    }
  }
  return value
}

// 格式化处理props选项成统一格式 支持array function object
// 处理过的[normalized, needCastKeys]赋给comp.__props并返回
export function normalizePropsOptions(
  comp: Component // instance.type 组件选项
): NormalizedPropsOptions | [] {
  // 已经格式化过了props，直接返回
  if (comp.__props) {
    return comp.__props
  }

  const raw = comp.props
  const normalized: NormalizedPropsOptions[0] = {}
  const needCastKeys: NormalizedPropsOptions[1] = []

  // apply mixin/extends props
  let hasExtends = false
  // 函数组件，无状态组件
  // 将extends和mixins中的props和keys统一处理至normalized和needCastKeys中
  if (__FEATURE_OPTIONS__ && !isFunction(comp)) {
    const extendProps = (raw: ComponentOptions) => {
      const [props, keys] = normalizePropsOptions(raw)
      extend(normalized, props)
      if (keys) needCastKeys.push(...keys)
    }
    if (comp.extends) {
      hasExtends = true
      extendProps(comp.extends)
    }
    if (comp.mixins) {
      hasExtends = true
      comp.mixins.forEach(extendProps)
    }
  }

  // hasExtends还是为false，那处理后的props为[]，添加到comp.__props后直接return
  if (!raw && !hasExtends) {
    return (comp.__props = EMPTY_ARR)
  }

  if (isArray(raw)) {
    // comp.props是数组，在normalized中定义对应的key，value暂时为EMPTY_OBJ
    for (let i = 0; i < raw.length; i++) {
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      // -连接转驼峰
      const normalizedKey = camelize(raw[i])
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  } else if (raw) {
    // com.props是对象
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      // -连接转驼峰
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        // 单个prop的option选项
        const opt = raw[key]
        // 格式化prop，单个prop的选项可以是string function object
        // 处理后的prop的type指向限制类型
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : opt)
        if (prop) {
          // 找到type对应的index，没有就返回-1
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          const stringIndex = getTypeIndex(String, prop.type)
          // 是否有Boolean
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          // 没有string或boolean早于string
          prop[BooleanFlags.shouldCastTrue] =
            stringIndex < 0 || booleanIndex < stringIndex
          // if the prop needs boolean casting or default value
          // 支持boolean或有default，就在needCastKeys推入normalizedKey
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }
  // 处理过的[normalized, needCastKeys]赋给comp.__props并返回
  const normalizedEntry: NormalizedPropsOptions = [normalized, needCastKeys]
  comp.__props = normalizedEntry
  return normalizedEntry
}

// use function string name to check type constructors
// so that it works across vms / iframes.
function getType(ctor: Prop<any>): string {
  const match = ctor && ctor.toString().match(/^\s*function (\w+)/)
  return match ? match[1] : ''
}

function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

// 找到type对应的index，没有就返回-1
function getTypeIndex(
  type: Prop<any>, // Boolean String
  expectedTypes: PropType<any> | void | null | true // prop.type 限制类型，一般为string或数组
): number {
  if (isArray(expectedTypes)) { // 数组
    for (let i = 0, len = expectedTypes.length; i < len; i++) {
      if (isSameType(expectedTypes[i], type)) {
        return i
      }
    }
  } else if (isFunction(expectedTypes)) { // function
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  // 没有则返回-1
  return -1
}

/**
 * dev only
 */
function validateProps(props: Data, comp: Component) {
  const rawValues = toRaw(props)
  const options = normalizePropsOptions(comp)[0]
  for (const key in options) {
    let opt = options[key]
    if (opt == null) continue
    validateProp(key, rawValues[key], opt, !hasOwn(rawValues, key))
  }
}

/**
 * dev only
 */
function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

/**
 * dev only
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean
) {
  const { type, required, validator } = prop
  // required!
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // missing but optional
  if (value == null && !prop.required) {
    return
  }
  // type check
  if (type != null && type !== true) {
    let isValid = false
    const types = isArray(type) ? type : [type]
    const expectedTypes = []
    // value is valid as long as one of the specified types match
    for (let i = 0; i < types.length && !isValid; i++) {
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }
  // custom validator
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol'
)

type AssertionResult = {
  valid: boolean
  expectedType: string
}

/**
 * dev only
 */
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  const expectedType = getType(type)
  if (isSimpleType(expectedType)) {
    const t = typeof value
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
  } else if (expectedType === 'Object') {
    valid = toRawType(value) === 'Object'
  } else if (expectedType === 'Array') {
    valid = isArray(value)
  } else {
    valid = value instanceof type
  }
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(', ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
