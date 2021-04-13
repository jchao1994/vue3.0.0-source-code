import {
  Text,
  Fragment,
  Comment,
  cloneIfMounted,
  normalizeVNode,
  VNode,
  VNodeArrayChildren,
  createVNode,
  isSameVNodeType,
  Static,
  VNodeNormalizedRef,
  VNodeHook,
  isVNode
} from './vnode'
import {
  ComponentInternalInstance,
  createComponentInstance,
  Data,
  setupComponent,
  Component
} from './component'
import {
  renderComponentRoot,
  shouldUpdateComponent,
  updateHOCHostEl
} from './componentRenderUtils'
import {
  isString,
  EMPTY_OBJ,
  EMPTY_ARR,
  isReservedProp,
  isFunction,
  PatchFlags,
  ShapeFlags,
  NOOP,
  hasOwn,
  invokeArrayFns,
  isArray
} from '@vue/shared'
import {
  queueJob,
  queuePostFlushCb,
  flushPostFlushCbs,
  invalidateJob
} from './scheduler'
import { effect, stop, ReactiveEffectOptions, isRef } from '@vue/reactivity'
import { updateProps } from './componentProps'
import { updateSlots } from './componentSlots'
import { pushWarningContext, popWarningContext, warn } from './warning'
import { createAppAPI, CreateAppFunction } from './apiCreateApp'
import {
  SuspenseBoundary,
  queueEffectWithSuspense,
  SuspenseImpl
} from './components/Suspense'
import { TeleportImpl } from './components/Teleport'
import { isKeepAlive, KeepAliveContext } from './components/KeepAlive'
import { registerHMR, unregisterHMR, isHmrUpdating } from './hmr'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { createHydrationFunctions, RootHydrateFunction } from './hydration'
import { invokeDirectiveHook } from './directives'
import { startMeasure, endMeasure } from './profiling'
import { ComponentPublicInstance } from './componentProxy'

export interface Renderer<HostElement = any> {
  render: RootRenderFunction<HostElement>
  createApp: CreateAppFunction<HostElement>
}

export interface HydrationRenderer extends Renderer<Element> {
  hydrate: RootHydrateFunction
}

export type RootRenderFunction<HostElement = RendererElement> = (
  vnode: VNode | null,
  container: HostElement
) => void

export interface RendererOptions<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  patchProp(
    el: HostElement,
    key: string,
    prevValue: any,
    nextValue: any,
    isSVG?: boolean,
    prevChildren?: VNode<HostNode, HostElement>[],
    parentComponent?: ComponentInternalInstance | null,
    parentSuspense?: SuspenseBoundary | null,
    unmountChildren?: UnmountChildrenFn
  ): void
  insert(el: HostNode, parent: HostElement, anchor?: HostNode | null): void
  remove(el: HostNode): void
  createElement(
    type: string,
    isSVG?: boolean,
    isCustomizedBuiltIn?: string
  ): HostElement
  createText(text: string): HostNode
  createComment(text: string): HostNode
  setText(node: HostNode, text: string): void
  setElementText(node: HostElement, text: string): void
  parentNode(node: HostNode): HostElement | null
  nextSibling(node: HostNode): HostNode | null
  querySelector?(selector: string): HostElement | null
  setScopeId?(el: HostElement, id: string): void
  cloneNode?(node: HostNode): HostNode
  insertStaticContent?(
    content: string,
    parent: HostElement,
    anchor: HostNode | null,
    isSVG: boolean
  ): HostElement[]
}

// Renderer Node can technically be any object in the context of core renderer
// logic - they are never directly operated on and always passed to the node op
// functions provided via options, so the internal constraint is really just
// a generic object.
export interface RendererNode {
  [key: string]: any
}

export interface RendererElement extends RendererNode {}

// An object exposing the internals of a renderer, passed to tree-shakeable
// features so that they can be decoupled from this file. Keys are shortened
// to optimize bundle size.
export interface RendererInternals<
  HostNode = RendererNode,
  HostElement = RendererElement
> {
  p: PatchFn
  um: UnmountFn
  r: RemoveFn
  m: MoveFn
  mt: MountComponentFn
  mc: MountChildrenFn
  pc: PatchChildrenFn
  pbc: PatchBlockChildrenFn
  n: NextFn
  o: RendererOptions<HostNode, HostElement>
}

// These functions are created inside a closure and therefore their types cannot
// be directly exported. In order to avoid maintaining function signatures in
// two places, we declare them once here and use them inside the closure.
type PatchFn = (
  n1: VNode | null, // null means this is a mount
  n2: VNode,
  container: RendererElement,
  anchor?: RendererNode | null,
  parentComponent?: ComponentInternalInstance | null,
  parentSuspense?: SuspenseBoundary | null,
  isSVG?: boolean,
  optimized?: boolean
) => void

type MountChildrenFn = (
  children: VNodeArrayChildren,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean,
  start?: number
) => void

type PatchChildrenFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized?: boolean
) => void

type PatchBlockChildrenFn = (
  oldChildren: VNode[],
  newChildren: VNode[],
  fallbackContainer: RendererElement,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean
) => void

type MoveFn = (
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  type: MoveType,
  parentSuspense?: SuspenseBoundary | null
) => void

type NextFn = (vnode: VNode) => RendererNode | null

type UnmountFn = (
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean
) => void

type RemoveFn = (vnode: VNode) => void

type UnmountChildrenFn = (
  children: VNode[],
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  doRemove?: boolean,
  start?: number
) => void

export type MountComponentFn = (
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

type ProcessTextOrCommentFn = (
  n1: VNode | null,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null
) => void

export type SetupRenderEffectFn = (
  instance: ComponentInternalInstance,
  initialVNode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean
) => void

export const enum MoveType {
  ENTER, // 0
  LEAVE, // 1
  REORDER // 2
}

// effect选项，用来给render effect进行异步更新的
const prodEffectOptions = {
  // 将effect推入queue，并做去重，然后调用queueFlush执行异步更新
  scheduler: queueJob
}

function createDevEffectOptions(
  instance: ComponentInternalInstance
): ReactiveEffectOptions {
  return {
    scheduler: queueJob,
    onTrack: instance.rtc ? e => invokeArrayFns(instance.rtc!, e) : void 0,
    onTrigger: instance.rtg ? e => invokeArrayFns(instance.rtg!, e) : void 0
  }
}

export const queuePostRenderEffect = __FEATURE_SUSPENSE__
  ? queueEffectWithSuspense
  : queuePostFlushCb

// 清除老的ref，根据vnode和ref不同语法设置新的ref
// 这里支持string(兼容Vue2.x???) ref(用于单个dom和组件的绑定) function(一般用于v-for)
// Vue2.x好像只支持string
// React useRef只支持ref function(两者的function还有点不一样)
export const setRef = (
  rawRef: VNodeNormalizedRef, // 新的ref
  oldRawRef: VNodeNormalizedRef | null, // 老的ref
  parent: ComponentInternalInstance, // 父组件
  vnode: VNode | null // 新vnode
) => {
  // 根据vnode获取value
  // 状态组件(常规vue文件)，value为vnode.component.proxy，也就是取值的代理
  // 其他vnode，value为vnode.el
  let value: ComponentPublicInstance | RendererNode | null
  if (!vnode) {
    value = null
  } else {
    const { el, component, shapeFlag, type } = vnode
    if (shapeFlag & ShapeFlags.COMPONENT && (type as Component).inheritRef) {
      return
    }
    if (shapeFlag & ShapeFlags.STATEFUL_COMPONENT) { // 状态组件，也就是常规vue文件
      value = component!.proxy
    } else {
      value = el
    }
  }

  const [owner, ref] = rawRef
  if (__DEV__ && !owner) {
    warn(
      `Missing ref owner context. ref cannot be used on hoisted vnodes. ` +
        `A vnode with ref must be created inside the render function.`
    )
    return
  }
  const oldRef = oldRawRef && oldRawRef[1]
  const refs = owner.refs === EMPTY_OBJ ? (owner.refs = {}) : owner.refs
  const setupState = owner.setupState

  // unset old ref
  // 清除老的ref
  if (oldRef != null && oldRef !== ref) {
    if (isString(oldRef)) {
      refs[oldRef] = null
      if (hasOwn(setupState, oldRef)) {
        setupState[oldRef] = null
      }
    } else if (isRef(oldRef)) {
      oldRef.value = null
    }
  }

  // 设置新的ref，新老ref相同也会走下面的逻辑
  if (isString(ref)) { // string，那么 ref的key-value 存放在setupState上，这里只是兼容Vue2.x???
    refs[ref] = value
    if (hasOwn(setupState, ref)) {
      setupState[ref] = value
    }
  } else if (isRef(ref)) { // ref，那么就直接更新ref.value
    ref.value = value
  } else if (isFunction(ref)) { // function，那就会在mount或者update的时候触发这个ref函数，传入value(vnode.component.proxy 或 vnode.el)和refs
    // 多个组件绑定ref时可以使用function
    // <child-component :ref="(el) => child = el"></child-component>
    // <div v-for="(item, i) in list" :ref="el => { if (el) divs[i] = el }">
    callWithErrorHandling(ref, parent, ErrorCodes.FUNCTION_REF, [value, refs])
  } else if (__DEV__) {
    warn('Invalid template ref type:', value, `(${typeof value})`)
  }
}

/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 */
export function createRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>) {
  return baseCreateRenderer<HostNode, HostElement>(options)
}

// Separate API for creating hydration-enabled renderer.
// Hydration logic is only used when calling this function, making it
// tree-shakable.
export function createHydrationRenderer(
  options: RendererOptions<Node, Element>
) {
  return baseCreateRenderer(options, createHydrationFunctions)
}

// overload 1: no hydration
// 客户端渲染
function baseCreateRenderer<
  HostNode = RendererNode,
  HostElement = RendererElement
>(options: RendererOptions<HostNode, HostElement>): Renderer<HostElement>

// overload 2: with hydration
// 服务端渲染
function baseCreateRenderer(
  options: RendererOptions<Node, Element>,
  createHydrationFns: typeof createHydrationFunctions
): HydrationRenderer

