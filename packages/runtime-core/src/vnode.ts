import {
  isArray,
  isFunction,
  isString,
  isObject,
  EMPTY_ARR,
  extend,
  normalizeClass,
  normalizeStyle,
  PatchFlags,
  ShapeFlags
} from '@vue/shared'
import {
  ComponentInternalInstance,
  Data,
  Component,
  ClassComponent
} from './component'
import { RawSlots } from './componentSlots'
import { isProxy, Ref, toRaw } from '@vue/reactivity'
import { AppContext } from './apiCreateApp'
import {
  SuspenseImpl,
  isSuspense,
  SuspenseBoundary
} from './components/Suspense'
import { DirectiveBinding } from './directives'
import { TransitionHooks } from './components/BaseTransition'
import { warn } from './warning'
import { currentScopeId } from './helpers/scopeId'
import { TeleportImpl, isTeleport } from './components/Teleport'
import { currentRenderingInstance } from './componentRenderUtils'
import { RendererNode, RendererElement } from './renderer'
import { NULL_DYNAMIC_COMPONENT } from './helpers/resolveAssets'
import { hmrDirtyComponents } from './hmr'

export const Fragment = (Symbol(__DEV__ ? 'Fragment' : undefined) as any) as {
  __isFragment: true
  new (): {
    $props: VNodeProps
  }
}
export const Text = Symbol(__DEV__ ? 'Text' : undefined)
export const Comment = Symbol(__DEV__ ? 'Comment' : undefined)
export const Static = Symbol(__DEV__ ? 'Static' : undefined)

export type VNodeTypes =
  | string
  | Component
  | typeof Text
  | typeof Static
  | typeof Comment
  | typeof Fragment
  | typeof TeleportImpl
  | typeof SuspenseImpl

export type VNodeRef =
  | string
  | Ref
  | ((ref: object | null, refs: Record<string, any>) => void)

export type VNodeNormalizedRef = [ComponentInternalInstance, VNodeRef]

type VNodeMountHook = (vnode: VNode) => void
type VNodeUpdateHook = (vnode: VNode, oldVNode: VNode) => void
export type VNodeHook =
  | VNodeMountHook
  | VNodeUpdateHook
  | VNodeMountHook[]
  | VNodeUpdateHook[]

export interface VNodeProps {
  [key: string]: any
  key?: string | number
  ref?: VNodeRef

  // vnode hooks
  onVnodeBeforeMount?: VNodeMountHook | VNodeMountHook[]
  onVnodeMounted?: VNodeMountHook | VNodeMountHook[]
  onVnodeBeforeUpdate?: VNodeUpdateHook | VNodeUpdateHook[]
  onVnodeUpdated?: VNodeUpdateHook | VNodeUpdateHook[]
  onVnodeBeforeUnmount?: VNodeMountHook | VNodeMountHook[]
  onVnodeUnmounted?: VNodeMountHook | VNodeMountHook[]
}

type VNodeChildAtom =
  | VNode
  | string
  | number
  | boolean
  | null
  | undefined
  | void

export interface VNodeArrayChildren
  extends Array<VNodeArrayChildren | VNodeChildAtom> {}

export type VNodeChild = VNodeChildAtom | VNodeArrayChildren

export type VNodeNormalizedChildren =
  | string
  | VNodeArrayChildren
  | RawSlots
  | null

export interface VNode<HostNode = RendererNode, HostElement = RendererElement> {
  /**
   * @internal
   */
  __v_isVNode: true
  /**
   * @internal
   */
  __v_skip: true
  type: VNodeTypes
  props: VNodeProps | null
  key: string | number | null
  ref: VNodeNormalizedRef | null
  scopeId: string | null // SFC only
  children: VNodeNormalizedChildren
  component: ComponentInternalInstance | null
  suspense: SuspenseBoundary | null
  dirs: DirectiveBinding[] | null
  transition: TransitionHooks<HostElement> | null

  // DOM
  el: HostNode | null
  anchor: HostNode | null // fragment anchor
  target: HostElement | null // teleport target
  targetAnchor: HostNode | null // teleport target anchor
  staticCount: number // number of elements contained in a static vnode

  // optimization only
  shapeFlag: number
  patchFlag: number
  dynamicProps: string[] | null
  dynamicChildren: VNode[] | null

  // application root node only
  appContext: AppContext | null
}

// Since v-if and v-for are the two possible ways node structure can dynamically
// change, once we consider v-if branches and each v-for fragment a block, we
// can divide a template into nested blocks, and within each block the node
// structure would be stable. This allows us to skip most children diffing
// and only worry about the dynamic nodes (indicated by patch flags).
const blockStack: (VNode[] | null)[] = []
let currentBlock: VNode[] | null = null

/**
 * Open a block.
 * This must be called before `createBlock`. It cannot be part of `createBlock`
 * because the children of the block are evaluated before `createBlock` itself
 * is called. The generated code typically looks like this:
 *
 * ```js
 * function render() {
 *   return (openBlock(),createBlock('div', null, [...]))
 * }
 * ```
 * disableTracking is true when creating a v-for fragment block, since a v-for
 * fragment always diffs its children.
 *
 * @private
 */
// 开始一个block，推入blockStack栈中，此时currentBlock指向新的[]
// createBlock的执行时机是晚于内部children的createVnode，因为createVnode是createBlock的参数，参数会先执行
export function openBlock(disableTracking = false) {
  blockStack.push((currentBlock = disableTracking ? null : []))
}

// Whether we should be tracking dynamic child nodes inside a block.
// Only tracks when this value is > 0
// We are not using a simple boolean because this value may need to be
// incremented/decremented by nested usage of v-once (see below)
let shouldTrack = 1

/**
 * Block tracking sometimes needs to be disabled, for example during the
 * creation of a tree that needs to be cached by v-once. The compiler generates
 * code like this:
 *
 * ``` js
 * _cache[1] || (
 *   setBlockTracking(-1),
 *   _cache[1] = createVNode(...),
 *   setBlockTracking(1),
 *   _cache[1]
 * )
 * ```
 *
 * @private
 */
export function setBlockTracking(value: number) {
  shouldTrack += value
}

/**
 * Create a block root vnode. Takes the same exact arguments as `createVNode`.
 * A block root keeps track of dynamic nodes within the block in the
 * `dynamicChildren` array.
 *
 * @private
 */
// createBlock的执行时机是晚于内部children的createVnode，因为createVnode是createBlock的参数，参数会先执行
export function createBlock(
  type: VNodeTypes | ClassComponent,
  props?: { [key: string]: any } | null,
  children?: any,
  patchFlag?: number,
  dynamicProps?: string[]
): VNode {
  const vnode = createVNode(
    type,
    props,
    children,
    patchFlag,
    dynamicProps,
    true /* isBlock: prevent a block from tracking itself */
  )
  // save current block children on the block vnode
  // vnode.dynamicChildren存储了currentBlock
  // 此时内部的children都已经完成了createVnode，并且动态的vnode已经添加到currentBlock中了
  vnode.dynamicChildren = currentBlock || EMPTY_ARR
  // close block
  // 当前currentBlock完成收集，移除
  blockStack.pop()
  // currentBlock指向当前block的父block
  currentBlock = blockStack[blockStack.length - 1] || null
  // a block is always going to be patched, so track it as a child of its
  // parent block
  // 父block vnode的currentBlock(也就是dynamicChildren)中推入当前vnode block
  if (currentBlock) {
    currentBlock.push(vnode)
  }
  return vnode
}

export function isVNode(value: any): value is VNode {
  return value ? value.__v_isVNode === true : false
}

// type和key都相同，认为时sameVNode
// n1和n2都没有key，那就是都为undefined，也是相同key
export function isSameVNodeType(n1: VNode, n2: VNode): boolean {
  if (
    __DEV__ &&
    n2.shapeFlag & ShapeFlags.COMPONENT &&
    hmrDirtyComponents.has(n2.type as Component)
  ) {
    // HMR only: if the component has been hot-updated, force a reload.
    return false
  }
  return n1.type === n2.type && n1.key === n2.key
}