// implementation
function baseCreateRenderer(
  options: RendererOptions,
  createHydrationFns?: typeof createHydrationFunctions
): any {
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    cloneNode: hostCloneNode,
    insertStaticContent: hostInsertStaticContent
  } = options

  // Note: functions inside this closure should use `const xxx = () => {}`
  // style in order to prevent being inlined by minifiers.
  const patch: PatchFn = (
    n1, // old vnode
    n2, // new vnode
    container, // 挂载容器
    anchor = null,
    parentComponent = null,
    parentSuspense = null,
    isSVG = false,
    optimized = false // Vue2.x中的optimized是在模板编译过程中对静态节点进行static优化标记，用以在patch过程中跳过，性能优化，Vue3.x也是这样吗???
  ) => {
    // patching & not same type, unmount old tree
    // 存在老vnode且新老不相同，卸载老的vnode，将n1置为null，相当于之后的patch过程中老vnode总是为null
    // type和key都相同，认为时sameVNode
    if (n1 && !isSameVNodeType(n1, n2)) {
      // 取下一个兄弟dom，用于insertBefore的插入位置
      // parent.insertBefore(child, anchor)
      anchor = getNextHostNode(n1)
      // 卸载老的vnode
      // 生命周期执行顺序onBeforeUnmount => beforeUnmount => onUnmounted => unmounted
      // 最后标记isUnmounted为true，标记已卸载
      unmount(n1, parentComponent, parentSuspense, true)
      n1 = null
    }

    // patchFlag为BAIL -2
    // 暂时不看???
    if (n2.patchFlag === PatchFlags.BAIL) {
      optimized = false
      n2.dynamicChildren = null
    }

    // 根据新vnode的type做不同的处理
    // 若新老vnode不相同，上面做了卸载老vnode之后，这里的n1为null，只根据n2做插入操作
    // 若这里的n1不为null，说明可以复用
    const { type, ref, shapeFlag } = n2
    switch (type) {
      case Text: // 文本节点
        // 处理文本节点，创建 或 复用更新
        processText(n1, n2, container, anchor)
        break
      case Comment: // 注释节点
        // 处理注释节点，创建 或 复用(不更新)
        processCommentNode(n1, n2, container, anchor)
        break
      case Static: // 静态节点，这是什么vnode，为什么只在dev模式下进行patch???
        // 有n1但非dev模式下，不做处理???
        if (n1 == null) {
          // 没有老vnode，直接创建新的插入
          // 根据n2.children创建dom节点插入到parent中的anchor之前
          mountStaticNode(n2, container, anchor, isSVG)
        } else if (__DEV__) {
          // dev模式下才进行patch
          // 删除老的并创建新的 或 复用(不用更新)
          patchStaticNode(n1, n2, container, isSVG)
        }
        break
      case Fragment: // fragment
        // 处理fragment，fragment不占dom结构位置，直接mount或patch children
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) { // 原生标签
          // 处理原生标签，mount或patch
          // 这里的patch会用到模板编译的patchFlag和dynamicChildren进行patch过程优化，提高性能
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.COMPONENT) { // 组件
          // 首次渲染走mount，更新走patch
          // 这里的是否需要更新组件会用到模板编译的patchFlag和dynamicProps进行判断优化，提高性能
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
        } else if (shapeFlag & ShapeFlags.TELEPORT) { // teleport，不改变组件层级，但可以渲染在任何dom位置
          ;(type as typeof TeleportImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized,
            internals
          )
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) { // suspense
          // 同React的Suspense组件
          // 用法:
          //    <Suspense>
          //      <template #default>
          //        <OtherComponent />
          //      </template>
          //       <template #fallback>
          //         Loading ...
          //      </template>
          //    </Suspense>
          // 其中OtherComponent一般是由defineAsyncComponent加载的异步组件
          ;(type as typeof SuspenseImpl).process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized,
            internals
          )
        } else if (__DEV__) {
          warn('Invalid VNode type:', type, `(${typeof type})`)
        }
    }

    // set ref
    // 清除老的ref，根据vnode和ref不同语法设置新的ref
    // ref依赖于render完的dom或者组件实例，所以设置ref的操作放在mount完成之后
    if (ref != null && parentComponent) {
      setRef(ref, n1 && n1.ref, parentComponent, n2)
    }
  }

  // 处理文本节点，创建 或 复用更新
  const processText: ProcessTextOrCommentFn = (n1, n2, container, anchor) => {
    if (n1 == null) {
      // 创建文本节点并插入
      hostInsert(
        (n2.el = hostCreateText(n2.children as string)),
        container,
        anchor
      )
    } else {
      // 复用n1.el，更新文本
      const el = (n2.el = n1.el!)
      if (n2.children !== n1.children) {
        hostSetText(el, n2.children as string)
      }
    }
  }

  // 处理注释节点，创建 或 复用(不更新)
  const processCommentNode: ProcessTextOrCommentFn = (
    n1,
    n2,
    container,
    anchor
  ) => {
    if (n1 == null) {
      // 创建注释节点并插入
      hostInsert(
        (n2.el = hostCreateComment((n2.children as string) || '')),
        container,
        anchor
      )
    } else {
      // there's no support for dynamic comments
      // 不支持动态注释，只复用原来的注释dom
      n2.el = n1.el
    }
  }

  // 将n2.children中的每一个dom节点插入到parent中 parent.insertBefore(node, anchor)
  // n2.el指向第一个dom节点
  // n2.anchor指向最后一个dom节点
  const mountStaticNode = (
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    isSVG: boolean
  ) => {
    // static nodes are only present when used with compiler-dom/runtime-dom
    // which guarantees presence of hostInsertStaticContent.
    // 将n2.children中的每一个dom节点插入到parent中 parent.insertBefore(node, anchor)
    // 返回第一个和最后一个dom节点
    // 这个方法用到了innerHTML，所以是不安全的
    // n2.el指向第一个dom节点
    // n2.anchor指向最后一个dom节点
    ;[n2.el, n2.anchor] = hostInsertStaticContent!(
      n2.children as string,
      container,
      anchor,
      isSVG
    )
  }

  /**
   * Dev / HMR only
   */
  // Dev / HMR(热替换)
  // 删除老的并创建新的 或 复用(不用更新)
  const patchStaticNode = (
    n1: VNode,
    n2: VNode,
    container: RendererElement,
    isSVG: boolean
  ) => {
    // static nodes are only patched during dev for HMR
    if (n2.children !== n1.children) {
      // 新老children不同，删除老的，插入新的

      const anchor = hostNextSibling(n1.anchor!)
      // remove existing
      // 遍历所有dom节点，做删除操作，这些dom节点都属于这个vnode
      removeStaticNode(n1)
      // insert new
      // 同mountStaticNode
      ;[n2.el, n2.anchor] = hostInsertStaticContent!(
        n2.children as string,
        container,
        anchor,
        isSVG
      )
    } else {
      // 新老children相同，直接复用老的，不用更新

      n2.el = n1.el
      n2.anchor = n1.anchor
    }
  }

  /**
   * Dev / HMR only
   */
  const moveStaticNode = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null
  ) => {
    let cur = vnode.el
    const end = vnode.anchor!
    while (cur && cur !== end) {
      const next = hostNextSibling(cur)
      hostInsert(cur, container, anchor)
      cur = next
    }
    hostInsert(end, container, anchor)
  }

  /**
   * Dev / HMR only
   */
  // Dev 和 HMR(热替换)
  // 遍历所有dom节点，做删除操作，这些dom节点都属于这个vnode
  // vnode.el指向第一个
  // vnode.anchor指向最后一个
  const removeStaticNode = (vnode: VNode) => {
    // vnode.el指向第一个
    // vnode.anchor指向最后一个
    let cur = vnode.el
    // 遍历所有dom节点，做删除操作
    while (cur && cur !== vnode.anchor) {
      const next = hostNextSibling(cur)
      hostRemove(cur)
      cur = next
    }
    // 把最后一个也删除掉
    hostRemove(vnode.anchor!)
  }

  // 处理原生标签，mount或patch
  // 这里的patch会用到模板编译的patchFlag和dynamicChildren进行patch过程优化，提高性能
  const processElement = (
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    isSVG = isSVG || (n2.type as string) === 'svg'
    if (n1 == null) {
      // 克隆或创建vnode对应的dom元素，插入到dom结构中
      // 过程中会执行onBeforeMount生命周期 指令的beforeMount transition的beforeEnter
      // 还会将onMounted transition的enter 指令的mounted 推入postFlushCbs队列，等到异步更新渲染时会执行
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized
      )
    } else {
      // patch原生标签vnode
      // 如果经过模板编译，这里的新vnode上会有patchFlag和dynamicChildren，这是用来优化patch过程的，提高性能
      // 这里会执行 onBeforeUpdate生命周期 和 自定义指令的beforeUpdate
      // 还会将 onUpdated生命周期 和 指令的updated 推入postFlushCbs队列，等到异步更新时会执行
      patchElement(n1, n2, parentComponent, parentSuspense, isSVG, optimized)
    }
  }

  // 克隆或创建原生标签vnode对应的dom元素，插入到dom结构中
  // 过程中会执行onBeforeMount生命周期 指令的beforeMount transition的beforeEnter
  // 还会将onMounted transition的enter 指令的mounted 推入postFlushCbs队列，等到异步更新渲染时会执行
  const mountElement = (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    let el: RendererElement
    let vnodeHook: VNodeHook | undefined | null
    const {
      type,
      props,
      shapeFlag,
      transition,
      scopeId,
      patchFlag,
      dirs
    } = vnode
    // 克隆或创建dom
    // 创建则会处理children props onBeforeMount生命周期 指令的beforeMount scopeId transition的beforeEnter
    if (
      vnode.el &&
      hostCloneNode !== undefined &&
      patchFlag === PatchFlags.HOISTED
    ) {
      // If a vnode has non-null el, it means it's being reused.
      // Only static vnodes can be reused, so its mounted DOM nodes should be
      // exactly the same, and we can simply do a clone here.
      // vnode有el，说明已经重用过了，而只有静态节点才能重用，静态的原生标签必须是一样的，所以可以直接克隆
      el = vnode.el = hostCloneNode(vnode.el)
    } else {
      el = vnode.el = hostCreateElement(
        vnode.type as string,
        isSVG,
        props && props.is
      )

      // mount children first, since some props may rely on child content
      // being already rendered, e.g. `<select value>`
      // 处理children 文本或数组
      if (shapeFlag & ShapeFlags.TEXT_CHILDREN) { // 文本children
        hostSetElementText(el, vnode.children as string)
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) { // 数组children 组件vnode将在这里遍历children
        mountChildren(
          vnode.children as VNodeArrayChildren,
          el,
          null,
          parentComponent,
          parentSuspense,
          isSVG && type !== 'foreignObject',
          optimized || !!vnode.dynamicChildren
        )
      }

      // props
      // 处理props
      // 处理class style onXXX等节点属性
      if (props) {
        for (const key in props) {
          if (!isReservedProp(key)) {
            // 处理class style onXXX等节点属性
            hostPatchProp(
              el,
              key,
              null,
              props[key],
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense
            )
          }
        }
        // 执行onBeforeMount生命周期
        if ((vnodeHook = props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parentComponent, vnode)
        }
      }
      // 执行每一条自定义指令的beforeMount
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
      }

      // scopeId
      // 设置dom元素的id属性
      if (scopeId) {
        hostSetScopeId(el, scopeId)
      }
      const treeOwnerId = parentComponent && parentComponent.type.__scopeId
      // vnode's own scopeId and the current patched component's scopeId is
      // different - this is a slot content node.
      // 当前正在patch的组件scopeId和vnode自身的scopeId不同，表示这个一个slot
      // 重新设置slot对应的dom的id属性
      if (treeOwnerId && treeOwnerId !== scopeId) {
        hostSetScopeId(el, treeOwnerId + '-s')
      }

      // 执行transition的beforeEnter
      if (transition && !transition.persisted) {
        transition.beforeEnter(el)
      }
    }

    // 到这里，已经克隆或创建完成了dom，el指向这个dom

    // 将el插入到dom结构中
    hostInsert(el, container, anchor)
    // 将onMounted transition的enter 指令的mounted 推入postFlushCbs队列，等到异步更新渲染时会执行
    if (
      (vnodeHook = props && props.onVnodeMounted) ||
      (transition && !transition.persisted) ||
      dirs
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        transition && !transition.persisted && transition.enter(el)
        dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
      }, parentSuspense)
    }
  }

  // 获取到每个child对应的vnode(child有可能还没有处理成vnode)，递归patch每个vnode
  // 经过模板编译(不传入render函数，通过template编译出render函数)的一定是vnode
  // 直接传入render函数的还不是vnode
  const mountChildren: MountChildrenFn = (
    children, // 新vnode的children
    container,
    anchor, // 用于让children插入的位置dom
    parentComponent,
    parentSuspense,
    isSVG,
    optimized,
    start = 0
  ) => {
    for (let i = start; i < children.length; i++) {
      // 拿到child对应的vnode
      const child = (children[i] = optimized
        // 没有mount过，child.el指向null，直接返回child
        // mount过，就返回child的克隆版本
        // optimized过的render函数已经格式化处理过child了，所以这里的cloneIfMounted是normalizeVNode中的一部分
        ? cloneIfMounted(children[i] as VNode)
        // 格式化child，返回对应的vnode
        : normalizeVNode(children[i]))
      // 对每个child递归执行patch，插入到dom中
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized
      )
    }
  }

  // patch原生标签vnode
  // 如果经过模板编译，这里的新vnode上会有patchFlag和dynamicChildren，这是用来优化patch过程的，提高性能
  // 这里会执行 onBeforeUpdate生命周期 和 自定义指令的beforeUpdate
  // 还会将 onUpdated生命周期 和 指令的updated 推入postFlushCbs队列，等到异步更新时会执行
  const patchElement = (
    n1: VNode, // 老vnode
    n2: VNode, // 新vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    const el = (n2.el = n1.el!)
    let { patchFlag, dynamicChildren, dirs } = n2
    const oldProps = (n1 && n1.props) || EMPTY_OBJ
    const newProps = n2.props || EMPTY_OBJ
    let vnodeHook: VNodeHook | undefined | null

    // 执行onBeforeUpdate生命周期
    if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
    }
    // 执行自定义指令的beforeUpdate
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate')
    }

    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    // patchFlag是Vue3.x模板编译中生成的，用于优化props class style的patch过程
    // 如果没有走模板编译，只能完整diff，同Vue2.x，相当于没有优化
    // patchFlag是在模板编译过程中根据动态属性生成的，只对标记中的属性进行patch，跳过静态属性，优化patch过程
    // 这个Vue3.x的优化，最小化动态部分，只patch更新动态部分，静态部分全部跳过
    if (patchFlag > 0) {
      // the presence of a patchFlag means this element's render code was
      // generated by the compiler and can take the fast path.
      // in this path old node and new node are guaranteed to have the same shape
      // (i.e. at the exact same position in the source template)
      if (patchFlag & PatchFlags.FULL_PROPS) { // 1 << 4
        // element props contain dynamic keys, full diff needed
        // 动态的key，diff整个props

        // 更新props
        // 处理class style onXXX等节点属性
        patchProps(
          el,
          n2,
          oldProps,
          newProps,
          parentComponent,
          parentSuspense,
          isSVG
        )
      } else {
        // 根据patchFlag，只diff对应的部分

        // class
        // this flag is matched when the element has dynamic class bindings.
        // 动态class，patch更新
        if (patchFlag & PatchFlags.CLASS) { // 1 << 1
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, 'class', null, newProps.class, isSVG)
          }
        }

        // style
        // this flag is matched when the element has dynamic style bindings
        // 动态style，patch更新
        if (patchFlag & PatchFlags.STYLE) { // 1 << 2
          hostPatchProp(el, 'style', oldProps.style, newProps.style, isSVG)
        }

        // props
        // This flag is matched when the element has dynamic prop/attr bindings
        // other than class and style. The keys of dynamic prop/attrs are saved for
        // faster iteration.
        // Note dynamic keys like :[foo]="bar" will cause this optimization to
        // bail out and go through a full diff because we need to unset the old key
        // 非class和style的动态prop/attr，这里的这些动态属性的key只能是静态的，不能是变量
        // 类似 :[foo]="bar" 这种属性会走diff整个props，因为需要重置老的key
        if (patchFlag & PatchFlags.PROPS) { // 1 << 3
          // if the flag is present then dynamicProps must be non-null
          // 这里dynamicProps一定存在
          // 在模板编译时会同时生成这个dynamicProps，是一个包含所有动态属性的key名(这个key名只能是静态的，不能是变量)的数组
          const propsToUpdate = n2.dynamicProps!
          // 对dynamicProps中的属性进行patch更新
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i]
            const prev = oldProps[key]
            const next = newProps[key]
            if (prev !== next) {
              hostPatchProp(
                el,
                key,
                prev,
                next,
                isSVG,
                n1.children as VNode[],
                parentComponent,
                parentSuspense,
                unmountChildren
              )
            }
          }
        }
      }

      // text
      // This flag is matched when the element has only dynamic text children.
      // 动态文本，更新el的文本
      if (patchFlag & PatchFlags.TEXT) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children as string)
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      // unoptimized, full diff
      // 没有优化，也就是没有走模板编译(手动传入了render函数)，只能完整的diff，同Vue2.x
      patchProps(
        el,
        n2,
        oldProps,
        newProps,
        parentComponent,
        parentSuspense,
        isSVG
      )
    }

    const areChildrenSVG = isSVG && n2.type !== 'foreignObject'
    // dynamicChildren是block vnode上绑定的动态子children部分以及子block vnode，由原来的层层children递归变成层层block vnode递归，减少了大量递归遍历
    // 模板编译过程中会生成createBlock代码，在执行render函数时执行createBlock生成block vnode
    // 只patch动态子children，提高性能
    if (dynamicChildren) {
      patchBlockChildren(
        n1.dynamicChildren!,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        areChildrenSVG
      )
      if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
        traverseStaticChildren(n1, n2)
      }
    } else if (!optimized) {
      // full diff
      // 没有走模板编译，也就不会生成dynamicChildren，只能走完整diff，同Vue2.x
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        areChildrenSVG
      )
    }

    // 将 onUpdated生命周期 和 指令的updated 推入postFlushCbs队列，等到异步更新时会执行
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1)
        dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated')
      }, parentSuspense)
    }
  }

  // The fast path for blocks.
  // 对dynamicChildren的每一个对新老child，获取实际的父容器，做新老vnode的patch
  // 这里的更新都是更新到child的父节点一般都不是n1，所以需要获取其父节点
  // 只有block vnode上才有dynamicChildren指向动态子children，只需要遍历动态子children就完成了整个vnode的patch
  const patchBlockChildren: PatchBlockChildrenFn = (
    oldChildren, // n1.dynamicChildren
    newChildren, // dynamicChildren
    fallbackContainer, // n1.el
    parentComponent,
    parentSuspense,
    isSVG
  ) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i]
      const newVNode = newChildren[i]
      // Determine the container (parent element) for the patch.
      // 获取实际的父容器
      // 因为block vnode的dynamicChildren是跨层级的，所以每个child的父容器需要正确获取
      const container =
        // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        // fragment，需要获取其实际的父dom
        oldVNode.type === Fragment ||
        // - In the case of different nodes, there is going to be a replacement
        // which also requires the correct parent container
        // 新老vnode不同，需要父dom做替换处理
        !isSameVNodeType(oldVNode, newVNode) ||
        // - In the case of a component, it could contain anything.
        // 老vnode是组件，包含anything，也需要父dom
        oldVNode.shapeFlag & ShapeFlags.COMPONENT
          // 取oldVNode.el的父dom作为实际的父dom
          ? hostParentNode(oldVNode.el!)!
          : // In other cases, the parent container is not actually used so we
            // just pass the block element here to avoid a DOM parentNode call.
            // 其他情况，直接用n1.el防止调用一个dom父节点，实际上这个情况不存在
            // 比如 <div key="1">111</div> => <div key="1">222</div> ，这种情况下替换文本也是需要正确的父容器，如果用n1.el不就错了吗???
            fallbackContainer
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        true
      )
    }
  }

  // 更新props
  // 处理class style onXXX等节点属性
  const patchProps = (
    el: RendererElement, // 复用的el
    vnode: VNode, // 新vnode
    oldProps: Data,
    newProps: Data,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean
  ) => {
    if (oldProps !== newProps) {
      // 将新props中有的属性更新到el上
      for (const key in newProps) {
        if (isReservedProp(key)) continue
        const next = newProps[key]
        const prev = oldProps[key]
        if (next !== prev) {
          hostPatchProp(
            el,
            key,
            prev,
            next,
            isSVG,
            vnode.children as VNode[],
            parentComponent,
            parentSuspense,
            unmountChildren
          )
        }
      }
      // 将老props中多余的属性全都移除
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              isSVG,
              vnode.children as VNode[],
              parentComponent,
              parentSuspense,
              unmountChildren
            )
          }
        }
      }
    }
  }

  // 处理fragment，fragment不占dom结构位置，直接mount或patch children
  const processFragment = (
    n1: VNode | null, // 老vnode
    n2: VNode, // 新vnode
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    // 第一个和最后一个dom节点
    // 如果n1为null，也就是无法复用，那首尾都是空的文本节点，插入到parent中不影响
    const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''))!
    const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''))!

    let { patchFlag, dynamicChildren } = n2
    if (patchFlag > 0) {
      optimized = true
    }

    // dev模式下的热替换，强制全部做diff
    if (__DEV__ && isHmrUpdating) {
      // HMR updated, force full diff
      patchFlag = 0
      optimized = false
      dynamicChildren = null
    }

    if (n1 == null) {
      // 无法复用
      // 递归patch n2.children中的每一个child对应的vnode

      // 先插入fragmentStartAnchor和fragmentEndAnchor
      // 这样之后插入children的时候就有了位置dom
      hostInsert(fragmentStartAnchor, container, anchor)
      hostInsert(fragmentEndAnchor, container, anchor)
      // a fragment can only have array children
      // since they are either generated by the compiler, or implicitly created
      // from arrays.
      // fragment组件的children只能是array
      // 获取到n2.children中的每个child对应的vnode(child有可能还没有处理成vnode，这里会统一处理成vnode)，递归patch每个vnode
      mountChildren(
        n2.children as VNodeArrayChildren,
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized
      )
    } else {
      // 可以复用

      if (
        patchFlag > 0 &&
        patchFlag & PatchFlags.STABLE_FRAGMENT && // 1 << 6 稳定的fragment 0b01000000
        dynamicChildren
      ) {
        // a stable fragment (template root or <template v-for>) doesn't need to
        // patch children order, but it may contain dynamicChildren.
        // template的根 或 带v-for的template 是稳定的fragment，不需要patch children，但可能存在动态children，这个动态children在执行render函数时已经提取出来了
        // 对dynamicChildren的每一个对新老child，获取实际的父容器，做新老vnode的patch
        patchBlockChildren(
          n1.dynamicChildren!,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          isSVG
        )
        if (__DEV__ && parentComponent && parentComponent.type.__hmrId) {
          traverseStaticChildren(n1, n2)
        }
      } else {
        // keyed / unkeyed, or manual fragments.
        // for keyed & unkeyed, since they are compiler generated from v-for,
        // each child is guaranteed to be a block so the fragment will never
        // have dynamicChildren.
        // keyed 或 unkeyed 或 手动添加的单个fragment
        // v-for模板编译过程中会将每个child处理成block，所以不存在dynamicChildren
        // <fragment v-for="xxx in list"></fragment>
        // 整个是一个block vnode，且每个v-for也是一个block vnode，也就是整个block vnode下每一个fragment都是一个block vnode
        // 这种情况下没有必要走patchBlockChildren逻辑，因为不会跳过任何vnode的patch，反而需要做额外的获取实际父容器，并且会忽略key强行做复用导致出错
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      }
    }
  }

  // 处理组件
  // 首次渲染走mount，更新走patch
  const processComponent = (
    n1: VNode | null, // 老vnode
    n2: VNode, // 新vnode
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    if (n1 == null) { // old vnode不存在，走mount流程
      if (n2.shapeFlag & ShapeFlags.COMPONENT_KEPT_ALIVE) { // new vnode是keep-alive组件，直接走activate流程
        ;(parentComponent!.ctx as KeepAliveContext).activate(
          n2,
          container,
          anchor,
          isSVG,
          optimized
        )
      } else { // new vnode非keep-alive组件，走mountComponent流程
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      }
    } else { // old vnode存在，走updateComponent流程，也就是patch更新
      // 更新组件，这里会做shouldUpdateComponent判断是否需要更新组件
      // 正常更新组件的流程就是instance.update()，也就是执行更新effect，触发patch，更新视图页面
      // 注意这里直接同步执行effect，而不是推入队列等待异步更新，因为这里的组件更新属于当前正在patch的组件内部，应当在这里做同步更新
      updateComponent(n1, n2, optimized)
    }
  }

  // mountComponent主要做了以下三件事：
  //   1. createComponentInstance，初始化组件实例，组件实例包括appContext、parent、root、props、attrs、slots、refs等属性
  //   2. setupComponent，完善instance，
  //        1) 调用initProps、initSlots，初始化instance相关属性
  //        2) 通过setupStatefulComponent调用传入的setup方法，获取返回值setupResult，根据其数据类型对instance进行相应处理
  //        3) finishComponentSetup
  //          a) 检测instance.render是否存在，不存在则调用compile(Component.template)编译render函数
  //          b) 在__FEATURE_OPTIONS__配置下调用applyOptions兼容Vue2.x，合并配置项到vue组件实例，初始化watch、computed、methods等配置项，调用相关生命周期钩子等
  //   3. setupRenderEffect，主要是实现instance.update方法，该方法等价于effect(function componentEffect(){...})，程序如何渲染和更新视图就在这里，这里进行挂载和依赖收集
  // render过程中的上下文context是instance.proxy代理(也就是 with(this) 中的 this )，这样就可以在render过程中正确取值
  // instance.proxy取值包括了所有源数据(setupState data props inject等所有源)
  const mountComponent: MountComponentFn = (
    initialVNode, // 初始vnode，根据_createVnode创建的对象，不是render出来的
    container,
    anchor,
    parentComponent,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // 初始化组件实例，将instance保存在vnode.component属性上面
    const instance: ComponentInternalInstance = (initialVNode.component = createComponentInstance(
      initialVNode,
      parentComponent,
      parentSuspense
    ))

    if (__DEV__ && instance.type.__hmrId) {
      registerHMR(instance)
    }

    // mount过程包括：
    // 1. 初始化props和slots
    // 2. 执行setup
    // 3. 模板编译
    // 4. 兼容Options API
    // 5. 设置render effect，进行挂载和依赖收集
    if (__DEV__) {
      pushWarningContext(initialVNode)
      startMeasure(instance, `mount`)
    }

    // inject renderer internals for keepAlive
    // keepAlive组件，把内部方法放在instance.ctx.renderer上
    if (isKeepAlive(initialVNode)) {
      ;(instance.ctx as KeepAliveContext).renderer = internals
    }

    // resolve props and slots for setup context
    if (__DEV__) {
      startMeasure(instance, `init`)
    }

    // 初始化props和slots
    // 执行传入的setup函数，就可以知道是否传入了render函数
    // 然后决定是否编译模板生成render函数
    // 最后对Options API做兼容处理
    setupComponent(instance)

    if (__DEV__) {
      endMeasure(instance, `init`)
    }

    // setup() is async. This component relies on async logic to be resolved
    // before proceeding
    // 在suspense内部 且 当前组件是defineAsyncComponent异步组件，走下面的逻辑
    // 不直接走setupRenderEffect，而是在promise.then内走setupRenderEffect
    if (__FEATURE_SUSPENSE__ && instance.asyncDep) {
      if (!parentSuspense) {
        if (__DEV__) warn('async setup() is used without a suspense boundary!')
        return
      }

      parentSuspense.registerDep(instance, setupRenderEffect)

      // Give it a placeholder if this is not hydration
      // 不是hydrate过程中，也就是客户端渲染
      // 创建一个空的注释节点作为占位，插入到container中
      // 用于异步组件加载完成之后，找到其父容器和下一个兄弟dom(位置dom)
      if (!initialVNode.el) {
        const placeholder = (instance.subTree = createVNode(Comment))
        processCommentNode(null, placeholder, container!, anchor)
      }
      return
    }

    // 设置组件的render effect
    // 这里会执行一次effect，进行挂载并依赖收集
    // 后续依赖项发生变化，会触发trigger异步执行这里的effect进行更新
    setupRenderEffect(
      instance,
      initialVNode,
      container,
      anchor,
      parentSuspense,
      isSVG,
      optimized
    )

    if (__DEV__) {
      popWarningContext()
      endMeasure(instance, `mount`)
    }
  }

  // 更新组件，这里会做shouldUpdateComponent判断是否需要更新组件
  // 正常更新组件的流程就是instance.update()，也就是执行更新effect，触发patch，更新视图页面
  // 注意这里直接同步执行effect，而不是推入队列等待异步更新
  const updateComponent = (n1: VNode, n2: VNode, optimized: boolean) => {
    const instance = (n2.component = n1.component)!
    // 对比新老vnode的props和children来判断是否需要更新组件
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (
        __FEATURE_SUSPENSE__ &&
        instance.asyncDep &&
        !instance.asyncResolved
      ) {
        // async & still pending - just update props and slots
        // since the component's reactive effect for render isn't set-up yet
        // instance.asyncDep = setupResult
        // instance是suspense内部的异步组件，且还未加载完成
        // 这里只需要更新props和slots，因为等其加载完成之后，会进行handleSetupResult和setupRenderEffect
        // 也就是加载完成之后会设置instance.update，这里不需要做后续处理

        if (__DEV__) {
          pushWarningContext(n2)
        }
        // 只更新props和slots
        updateComponentPreRender(instance, n2, optimized)
        if (__DEV__) {
          popWarningContext()
        }
        return
      } else {
        // normal update
        // 一般组件更新走这里

        instance.next = n2
        // in case the child component is also queued, remove it to avoid
        // double updating the same child component in the same flush.
        // queue有这个instance.update对应的effect在等待更新，直接移除
        // 下一步会直接触发这个effect的更新，避免重复更新
        invalidateJob(instance.update)
        // instance.update is the reactive effect runner.
        // 触发组件更新
        // 注意这里直接同步执行effect，而不是推入队列等待异步更新，因为这里的组件更新属于当前正在patch的组件内部，应当在这里做同步更新
        instance.update()
      }
    } else {
      // no update needed. just copy over properties
      // 不需要更新，直接拷贝
      n2.component = n1.component
      n2.el = n1.el
    }
  }

  // 设置组件的render effect
  // 这里会执行一次effect，进行挂载并依赖收集
  // 后续依赖项发生变化，会触发trigger异步执行这里的effect进行更新
  const setupRenderEffect: SetupRenderEffectFn = (
    instance, // 组件实例
    initialVNode, // 通过_createVnode创建出来的初始vnode，不是render出来的
    container,
    anchor,
    parentSuspense,
    isSVG,
    optimized
  ) => {
    // create reactive effect for rendering
    // instance.update实际上是一个effect
    // 初始化时会执行一次componentEffect，从而完成依赖收集track
    // 当触发trigger时，会再次执行componentEffect，通过patch更新视图
    // render effect异步渲染队列为queue
    // 首次渲染完成之后，依赖项一旦发生变化，都会异步执行这个effect进行更新，也就是render effect的响应式原理
    instance.update = effect(function componentEffect() {
      if (!instance.isMounted) { // instance.isMounted = false 首次渲染
        let vnodeHook: VNodeHook | null | undefined
        const { el, props } = initialVNode
        // beforeMount mounted activated
        const { bm, m, a, parent } = instance
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        // 首次渲染 解析组件节点，生成vnode
        // setupComponent()中生成的最终render函数会在这里执行，触发依赖收集
        // 这里的subTree指的是vue文件内部template中的内容
        // 这里会调用之前编译好的或传入的 render函数 生成vnode，然后将之前的初始化vnode的属性合并过来
        // 最终返回完整的vnode，之后会对这个vnode进行patch(也就是mount)，递归render子树并patch，也就完成了整个vue项目的初始化
        // subTree 指的就是组件的内部树，从组件根节点开始
        const subTree = (instance.subTree = renderComponentRoot(instance))
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // beforeMount hook
        // 调用beforeMount生命周期
        if (bm) {
          invokeArrayFns(bm)
        }
        // 调用onBeforeMount生命周期
        if ((vnodeHook = props && props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parent, initialVNode)
        }

        if (el && hydrateNode) { // SSR混合
          if (__DEV__) {
            startMeasure(instance, `hydrate`)
          }
          // vnode has adopted host node - perform hydration instead of mount.
          hydrateNode(
            initialVNode.el as Node,
            subTree,
            instance,
            parentSuspense
          )
          if (__DEV__) {
            endMeasure(instance, `hydrate`)
          }
        } else { // 客户端渲染
          if (__DEV__) {
            startMeasure(instance, `patch`)
          }
          // 首次渲染  old vnode为null
          // patch subTree，这里会递归下去，初始化每一个子组件并render patch，最终完成整个vue项目的初始化
          patch(
            null,
            subTree, // vnode
            container,
            anchor,
            instance,
            parentSuspense,
            isSVG
          )
          if (__DEV__) {
            endMeasure(instance, `patch`)
          }
          // 更新initialVNode的el
          initialVNode.el = subTree.el
        }
        // mounted hook
        // 将mounted推入postFlushCbs队列，等待异步更新时执行
        if (m) {
          queuePostRenderEffect(m, parentSuspense)
        }
        // 将onMounted推入postFlushCbs队列，等待异步更新时执行
        if ((vnodeHook = props && props.onVnodeMounted)) {
          queuePostRenderEffect(() => {
            invokeVNodeHook(vnodeHook!, parent, initialVNode)
          }, parentSuspense)
        }
        // activated hook for keep-alive roots.
        // 对于keepAlive组件，将activated推入postFlushCbs队列，等待异步更新时执行
        if (
          a &&
          initialVNode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
        ) {
          queuePostRenderEffect(a, parentSuspense)
        }
        // mount完成，标记一下
        instance.isMounted = true
      } else { // instance.isMounted = true 更新渲染
        // updateComponent
        // This is triggered by mutation of component's own state (next: null)
        // OR parent calling processComponent (next: VNode)
        // beforeUpdate updated
        let { next, bu, u, parent, vnode } = instance
        let vnodeHook: VNodeHook | null | undefined
        if (__DEV__) {
          pushWarningContext(next || instance.vnode)
        }

        if (next) {
          // updateProps updateSlots 更新Props Slots
          // 1. 控制的是当前组件内 带slot的子组件 的异步更新，由当前组件传递给slot的props的改变引起
          // 2. 控制的是当前组件自身的slots的更新，结合父组件的updateProps，在当前组件异步更新的时候就可以更新渲染的slots了
          updateComponentPreRender(instance, next, optimized)
        } else {
          // 子组件 自身修改 导致的更新，不用管props和slots
          next = vnode
        }
        if (__DEV__) {
          startMeasure(instance, `render`)
        }
        // 获取新的vnode
        // 同首次渲染
        const nextTree = renderComponentRoot(instance)
        if (__DEV__) {
          endMeasure(instance, `render`)
        }
        // 上一个subTree
        const prevTree = instance.subTree
        // 更新为最新的subTree
        instance.subTree = nextTree
        // 复用原来的el
        next.el = vnode.el
        // beforeUpdate hook
        // 调用beforeUpdate生命周期
        if (bu) {
          invokeArrayFns(bu)
        }
        // 调用onBeforeUpdate生命周期
        if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
          invokeVNodeHook(vnodeHook, parent, next, vnode)
        }
        // reset refs
        // only needed if previous patch had refs
        // 重置refs为空{}
        if (instance.refs !== EMPTY_OBJ) {
          instance.refs = {}
        }
        if (__DEV__) {
          startMeasure(instance, `patch`)
        }
        // patch更新subTree
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          // prevTree.el.parentNode 作为 container
          hostParentNode(prevTree.el!)!,
          // anchor may have changed if it's in a fragment
          // prevTree.el.nextSibling 作为 anchor 用于insertBefore的位置dom
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          isSVG
        )
        if (__DEV__) {
          endMeasure(instance, `patch`)
        }
        // 更新next.el
        next.el = nextTree.el
        if (next === null) {
          // self-triggered update. In case of HOC, update parent component
          // vnode el. HOC is indicated by parent instance's subTree pointing
          // to child component's vnode
          updateHOCHostEl(instance, nextTree.el)
        }
        // updated hook
        // 将updated推入postFlushCbs队列，等待异步更新时执行
        if (u) {
          queuePostRenderEffect(u, parentSuspense)
        }
        // 将onUpdated推入postFlushCbs队列，等待异步更新时执行
        if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
          queuePostRenderEffect(() => {
            invokeVNodeHook(vnodeHook!, parent, next!, vnode)
          }, parentSuspense)
        }
        if (__DEV__) {
          popWarningContext()
        }
      }
    }, __DEV__ ? createDevEffectOptions(instance) : prodEffectOptions)
  }

  // 更新Props Slots
  // 1. 控制的是当前组件内 带slot的子组件 的异步更新，由当前组件传递给slot的props的改变引起
  // 2. 控制的是当前组件自身的slots的更新，结合父组件的updateProps，在当前组件异步更新的时候就可以更新渲染的slots了
  const updateComponentPreRender = (
    instance: ComponentInternalInstance,
    nextVNode: VNode,
    optimized: boolean
  ) => {
    if (__DEV__ && instance.type.__hmrId) {
      optimized = false
    }
    nextVNode.component = instance
    const prevProps = instance.vnode.props
    instance.vnode = nextVNode
    instance.next = null
    // 更新自身的动态props，为啥这里要更新自身的动态props，不是处理父组件传递下来的props吗???
    // 根据prop的限制option更新父组件传递下来的props，如果是attrs上的属性，就直接更新到attrs上，保持函数组件的attrs和props一致
    // 最后触发依赖这个组件$attrs的带slot的子组件的异步更新
    // 这里控制的是当前组件内 带slot的子组件 的异步更新
    updateProps(instance, nextVNode.props, prevProps, optimized)
    // 更新插槽instance.slots，包括动态插槽(模板编译这里会有快速通道patchFlag)和默认插槽
    // 静态插槽不需要更新
    // 这里控制的是当前组件自身的slots的更新
    // 结合父组件的updateProps，在当前组件异步更新的时候就可以更新渲染的slots了
    updateSlots(instance, nextVNode.children)
  }

  // 对children做递归patch，内部核心逻辑是dom diff算法，在patchKeyedChildren种
  // dom diff核心算法进行了性能优化，用到了最长增长子序列，时间复杂度缩短至nlogn，Vue2.x为n^2
  // 同时，新算法已包含Vue2.x中没有优化到的边界情况，提升了性能
  // 这里的逻辑结束之后，表示子树的patch已经全部完成，同时也已经更新到真实dom(这里真实dom也会等待异步更新，浏览器内置)
  // 有dynamicChildren的情况会直接patchBlockChildren逻辑，而不会走patchChildren逻辑
  const patchChildren: PatchChildrenFn = (
    n1, // 老vnode
    n2, // 新vnode
    container, // 容器
    anchor, // insertBefore的位置dom
    parentComponent,
    parentSuspense,
    isSVG,
    optimized = false
  ) => {
    const c1 = n1 && n1.children // 老children
    const prevShapeFlag = n1 ? n1.shapeFlag : 0 // 老vnode的组件类型flag
    const c2 = n2.children // 新children

    const { patchFlag, shapeFlag } = n2
    // fast path
    // 优先处理patchFlag，模板编译过程中根据动态属性生成的标志，可以优化patch过程，不走下面所有情况的判断patch过程
    // 先处理带patchFlag的fragment
    // fragment默认都会是block vnode，所以不能在block vnode的遍历上进行动态children的遍历patch优化，只能在这里通过patchFlag优化
    if (patchFlag > 0) {
      if (patchFlag & PatchFlags.KEYED_FRAGMENT) { // 1 << 7 带key的fragment 0b10000000
        // this could be either fully-keyed or mixed (some keyed some not)
        // presence of patchFlag means children are guaranteed to be arrays
        // 这里可能是全部keyed，也可能是部分
        // 有patchFlag意味着children一定是数组
        // 走dom diff核心逻辑，进行children的diff patch move
        // 核心逻辑涉及到头尾四指针，头头尾尾，最长增长子序列，目的是为了最大可能地减少dom的移动，因为实际dom的操作会比虚拟dom耗性能得多
        patchKeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
        return
      } else if (patchFlag & PatchFlags.UNKEYED_FRAGMENT) { // 1 << 8 不带key的fragment
        // unkeyed
        // 不带key的patch children，不涉及diff核心算法逻辑
        // 遍历每个child做复用patch，老children多的做卸载，新children多的做mount
        // 这里因为fragment作为碎片时，不用传入key，这种情况下一定是复用的，所以可以省去带key的整个逻辑，做到性能优化
        // 只有涉及v-for的fragment才需要传入key
        patchUnkeyedChildren(
          c1 as VNode[],
          c2 as VNodeArrayChildren,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
        return
      }
    }

    // 到这里的全部是没有经过模板编译优化过的vnode
    // 非fragment会在block vnode的dynamicChildren上完成patch操作，不会走到这里
    // 带patchFlag的fragment会在上一步完成patch操作，也不会走到这里

    // children has 3 possibilities: text, array or no children.
    // children只有可能3种情况，文本 数组 null
    // 这三种情况的组合都在下面的逻辑种
    // 没有patchFlag，只能走这里的完整过程，应该是同Vue2.x，没有优化
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) { // 文本
      // text children fast path

      // 老children是数组，直接卸载老children
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        unmountChildren(c1 as VNode[], parentComponent, parentSuspense)
      }
      // 老children是文本或null，这里做文本的替换或添加
      if (c2 !== c1) {
        hostSetElementText(container, c2 as string)
      }
    } else { // 数组 或 null
      if (prevShapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // prev children was array
        // 老children是数组

        // 新老children都是数组，走dom diff核心逻辑
        // 新children为null，对老的数组children做卸载
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          // two arrays, cannot assume anything, do full diff
          // 不传入key的情况，key就是undefined，两个都没有key的vnode，其实也是相同的(同为undefined)，会进行复用，这里可能会导致复用出错
          patchKeyedChildren(
            c1 as VNode[],
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
        } else {
          // no new children, just unmount old
          unmountChildren(c1 as VNode[], parentComponent, parentSuspense, true)
        }
      } else {
        // prev children was text OR null
        // new children is array OR null
        // 老children是文本或null，新children是数组或null

        // 老children是文本，移除文本
        if (prevShapeFlag & ShapeFlags.TEXT_CHILDREN) {
          hostSetElementText(container, '')
        }
        // mount new if array
        // 新children为数组，就mount children
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            c2 as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
        }
      }
    }
  }

  // 不带key的patch children，不涉及diff核心算法逻辑
  // 取新老children的公共部分，相当于使用index进行配对，到patch中发现不是sameVnode，那进行 unmount老的 + mount新的 处理
  // 遍历公共部分做复用patch，老children多的做卸载，新children多的做mount
  const patchUnkeyedChildren = (
    c1: VNode[], // 老children
    c2: VNodeArrayChildren, // 新children
    container: RendererElement, // 容器
    anchor: RendererNode | null, // insertBefore的位置dom
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    c1 = c1 || EMPTY_ARR
    c2 = c2 || EMPTY_ARR
    const oldLength = c1.length
    const newLength = c2.length
    // 取新老children的公共部分，相当于使用index进行配对，到patch中发现不是sameVnode，那进行 unmount老的 + mount新的 处理
    const commonLength = Math.min(oldLength, newLength)
    let i
    for (i = 0; i < commonLength; i++) {
      const nextChild = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized
      )
    }
    if (oldLength > newLength) {
      // remove old
      unmountChildren(c1, parentComponent, parentSuspense, true, commonLength)
    } else {
      // mount new
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized,
        commonLength
      )
    }
  }

  // can be all-keyed or mixed
  // 全部keyed 或 部分keyed
  // dom diff的核心，目的是尽可能只做patch，而不做dom的移动插入，最大程度的性能优化
  // Vue3.x算法实际上是对Vue2.x算法的补充，用最长增长子序列补充了一些边界情况的性能优化
  // 当老children两端都是需要删除的vnode，此时Vue2.x会对中间可patch的vnode都做移动，而Vue3.x可以优化出不需要移动的vnode
  // Vue2.x diff算法的时间复杂度为n，Vue3.x 最长增长子序列时间复杂度为nlogn
  // 核心逻辑涉及到头尾四指针，头头尾尾，最长增长子序列，目的是为了最大可能地减少dom的移动，因为实际dom的操作会比虚拟dom耗性能得多

  // [1,2,3,4,5,6,7,8,9,10] => [1,9,11,7,3,4,5,6,2,10]
  // Vue2.x 移动 2 9 7  新增 11  卸载 8
  // Vue3.x [2,3,4,5,6,7,8,9] => [9,11,7,3,4,5,6,2] => Vue3.x最长增长子序列 [3,4,5,6]
  // 移动 2 7 9  新增 11  卸载 8
  // [1,2,3,4,5,6,7,8,9,10] => [3,1,10,2,9,4,8,6,5,7] => Vue3.x最长增长子序列 [1,3,5,8,9]
  // Vue2.x 移动 3 10 9 8 6
  // Vue3.x 移动 3 10 9 8 6
  // [1,2,3,4,5,6,7] => [1,3,4,5,6]  这种情况下Vue3.x是优于Vue2.x的
  // Vue2.x 移动 3 4 5 6 卸载 2 7
  // Vue3.x 卸载 2 7
  const patchKeyedChildren = (
    c1: VNode[], // 老children
    c2: VNodeArrayChildren, // 新children
    container: RendererElement, // 容器
    parentAnchor: RendererNode | null, // insertBefore的位置dom
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean
  ) => {
    let i = 0 // 开头index指针
    const l2 = c2.length
    let e1 = c1.length - 1 // prev ending index // 老children的最后一个child的index指针
    let e2 = l2 - 1 // next ending index // 新children的最后一个child的index指针

    // 1. sync from start
    // (a b) c
    // (a b) d e
    // 处理新老children开头相同的vnode，遇到第一个不同的就跳出循环
    while (i <= e1 && i <= e2) {
      const n1 = c1[i]
      // 格式化处理child，获取vnode
      const n2 = (c2[i] = optimized
        ? cloneIfMounted(c2[i] as VNode)
        : normalizeVNode(c2[i]))
      // type和key相同，做patch
      // 不传入key的情况，key就是undefined，两个都没有key的vnode，其实也是相同的(同为undefined)，会进行复用，这里可能会导致复用出错
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      } else {
        break
      }
      i++
    }

    // 2. sync from end
    // a (b c)
    // d e (b c)
    // 处理新老children末尾相同的vnode，遇到第一个不同的就跳出循环
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1]
      const n2 = (c2[e2] = optimized
        ? cloneIfMounted(c2[e2] as VNode)
        : normalizeVNode(c2[e2]))
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVG,
          optimized
        )
      } else {
        break
      }
      e1--
      e2--
    }

    // 开头和结尾相同的vnode都已经patch过了，接下来就是正常的按顺序比较
    // i是开头第一个不同的vnode的index指针，e1和e2是末尾第一个不同的新老vnode的index指针
    // 下面3 4 5只会走其中之一

    // 3. common sequence + mount
    // (a b)
    // (a b) c
    // i = 2, e1 = 1, e2 = 2
    // (a b)
    // c (a b)
    // i = 0, e1 = -1, e2 = 0
    // 老的children已经遍历完了，但新的还没有，对新的剩下的做创建插入
    if (i > e1) {
      if (i <= e2) {
        const nextPos = e2 + 1
        // 获取位置dom，这受到第二步的末尾diff的影响
        const anchor = nextPos < l2 ? (c2[nextPos] as VNode).el : parentAnchor
        // 对新children中剩下的vnode做patch，实际上就是创建插入
        while (i <= e2) {

          patch(
            null,
            (c2[i] = optimized
              ? cloneIfMounted(c2[i] as VNode)
              : normalizeVNode(c2[i])),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG
          )
          i++
        }
      }
    }

    // 4. common sequence + unmount
    // (a b) c
    // (a b)
    // i = 2, e1 = 2, e2 = 1
    // a (b c)
    // (b c)
    // i = 0, e1 = 0, e2 = -1
    // 新的children已经遍历完了，但老的还没有，对老的剩下的做卸载
    else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true)
        i++
      }
    }

    // 5. unknown sequence
    // [i ... e1 + 1]: a b [c d e] f g
    // [i ... e2 + 1]: a b [e d c h] f g
    // i = 2, e1 = 4, e2 = 5
    // 新老children都还有，diff算法核心
    else {
      const s1 = i // prev starting index // 老的起始index指针
      const s2 = i // next starting index // 新的起始index指针

      // 5.1 build key:index map for newChildren
      // 新children的key map，key-index
      // 1 2两步涉及的vnode的key不会对这里造成影响，不用管
      // keyToNewIndexMap是存储key(nextChild.key)-value(nextChild的index)的map结构
      const keyToNewIndexMap: Map<string | number, number> = new Map()
      for (i = s2; i <= e2; i++) {
        const nextChild = (c2[i] = optimized
          ? cloneIfMounted(c2[i] as VNode)
          : normalizeVNode(c2[i]))
        if (nextChild.key != null) {
          if (__DEV__ && keyToNewIndexMap.has(nextChild.key)) {
            warn(
              `Duplicate keys found during update:`,
              JSON.stringify(nextChild.key),
              `Make sure keys are unique.`
            )
          }
          keyToNewIndexMap.set(nextChild.key, i)
        }
      }

      // 5.2 loop through old children left to be patched and try to patch
      // matching nodes & remove nodes that are no longer present
      let j
      let patched = 0 // 已patch的数量
      const toBePatched = e2 - s2 + 1 // 需要patch的数量，也就是剩余nextChild的数量
      let moved = false // 是否需要移动位置
      // used to track whether any node has moved
      let maxNewIndexSoFar = 0 // 标记前一个需要移动的vnode的位置，根据新老vnode的相对位置来判断是否需要移动
      // works as Map<newIndex, oldIndex>
      // Note that oldIndex is offset by +1
      // and oldIndex = 0 is a special value indicating the new node has
      // no corresponding old node.
      // used for determining longest stable subsequence
      // newIndexToOldIndexMap[newIndex - s2] = oldIndex + 1 新老index用数组对应起来
      // 如果oldIndex为0，说明没有对应的vnode
      const newIndexToOldIndexMap = new Array(toBePatched)
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0

      // 遍历老children
      // 给能patch复用更新的新vnode判断是否需要移动(只要有一个vnode需要移动，全局moved就标记为true)，然后进行patch更新
      // 多余的老child进行卸载
      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i]
        // 新children都patch完了，剩下的老child直接卸载
        if (patched >= toBePatched) {
          // all new children have been patched so this can only be a removal
          unmount(prevChild, parentComponent, parentSuspense, true)
          continue
        }
        // newIndex 指向老child对应的新child的index
        let newIndex
        if (prevChild.key != null) {
          // 老child有key，找到相同的key的新child的index
          newIndex = keyToNewIndexMap.get(prevChild.key)
        } else {
          // key-less node, try to locate a key-less node of the same type
          // 老child没有key，那就遍历剩下的新child，如果找到相同的节点，就返回新child的index
          for (j = s2; j <= e2; j++) {
            if (
              newIndexToOldIndexMap[j - s2] === 0 &&
              isSameVNodeType(prevChild, c2[j] as VNode)
            ) {
              newIndex = j
              break
            }
          }
        }
        if (newIndex === undefined) {
          // 老vnode没有对应新vnode，直接卸载老的
          unmount(prevChild, parentComponent, parentSuspense, true)
        } else {
          // 老vnode有对应的新vnode，判断新vnode是否需要移动，然后做新老patch更新

          // 更新newIndexToOldIndexMap, newIndex - s2 对应 oldIndex + 1
          // 由于newIndexToOldIndexMap是数组，所以索引必须从0开始，必须用 newIndex - s2
          // 而默认值都为0，所以有值的情况必须从1开始，必须用 oldIndex + 1，这里的 oldIndex + 1 仅仅用于获取最长增长子序列，只需要有正确的相对大小即可
          newIndexToOldIndexMap[newIndex - s2] = i + 1
          // abc => bac
          // 相对位置移动，这里标记的 moved 是整个老children的，不是单独的
          // 后续会根据这个 moved 标志对移动做统一处理
          if (newIndex >= maxNewIndexSoFar) {
            // ac会走这里，不用移动
            maxNewIndexSoFar = newIndex
          } else {
            // b会走这里，需要移动
            moved = true
          }
          // 新老vnode进行patch更新
          patch(
            prevChild,
            c2[newIndex] as VNode,
            container,
            null,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
          patched++
        }
      }

      // 5.3 move and mount
      // generate longest stable subsequence only when nodes have moved
      // 如果需要移动，这里尽可能多得找到不需要移动的dom
      // increasingNewIndexSequence是这些不需要移动的dom的索引 newIndex - s2 的最长增长子序列
      // newIndexToOldIndexMap [2,9,11,8,5,6] => increasingNewIndexSequence [0,4,5]
      // 最长增长子序列 基于 贪心+二分查找，时间复杂度为nlogn
      const increasingNewIndexSequence = moved
        ? getSequence(newIndexToOldIndexMap)
        : EMPTY_ARR
      j = increasingNewIndexSequence.length - 1
      // looping backwards so that we can use last patched node as anchor
      // 从后开始遍历，这样可以用patch完的作为位置dom
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i
        const nextChild = c2[nextIndex] as VNode
        // 位置dom
        const anchor =
          nextIndex + 1 < l2 ? (c2[nextIndex + 1] as VNode).el : parentAnchor
        if (newIndexToOldIndexMap[i] === 0) {
          // mount new
          // 没有对应的老vnode，直接patch创建插入
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG
          )
        } else if (moved) {
          // move if:
          // There is no stable subsequence (e.g. a reverse)
          // OR current node is not among the stable sequence
          // 稳定序列，也就是不需要移动的序列，已经在遍历老children的时候，也就是5.2步骤的时候处理完了，包括patch操作
          // 这里只需要处理位置移动相关的操作，因为不需要移动的情况只需要在 newIndexToOldIndexMap[i] === 0 条件判断下mount新child就行了
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            // j < 0 也就是increasingNewIndexSequence中的全部处理完了，剩下的都需要移动
            // i !== increasingNewIndexSequence[j] 也就是子序列不包含当前newChild的index，需要移动
            // 这里仅仅只做移动插入，因为patch更新操作已经完成
            move(nextChild, container, anchor, MoveType.REORDER) // 2
          } else {
            // 子序列包含当前newChild的index，不需要移动
            j--
          }
        }
      }
    }
  }

  // 将nextChild移动到对应位置，并触发transition enter leave
  // 这里仅仅只做移动插入，因为patch操作已经完成，只需要做移动
  const move: MoveFn = (
    vnode, // nextChild
    container,
    anchor, // insertBefore的位置dom
    moveType,
    parentSuspense = null
  ) => {
    const { el, type, transition, children, shapeFlag } = vnode
    // 组件
    if (shapeFlag & ShapeFlags.COMPONENT) {
      move(vnode.component!.subTree, container, anchor, moveType)
      return
    }

    // suspense组件
    if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
      vnode.suspense!.move(container, anchor, moveType)
      return
    }

    // teleport组件
    if (shapeFlag & ShapeFlags.TELEPORT) {
      ;(type as typeof TeleportImpl).move(vnode, container, anchor, internals)
      return
    }

    // fragment
    if (type === Fragment) {
      // fragment的el指向第一个dom，需要插入
      hostInsert(el!, container, anchor)
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move((children as VNode[])[i], container, anchor, moveType)
      }
      // fragment的anchor指向最后一个dom，需要插入
      hostInsert(vnode.anchor!, container, anchor)
      return
    }

    // static node move can only happen when force updating HMR
    if (__DEV__ && type === Static) {
      moveStaticNode(vnode, container, anchor)
      return
    }

    // single nodes
    // 原生标签 且 带transition 且 非reorder(也就是只有enter和leave)
    const needTransition =
      moveType !== MoveType.REORDER &&
      shapeFlag & ShapeFlags.ELEMENT &&
      transition
    if (needTransition) { // 处理transition
      if (moveType === MoveType.ENTER) { // enter
        // 执行beforeEnter，插入el
        // 将enter推入postFlushCbs回调，等到异步渲染时执行
        transition!.beforeEnter(el!)
        hostInsert(el!, container, anchor)
        queuePostRenderEffect(() => transition!.enter(el!), parentSuspense)
      } else { // leave
        // 处理 leave 或 delayLeave
        // 都会执行performLeave，其中包括插入el和执行afterLeave
        const { leave, delayLeave, afterLeave } = transition!
        const remove = () => hostInsert(el!, container, anchor)
        const performLeave = () => {
          leave(el!, () => {
            remove()
            afterLeave && afterLeave()
          })
        }
        if (delayLeave) {
          delayLeave(el!, remove, performLeave)
        } else {
          performLeave()
        }
      }
    } else { // 不需要处理transition，直接插入el，大部分情况在这里做移动插入操作
      hostInsert(el!, container, anchor)
    }
  }

  // 卸载vnode
  // 生命周期执行顺序onBeforeUnmount => beforeUnmount => onUnmounted => unmounted
  // 最后标记isUnmounted为true，标记已卸载
  // 代码流程为unmounted早于onUnmounted，没有理解透???
  const unmount: UnmountFn = (
    vnode,
    parentComponent,
    parentSuspense,
    doRemove = false
  ) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs
    } = vnode
    // 原生标签的指令
    const shouldInvokeDirs = shapeFlag & ShapeFlags.ELEMENT && dirs
    // keepAlive
    const shouldKeepAlive = shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
    let vnodeHook: VNodeHook | undefined | null

    // unset ref
    // 设置ref为null
    if (ref != null && parentComponent) {
      setRef(ref, null, parentComponent, null)
    }
    
    // 执行onBeforeUnmount生命周期，应该是setup中定义的???
    if ((vnodeHook = props && props.onVnodeBeforeUnmount) && !shouldKeepAlive) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode)
    }

    if (shapeFlag & ShapeFlags.COMPONENT) {
      // 组件，包括状态组件(常规vue文件)和无状态组件(函数组件)
      // 对keepAlive组件进行失活处理，不卸载组件
      // 对非keepAlive组件进行unmountComponent卸载组件

      if (shouldKeepAlive) {
        // keepAlive，做失活处理，不卸载组件

        // 执行ctx.deactivate
        // 这里执行deactivated生命周期???
        ;(parentComponent!.ctx as KeepAliveContext).deactivate(vnode)
      } else {
        // 卸载组件
        // 移除effects响应式
        // 中断异步更新并卸载子树
        // 执行beforeUnmount生命周期，将unmounted和deactivated生命周期放入postFlushCbs队列，会在组件异步更新的时候调用
        unmountComponent(vnode.component!, parentSuspense, doRemove)
      }
    } else {
      // 非常规vue组件和函数组件
      // 执行指令的beforeUnmount方法
      // 卸载children
      // 从父容器中删除vnode对应的dom

      // suspense组件，还没看???
      if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
        vnode.suspense!.unmount(parentSuspense, doRemove)
        return
      }

      // 执行vnode.dirs每一个指令的beforeUnmount方法
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount')
      }

      if (
        dynamicChildren &&
        // #1153: fast path should not be taken for non-stable (v-for) fragments
        (type !== Fragment ||
          (patchFlag > 0 && patchFlag & PatchFlags.STABLE_FRAGMENT)) // 1 << 6 0b01000000
      ) {
        // fast path for block nodes: only need to unmount dynamic children.
        // 快速unmount，只需要unmount动态children
        // 这里只排除 非稳定fragment和没有动态children 的情况

        unmountChildren(dynamicChildren, parentComponent, parentSuspense)
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
        // 非稳定fragment 或是 没有动态children

        unmountChildren(children as VNode[], parentComponent, parentSuspense)
      }

      // an unmounted teleport should always remove its children
      // teleport组件，还没看???
      if (shapeFlag & ShapeFlags.TELEPORT) {
        ;(vnode.type as typeof TeleportImpl).remove(vnode, internals)
      }

      // 从父容器中删除vnode对应的dom，同时处理相关transition的leave delayLeave afterLeave
      if (doRemove) {
        remove(vnode)
      }
    }

    // 非keepAlive组件 且 有onUnmounted生命周期或指令
    // 将onUnmounted生命周期和指令的unmounted方法添加到postFlushCbs队列中，在异步更新的时候会flush执行
    if (
      ((vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs) &&
      !shouldKeepAlive
    ) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode)
        shouldInvokeDirs &&
          invokeDirectiveHook(vnode, null, parentComponent, 'unmounted')
      }, parentSuspense)
    }
  }

  // 从父容器中删除vnode对应的dom，同时处理相关transition的leave delayLeave afterLeave
  const remove: RemoveFn = vnode => {
    const { type, el, anchor, transition } = vnode
    // fragment，直接删除所有包含的dom节点
    if (type === Fragment) {
      removeFragment(el!, anchor!)
      return
    }

    // dev模式下静态节点
    // 遍历所有dom节点，做删除操作，这些dom节点都属于这个vnode
    if (__DEV__ && type === Static) {
      removeStaticNode(vnode)
      return
    }

    // 定义删除方法
    // 先删除dom，然后执行transition.afterLeave()方法
    const performRemove = () => {
      hostRemove(el!)
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave()
      }
    }

    if (
      vnode.shapeFlag & ShapeFlags.ELEMENT &&
      transition &&
      !transition.persisted
    ) {
      // 原生标签且带transition
      // 会先处理transition中的leave和delayLeave
      // 然后在performLeave中执行performRemove

      const { leave, delayLeave } = transition
      // 定义leave方法
      const performLeave = () => leave(el!, performRemove)
      if (delayLeave) {
        delayLeave(vnode.el!, performRemove, performLeave)
      } else {
        performLeave()
      }
    } else {
      // 非 原生标签且带transition
      // 直接执行performRemove

      performRemove()
    }
  }

  // fragment，直接删除所有包含的dom节点
  const removeFragment = (cur: RendererNode, end: RendererNode) => {
    // For fragments, directly remove all contained DOM nodes.
    // (fragment child nodes cannot have transition)
    let next
    while (cur !== end) {
      next = hostNextSibling(cur)!
      hostRemove(cur)
      cur = next
    }
    hostRemove(end)
  }

  // 卸载组件
  // 移除effects响应式
  // 中断异步更新并卸载子树
  // 执行beforeUnmount生命周期，将unmounted和deactivated生命周期放入postFlushCbs队列，会在组件异步更新的时候调用
  const unmountComponent = (
    instance: ComponentInternalInstance, // 组件实例
    parentSuspense: SuspenseBoundary | null,
    doRemove?: boolean
  ) => {
    // HMR  hot module replacement 热替换
    if (__DEV__ && instance.type.__hmrId) {
      unregisterHMR(instance)
    }

    const { bum, effects, update, subTree, um, da, isDeactivated } = instance
    // beforeUnmount hook
    // 执行beforeUnmount生命周期
    if (bum) {
      invokeArrayFns(bum)
    }
    // 移除响应式
    if (effects) {
      for (let i = 0; i < effects.length; i++) {
        stop(effects[i])
      }
    }
    // update may be null if a component is unmounted before its async
    // setup has resolved.
    // 组件异步更新还未完成的时候卸载组件，停止更新并卸载子树
    if (update) {
      stop(update)
      unmount(subTree, instance, parentSuspense, doRemove)
    }
    // unmounted hook
    // 将unmounted生命周期放入postFlushCbs队列，会在组件异步更新的时候调用
    if (um) {
      queuePostRenderEffect(um, parentSuspense)
    }
    // deactivated hook
    // 将deactivated生命周期放入postFlushCbs队列，会在组件异步更新的时候调用
    // 先unmounted再deactivated
    if (
      da &&
      !isDeactivated &&
      instance.vnode.shapeFlag & ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
    ) {
      queuePostRenderEffect(da, parentSuspense)
    }
    // postFlushCbs队列推入回调，执行之后标记isUnmounted为true，已卸载
    queuePostRenderEffect(() => {
      instance.isUnmounted = true
    }, parentSuspense)

    // A component with async dep inside a pending suspense is unmounted before
    // its async dep resolves. This should remove the dep from the suspense, and
    // cause the suspense to resolve immediately if that was the last dep.
    // suspense组件，异步dep resolve完成之前被卸载
    // 如果是最后一个dep，就执行parentSuspense.resolve()
    // suspense的逻辑还没看???
    if (
      __FEATURE_SUSPENSE__ &&
      parentSuspense &&
      !parentSuspense.isResolved &&
      !parentSuspense.isUnmounted &&
      instance.asyncDep &&
      !instance.asyncResolved
    ) {
      parentSuspense.deps--
      if (parentSuspense.deps === 0) {
        parentSuspense.resolve()
      }
    }
  }

  // 卸载children
  const unmountChildren: UnmountChildrenFn = (
    children,
    parentComponent,
    parentSuspense,
    doRemove = false,
    start = 0
  ) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove)
    }
  }

  // 取下一个兄弟dom
  const getNextHostNode: NextFn = vnode => {
    // 状态组件或函数组件
    if (vnode.shapeFlag & ShapeFlags.COMPONENT) {
      return getNextHostNode(vnode.component!.subTree)
    }
    // suspense组件
    if (__FEATURE_SUSPENSE__ && vnode.shapeFlag & ShapeFlags.SUSPENSE) {
      return vnode.suspense!.next()
    }
    // 其他情况
    // 取下一个兄弟dom
    return hostNextSibling((vnode.anchor || vnode.el)!)
  }

  /**
   * #1156
   * When a component is HMR-enabled, we need to make sure that all static nodes
   * inside a block also inherit the DOM element from the previous tree so that
   * HMR updates (which are full updates) can retrieve the element for patching.
   *
   * Dev only.
   */
  const traverseStaticChildren = (n1: VNode, n2: VNode) => {
    const ch1 = n1.children
    const ch2 = n2.children
    if (isArray(ch1) && isArray(ch2)) {
      for (let i = 0; i < ch1.length; i++) {
        const c1 = ch1[i]
        const c2 = ch2[i]
        if (
          isVNode(c1) &&
          isVNode(c2) &&
          c2.shapeFlag & ShapeFlags.ELEMENT &&
          !c2.dynamicChildren
        ) {
          if (c2.patchFlag <= 0) {
            c2.el = c1.el
          }
          traverseStaticChildren(c1, c2)
        }
      }
    }
  }

  // vnode  已经处理过组件类型二进制标志shapeFlag和children的虚拟dom
  // container  根vnode一般为'#app'
  const render: RootRenderFunction = (vnode, container) => {
    if (vnode == null) {
      // 卸载，app.unmount卸载时会传入null
      if (container._vnode) {
        unmount(container._vnode, null, null, true)
      }
    } else {
      // 首次和更新渲染都在这里

      // container._vnode指向上一次render完成的vnode，首次渲染就为null
      // vnode指向最新的vnode
      // container就是容器
      patch(container._vnode || null, vnode, container)
    }
    // 遍历PostFlushCbs队列并清空
    // 同步render结束之后，需要最后遍历执行一遍postFlushCbs队列，以免后面添加进去的回调没有执行
    flushPostFlushCbs()
    // container的_vnode标识最新的vnode
    container._vnode = vnode
  }

  const internals: RendererInternals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  }

  let hydrate: ReturnType<typeof createHydrationFunctions>[0] | undefined
  let hydrateNode: ReturnType<typeof createHydrationFunctions>[1] | undefined
  if (createHydrationFns) {
    ;[hydrate, hydrateNode] = createHydrationFns(internals as RendererInternals<
      Node,
      Element
    >)
  }

  return {
    render, // 渲染函数
    hydrate, // SSR
    createApp: createAppAPI(render, hydrate)
  }
}