let vnodeArgsTransformer:
  | ((
      args: Parameters<typeof _createVNode>,
      instance: ComponentInternalInstance | null
    ) => Parameters<typeof _createVNode>)
  | undefined

/**
 * Internal API for registering an arguments transform for createVNode
 * used for creating stubs in the test-utils
 * It is *internal* but needs to be exposed for test-utils to pick up proper
 * typings
 */
export function transformVNodeArgs(transformer?: typeof vnodeArgsTransformer) {
  vnodeArgsTransformer = transformer
}

const createVNodeWithArgsTransform = (
  ...args: Parameters<typeof _createVNode>
): VNode => {
  return _createVNode(
    ...(vnodeArgsTransformer
      ? vnodeArgsTransformer(args, currentRenderingInstance)
      : args)
  )
}

export const InternalObjectKey = `__vInternal`

// 取VNodeProps中的key，没有就为null
// undefined == null
const normalizeKey = ({ key }: VNodeProps): VNode['key'] =>
  key != null ? key : null

// 取VNodeProps中的key，没有就为null
const normalizeRef = ({ ref }: VNodeProps): VNode['ref'] =>
  (ref != null
    ? isArray(ref)
      ? ref
      : [currentRenderingInstance!, ref]
    : null) as any

export const createVNode = (__DEV__
  ? createVNodeWithArgsTransform
  : _createVNode) as typeof _createVNode