// 带错误处理的执行hook
export function invokeVNodeHook(
  hook: VNodeHook,
  instance: ComponentInternalInstance | null, // 组件实例
  vnode: VNode,
  prevVNode: VNode | null = null
) {
  // 带错误处理的执行hook
  callWithAsyncErrorHandling(hook, instance, ErrorCodes.VNODE_HOOK, [
    vnode,
    prevVNode
  ])
}

// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
// arr  newIndexToOldIndexMap
// arr[newIndex - s2] = oldIndex + 1
// 获取最长增长子序列的索引数组 [2,11,6,8,1] => [0,2,3] | [2,9,11,8,5,6] => [0,4,5]
// 目的是尽可能多得找到不需要移动的dom，返回的result是这些不需要移动的dom的索引 newIndex - s2 的最长增长子序列
// 贪心+二分查找，时间复杂度为nlogn
// 优化：用p数组存放前一个值的正确索引，用于最后回溯正确索引值
function getSequence(arr: number[]): number[] {
  // p数组用来存放arr中上一个比自身小的值的索引
  // P[i]存放的是当前arr[i]的前一个值的正确索引
  // 用于最后回溯
  // 这里 p = [] 也是可以的，只对需要的index进行赋值，其余为undefined
  const p = arr.slice()
  // result数组是存储最长增长子序列的索引数组
  // result走的是正常的贪心+二分查找逻辑，最后result的长度是正确的，但是内部值是错误的
  const result = [0]
  let i, j, u, v, c
  const len = arr.length
  // 遍历arr
  for (i = 0; i < len; i++) {
    const arrI = arr[i]
    // 不为0，表示可以复用
    // 为0，表示不存在老child，自然也不需要移动，这里不用做处理
    if (arrI !== 0) {
      // j是子序列索引最后一项
      j = result[result.length - 1]
      // 如果arr[i] > arr[j], 当前值比最后一项还大，可以直接push到索引数组(result)中去
      if (arr[j] < arrI) {
        // p记录第i个位置的索引变为j，指向的是上一个子序列索引最后一项，也就是上一个比它小的索引
        p[i] = j
        result.push(i)
        continue
      }
      // arr[j] >= arrI 的情况，也就是不满足继续增长

      // 已经完成的部分增长子序列的第一项
      u = 0
      // 已经完成的部分增长子序列的最后一项
      v = result.length - 1
      // 二分查找，直到u和v相等，都指向中间位置，这个位置是第一个开始比当前arrI大的位置
      while (u < v) {
        c = ((u + v) / 2) | 0
        if (arr[result[c]] < arrI) {
          u = c + 1
        } else {
          v = c
        }
      }
      // u指向的是arr中第一个比当前arrI大的索引
      if (arrI < arr[result[u]]) {
        // 如果u === 0，说明当前arrI是最小的，后续回溯的时候用不到p[i]的值
        if (u > 0) {
          // p[i]指向的是arr中的最后一个比当前arrI小的索引
          p[i] = result[u - 1]
        }
        // result[u]指向的是 遍历至此 arr中最后一个比当前arrI小或等于的索引
        // result[u]存储的永远是 遍历至此 arr中最小的一个的index，所以在之后循环中的二分查找会有影响，使得result数组永远是最长增长子数列的小数组
        // 小数组才能在后续循环中继续增加子序列的长度，大数组则会出错
        // [2,9,11,8,5,6] => result一定为小数组[0,4,5]，不会是大数组[0,1,2]
        // 这里做贪心处理，为了得到最优解，会添加错误的结果，但是result的长度一定是对的，所以需要p数组来记录正确的索引
        result[u] = i
      }
    }
  }
  // 到这里，结合p和result可以得到最终的最长增长子序列result
  // p数组的内容为 arr[pIndex]在arr.slice(0, pIndex + 1)中的增长子序列的 位置index - 1 ，也就是增长子序列中前一个元素的位置index
  // result数组的内容为 arr中比arr[resultIndex]小的所有值的index中的最大值，也就是arr中 最后一个比arr[resultIndex]小 的index
  // result会有拦截，也就是只会更新第一个大的位置的index，因为result是最大增大子序列的索引数组，后面的不需要更新，一定是比前面的大
  // [2,9,11,8,5,6] => result [0,4,5]  p [2,0,1,0,0,4] => 最终的result [0,4,5]
  // 回溯从result最后开始，result的最后一个索引一定是正确的
  // 然后每次根据后一个索引从p数组中拿出它前一个的正确索引，重新赋值到result的前一个位置
  // 最后result就变成了正确索引数组
  u = result.length
  v = result[u - 1]
  while (u-- > 0) {
    result[u] = v
    v = p[v]
  }
  return result
}