// 创建vnode虚拟dom并返回
// 这里已经完成了组件类型二进制标志shapeFlag和children的处理
// 创建vnode的工厂函数
function _createVNode(
  type: VNodeTypes | ClassComponent | typeof NULL_DYNAMIC_COMPONENT, // 组件选项
  props: (Data & VNodeProps) | null = null,
  children: unknown = null,
  patchFlag: number = 0,
  dynamicProps: string[] | null = null,
  isBlockNode = false
): VNode {
  // type无效，设置为Comment，在dev模式下报警
  if (!type || type === NULL_DYNAMIC_COMPONENT) {
    if (__DEV__ && !type) {
      warn(`Invalid vnode type when creating vnode: ${type}.`)
    }
    type = Comment
  }

  // class component normalization.
  if (isFunction(type) && '__vccOpts' in type) {
    type = type.__vccOpts
  }

  // class & style normalization.
  // 格式化class和style
  if (props) {
    // for reactive or proxy objects, we need to clone it to enable mutation.
    // 克隆一份props用于修改
    if (isProxy(props) || InternalObjectKey in props) {
      props = extend({}, props)
    }
    let { class: klass, style } = props
    // 格式化class，由空格分开的string格式
    if (klass && !isString(klass)) {
      props.class = normalizeClass(klass)
    }
    if (isObject(style)) {
      // reactive state objects need to be cloned since they are likely to be
      // mutated
      // 克隆一份style用于修改
      if (isProxy(style) && !isArray(style)) {
        style = extend({}, style)
      }
      // 格式化style，object格式
      props.style = normalizeStyle(style)
    }
  }

  // encode the vnode type information into a bitmap
  // 组件类型二进制标志
  const shapeFlag = isString(type)
    ? ShapeFlags.ELEMENT // 1 原生标签 0b00000001
    : __FEATURE_SUSPENSE__ && isSuspense(type)
      ? ShapeFlags.SUSPENSE // 1 << 7 suspense组件 0b10000000
      : isTeleport(type)
        ? ShapeFlags.TELEPORT // 1 << 6 teleport组件(自由控制自己的父dom容器是哪个) 0b01000000
        : isObject(type)
          ? ShapeFlags.STATEFUL_COMPONENT // 1 << 2 组件选项，状态组件，常规的vue文件 0b00000100
          : isFunction(type)
            ? ShapeFlags.FUNCTIONAL_COMPONENT // 1 << 1 函数组件，无状态组件 0b00000010
            : 0 // 啥也不是 0b00000000

  // dev模式下已经reactive过的组件选项
  // type还原成之前非reactive的状态并报警
  if (__DEV__ && shapeFlag & ShapeFlags.STATEFUL_COMPONENT && isProxy(type)) {
    type = toRaw(type)
    warn(
      `Vue received a Component which was made a reactive object. This can ` +
        `lead to unnecessary performance overhead, and should be avoided by ` +
        `marking the component with \`markRaw\` or using \`shallowRef\` ` +
        `instead of \`ref\`.`,
      `\nComponent that was made reactive: `,
      type
    )
  }

  // 创建vnode虚拟dom
  const vnode: VNode = {
    __v_isVNode: true,
    __v_skip: true,
    type, // 组件选项
    props,
    key: props && normalizeKey(props), // 取props中的key，没有就为null
    ref: props && normalizeRef(props), // 取props中的key，没有就为null
    scopeId: currentScopeId,
    children: null,
    component: null,
    suspense: null,
    dirs: null,
    transition: null,
    el: null,
    anchor: null,
    target: null,
    targetAnchor: null,
    staticCount: 0,
    shapeFlag, // 组件类型二进制标志
    patchFlag,
    dynamicProps,
    dynamicChildren: null,
    appContext: null
  }

  // 根据shapeFlag和children得到type，并且进行位运算|，得到最终的shapeFlag
  // 这里主要是处理children和shapeFlag  vnode.children  vnode.shapeFlag
  // 这里完成之后，shapeFlag对应的8位二进制都有对应的情况了
  normalizeChildren(vnode, children)

  // presence of a patch flag indicates this node needs patching on updates.
  // component nodes also should always be patched, because even if the
  // component doesn't need to update, it needs to persist the instance on to
  // the next vnode so that it can be properly unmounted later.
  // 模板编译生成了patchFlag，说明是需要patch更新的
  // 组件node需要总是被patch，即使不需要更新，因为它需要保持instance到下一个vnode以用来unmount卸载

  // 建立Block Tree，把所有动态的children存放到最近一个父block对应的vnode.dynamicChildren上
  // createBlock的执行时机是晚于内部children的createVnode，因为createVnode是createBlock的参数，参数会先执行
  // createBlock会传入isBlockNode为true，这里的逻辑会跳过，直接返回vnode
  // 最后的Block Tree是这样的，父block vnode的currentBlock(也就是dynamicChildren)存放了所有动态子vnode以及所有子block vnode，都是跨层级存储
  // 一旦遇到下一个block vnode，接下里的存储都放到最新的block vnode上，父block vnode只存放新的block vnode
  // 有了dynamicChildren，在patch过程中就可以避免递归遍历，所有的动态vnode都是绑定到block vnode上，而且只patch动态的部分，性能大大提升
  // block => 根节点 v-if v-else-if v-else v-for(包括根fragment和每一项)
  if (
    shouldTrack > 0 &&
    !isBlockNode && // 当前vnode不是block，在block vnode执行自己的createBlock时会将自身vnode推入父currentBlock中
    currentBlock && // 指向最近一个父block vnode的currentBlock，最后存储到对应的vnode.dynamicChildren上
    // the EVENTS flag is only for hydration and if it is the only flag, the
    // vnode should not be considered dynamic due to handler caching.
    patchFlag !== PatchFlags.HYDRATE_EVENTS && // 1 << 5 如果hydrate不仅仅是处理events，那就是动态的，0b00100000
    (patchFlag > 0 ||
      shapeFlag & ShapeFlags.SUSPENSE || // 1 << 7 suspense组件
      shapeFlag & ShapeFlags.TELEPORT || // 1 << 6 teleport组件
      shapeFlag & ShapeFlags.STATEFUL_COMPONENT || // 1 << 2 有状态组件，常规vue文件
      shapeFlag & ShapeFlags.FUNCTIONAL_COMPONENT) // 1 << 1 函数组件，无状态组件
  ) {
    currentBlock.push(vnode)
  }

  return vnode
}

// 克隆一个vnode返回
export function cloneVNode<T, U>(
  vnode: VNode<T, U>,
  extraProps?: Data & VNodeProps
): VNode<T, U> {
  // 浅拷贝props，避免之后的修改导致同步更新
  const props = (extraProps
    ? vnode.props
      ? mergeProps(vnode.props, extraProps)
      : extend({}, extraProps)
    : vnode.props) as any
  // This is intentionally NOT using spread or extend to avoid the runtime
  // key enumeration cost.
  // 不使用spread或extend，避免runtime过程中key的枚举消耗，什么意思???
  return {
    __v_isVNode: true,
    __v_skip: true,
    type: vnode.type,
    props,
    key: props && normalizeKey(props),
    ref: props && normalizeRef(props),
    scopeId: vnode.scopeId,
    children: vnode.children,
    target: vnode.target,
    targetAnchor: vnode.targetAnchor,
    staticCount: vnode.staticCount,
    shapeFlag: vnode.shapeFlag,
    // if the vnode is cloned with extra props, we can no longer assume its
    // existing patch flag to be reliable and need to bail out of optimized mode.
    // however we don't want block nodes to de-opt their children, so if the
    // vnode is a block node, we only add the FULL_PROPS flag to it.
    patchFlag: extraProps
      ? vnode.dynamicChildren
        ? vnode.patchFlag | PatchFlags.FULL_PROPS
        : PatchFlags.BAIL
      : vnode.patchFlag,
    dynamicProps: vnode.dynamicProps,
    dynamicChildren: vnode.dynamicChildren,
    appContext: vnode.appContext,
    dirs: vnode.dirs,
    transition: vnode.transition,

    // These should technically only be non-null on mounted VNodes. However,
    // they *should* be copied for kept-alive vnodes. So we just always copy
    // them since them being non-null during a mount doesn't affect the logic as
    // they will simply be overwritten.
    component: vnode.component,
    suspense: vnode.suspense,
    el: vnode.el,
    anchor: vnode.anchor
  }
}

/**
 * @private
 */
export function createTextVNode(text: string = ' ', flag: number = 0): VNode {
  return createVNode(Text, null, text, flag)
}

/**
 * @private
 */
export function createStaticVNode(
  content: string,
  numberOfNodes: number
): VNode {
  // A static vnode can contain multiple stringified elements, and the number
  // of elements is necessary for hydration.
  const vnode = createVNode(Static, null, content)
  vnode.staticCount = numberOfNodes
  return vnode
}

/**
 * @private
 */
export function createCommentVNode(
  text: string = '',
  // when used as the v-else branch, the comment node must be created as a
  // block to ensure correct updates.
  asBlock: boolean = false
): VNode {
  return asBlock
    ? (openBlock(), createBlock(Comment, null, text))
    : createVNode(Comment, null, text)
}

// 格式化child，返回对应的vnode
// 这里的child不一定是vnode
// 经过模板编译(不传入render函数，通过template编译出render函数)的一定是vnode
// 直接传入render函数的还不是vnode
export function normalizeVNode(child: VNodeChild): VNode {
  if (child == null || typeof child === 'boolean') {
    // empty placeholder
    // 空的注释节点做占位
    return createVNode(Comment)
  } else if (isArray(child)) {
    // fragment
    // child为数组，就是fragment，创建fragment vnode
    return createVNode(Fragment, null, child)
  } else if (typeof child === 'object') {
    // already vnode, this should be the most common since compiled templates
    // always produce all-vnode children arrays
    // 已经是vnode了，一般是这种情况，因为模板编译总是生成全vnode的children数组
    // 没有mount过，直接返回child
    // mount过，返回child的克隆版本
    // 这里同cloneIfMounted
    return child.el === null ? child : cloneVNode(child)
  } else {
    // strings and numbers
    // 文本节点，创建文本vnode
    return createVNode(Text, null, String(child))
  }
}

// optimized normalization for template-compiled render fns
// 为模板编译过的render函数做优化统一处理???
// 没有mount过，child.el指向null，直接返回child
// mount过，就返回child的克隆版本
export function cloneIfMounted(child: VNode): VNode {
  return child.el === null ? child : cloneVNode(child)
}

// 根据组件类型二进制标志shapeFlag和children得到type，并且进行位运算|，得到最终的shapeFlag
// 这里主要是处理children和shapeFlag
// 这里完成之后，shapeFlag对应的8位二进制都有对应的情况了
export function normalizeChildren(vnode: VNode, children: unknown) {
  let type = 0
  // 组件类型二进制标志
  const { shapeFlag } = vnode
  if (children == null) {
    children = null
  } else if (isArray(children)) {
    // children是array

    type = ShapeFlags.ARRAY_CHILDREN // 1 << 4 children是数组 0b00010000
  } else if (typeof children === 'object') {
    // children是object

    // Normalize slot to plain children
    if (
      (shapeFlag & ShapeFlags.ELEMENT || shapeFlag & ShapeFlags.TELEPORT) &&
      (children as any).default
    ) {
      // shapeFlag为ShapeFlags.ELEMENT或ShapeFlags.TELEPORT
      // 原生标签 teleport组件
      // 取children.default()重新normalizeChildren
      // 这里的children.default是默认插槽，执行children.default()是什么意思???
      // <teleport to="#popup" :disabled="displayVideoInline">
      //   <video src="./my-movie.mp4">
      // </teleport>
      normalizeChildren(vnode, (children as any).default())
      return
    } else {
      // 其他情况
      // 把children当作slots插槽
      type = ShapeFlags.SLOTS_CHILDREN // 1 << 5 插槽children 0b00100000
      // 将children._ctx指向当前rendering的实例
      // children还没有处理过，就将children._ctx指向当前rendering的实例
      // children处理过，已经有_ctx，不做任何处理
      if (!(children as RawSlots)._ && !(InternalObjectKey in children!)) {
        // if slots are not normalized, attach context instance
        // (compiled / normalized slots already have context)
        // 将children._ctx指向当前rendering的实例
        ;(children as RawSlots)._ctx = currentRenderingInstance
      }
    }
  } else if (isFunction(children)) {
    // children是function

    // 处理children转为object
    children = { default: children, _ctx: currentRenderingInstance }
    type = ShapeFlags.SLOTS_CHILDREN // 1 << 5 插槽children 0b00100000
  } else {
    // children是string，即为文本
    // teleport组件，直接将children转为文本vnode，但是type却是array children 0b00010000
    // 其他情况，children依旧是文本string，type是文本children 0b00001000

    children = String(children)
    // force teleport children to array so it can be moved around
    if (shapeFlag & ShapeFlags.TELEPORT) {
      // teleport会对单文本children转为array

      type = ShapeFlags.ARRAY_CHILDREN // array children 0b00010000
      // children转为文本vnode
      children = [createTextVNode(children as string)]
    } else {
      // 其他情况

      type = ShapeFlags.TEXT_CHILDREN // 1 << 3 文本children 0b00001000
    }
  }
  vnode.children = children as VNodeNormalizedChildren
  vnode.shapeFlag |= type
}

const handlersRE = /^on|^vnode/

export function mergeProps(...args: (Data & VNodeProps)[]) {
  const ret: Data = {}
  extend(ret, args[0])
  for (let i = 1; i < args.length; i++) {
    const toMerge = args[i]
    for (const key in toMerge) {
      if (key === 'class') {
        if (ret.class !== toMerge.class) {
          ret.class = normalizeClass([ret.class, toMerge.class])
        }
      } else if (key === 'style') {
        ret.style = normalizeStyle([ret.style, toMerge.style])
      } else if (handlersRE.test(key)) {
        // on*, vnode*
        const existing = ret[key]
        const incoming = toMerge[key]
        if (existing !== incoming) {
          ret[key] = existing
            ? [].concat(existing as any, toMerge[key] as any)
            : incoming
        }
      } else {
        ret[key] = toMerge[key]
      }
    }
  }
  return ret
}
