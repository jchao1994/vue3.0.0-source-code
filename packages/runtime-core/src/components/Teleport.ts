import { ComponentInternalInstance } from '../component'
import { SuspenseBoundary } from './Suspense'
import {
  RendererInternals,
  MoveType,
  RendererElement,
  RendererNode,
  RendererOptions
} from '../renderer'
import { VNode, VNodeArrayChildren, VNodeProps } from '../vnode'
import { isString, ShapeFlags } from '@vue/shared'
import { warn } from '../warning'

export interface TeleportProps {
  to: string | RendererElement
  disabled?: boolean
}

export const isTeleport = (type: any): boolean => type.__isTeleport

// teleport支持disabled属性
const isTeleportDisabled = (props: VNode['props']): boolean =>
  props && (props.disabled || props.disabled === '')

// 解析用户传入的to作为selecter，找到对应的dom元素，也就是需要挂载的dom元素
const resolveTarget = <T = RendererElement>(
  props: TeleportProps | null,
  select: RendererOptions['querySelector']
): T | null => {
  // 用户传入的selecter
  const targetSelector = props && props.to
  if (isString(targetSelector)) { // 字符串selecter，返回找到的dom元素
    if (!select) {
      __DEV__ &&
        warn(
          `Current renderer does not support string target for Teleports. ` +
            `(missing querySelector renderer option)`
        )
      return null
    } else {
      const target = select(targetSelector)
      if (!target) {
        __DEV__ &&
          warn(
            `Failed to locate Teleport target with selector "${targetSelector}".`
          )
      }
      return target as any
    }
  } else { // 非字符串selecter，报错，直接返回to属性
    if (__DEV__ && !targetSelector) {
      warn(`Invalid Teleport target: ${targetSelector}`)
    }
    return targetSelector as any
  }
}

export const TeleportImpl = {
  __isTeleport: true,
  process(
    n1: VNode | null, // 老vnode
    n2: VNode, // 新vnode
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean,
    internals: RendererInternals
  ) {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment }
    } = internals

    // teleport支持disabled属性
    const disabled = isTeleportDisabled(n2.props)
    const { shapeFlag, children } = n2
    if (n1 == null) { // 首次渲染，根据disabled属性决定挂载在哪个container上
      // insert anchors in the main view
      // teleport起始占位付
      // teleport.el指向起始占位符
      const placeholder = (n2.el = __DEV__
        ? createComment('teleport start')
        : createText(''))
      // teleport结束占位符，可作用位置dom
      // teleport.anchor指向结束占位符
      const mainAnchor = (n2.anchor = __DEV__
        ? createComment('teleport end')
        : createText(''))
      // 将头尾占位符插入container
      // container中一定有teleport的首尾占位符
      insert(placeholder, container, anchor)
      insert(mainAnchor, container, anchor)

      // 解析用户传入的to作为selecter，找到对应的dom元素，也就是需要挂载的dom元素
      const target = (n2.target = resolveTarget(
        n2.props as TeleportProps,
        querySelector
      ))
      // 在target末尾插入空文本节点作为位置dom
      // target中一定有teleport的结束占位符
      const targetAnchor = (n2.targetAnchor = createText(''))
      if (target) {
        insert(targetAnchor, target)
      } else if (__DEV__) {
        warn('Invalid Teleport target on mount:', target, `(${typeof target})`)
      }

      const mount = (container: RendererElement, anchor: RendererNode) => {
        // Teleport *always* has Array children. This is enforced in both the
        // compiler and vnode children normalization.
        // teleport的ShapeFlags一定是ARRAY_CHILDREN
        // 在编译和normalizeChildren做了这样的处理
        // mountChildren到container(这个container由disabled决定是否取用to选择器)上
        if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
          mountChildren(
            children as VNodeArrayChildren,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            isSVG,
            optimized
          )
        }
      }

      // 传入disabled，mount到container
      // 不传入disabled，mount到target，也就是to找到的dom元素
      if (disabled) {
        mount(container, mainAnchor)
      } else if (target) {
        mount(target, targetAnchor)
      }
    } else { // 更新渲染，先更新patch，再处理是否container变动的情况
      // update content
      // 起始占位符
      n2.el = n1.el
      // target和container都是不会变的，所以连同其anchor直接复用
      const mainAnchor = (n2.anchor = n1.anchor)!
      const target = (n2.target = n1.target)!
      const targetAnchor = (n2.targetAnchor = n1.targetAnchor)!
      // 根据老vnode的disabled，取到当前渲染在视图中的container和anchor
      const wasDisabled = isTeleportDisabled(n1.props)
      const currentContainer = wasDisabled ? container : target
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor

      // 先更新patch，再处理是否container变动的情况
      if (n2.dynamicChildren) { // 模板编译出dynamicChildren，只patch动态的，Vue3.x的优化
        // fast path when the teleport happens to be a block root
        patchBlockChildren(
          n1.dynamicChildren!,
          n2.dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          isSVG
        )
      } else if (!optimized) { // 没有经过模板编译，没有快速通道，只能patch所有的children
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          isSVG
        )
      }

      // enabled -> disabled，将children移动到container上
      if (disabled) { // 新的是disabled
        if (!wasDisabled) {
          // enabled -> disabled
          // move into main container
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      } else { // 新的是enabled
        // target changed
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) { // 新老target不同
          const nextTarget = (n2.target = resolveTarget(
            n2.props as TeleportProps,
            querySelector
          ))
          // 移动children到新target上
          if (nextTarget) {
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              TeleportMoveTypes.TARGET_CHANGE
            )
          } else if (__DEV__) {
            warn(
              'Invalid Teleport target on update:',
              target,
              `(${typeof target})`
            )
          }
        } else if (wasDisabled) { // 新老target相同 且 老的是disabled
          // disabled -> enabled
          // move into teleport target
          // 移动children到target上
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            TeleportMoveTypes.TOGGLE
          )
        }
      }
    }
  },

  // 移除结尾占位符和children
  // 开头占位符也就是vnode.el在其他地方做移除的，这里不需要重复处理
  remove(
    vnode: VNode,
    { r: remove, o: { remove: hostRemove } }: RendererInternals
  ) {
    const { shapeFlag, children, anchor } = vnode
    // 移除结尾占位符
    hostRemove(anchor!)
    // 移除children
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        remove((children as VNode[])[i])
      }
    }
  },

  move: moveTeleport,
  hydrate: hydrateTeleport
}

export const enum TeleportMoveTypes {
  TARGET_CHANGE,
  TOGGLE, // enable / disable
  REORDER // moved in the main view
}

function moveTeleport(
  vnode: VNode, // n2
  container: RendererElement,
  parentAnchor: RendererNode | null,
  { o: { insert }, m: move }: RendererInternals,
  moveType: TeleportMoveTypes = TeleportMoveTypes.REORDER // 默认值是TeleportMoveTypes.REORDER
) {
  // move target anchor if this is a target change.
  // 新老target不同，将target位置dom先插入到新target中
  if (moveType === TeleportMoveTypes.TARGET_CHANGE) {
    insert(vnode.targetAnchor!, container, parentAnchor)
  }
  const { el, anchor, shapeFlag, children, props } = vnode
  // TeleportMoveTypes.REORDER 表示 父组件在diff children时标记这个teleport需要移动
  // 无论是否渲染在container还是target上，container中都会有teleport.el和anchor，作为头尾的占位符
  const isReorder = moveType === TeleportMoveTypes.REORDER
  // move main view anchor if this is a re-order.
  // teleport.el指向起始占位符
  if (isReorder) {
    insert(el!, container, parentAnchor)
  }
  // if this is a re-order and teleport is enabled (content is in target)
  // do not move children. So the opposite is: only move children if this
  // is not a reorder, or the teleport is disabled
  // TeleportMoveTypes.TOGGLE TeleportMoveTypes.TARGET_CHANGE 在这里处理
  // TeleportMoveTypes.REORDER 且 disabled 也在这里处理
  // 也就是teleport在container上时，diff出来需要移动，这里需要做移动处理
  // TeleportMoveTypes.REORDER 且 enabled 的情况不需要移动
  // 也就是teleport在target上时，diff出来需要移动，这里也不需要做处理，因为teleport不在container上
  if (!isReorder || isTeleportDisabled(props)) {
    // Teleport has either Array children or no children.
    // 遍历children，将children[i].el插入到container中
    if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      for (let i = 0; i < (children as VNode[]).length; i++) {
        move(
          (children as VNode[])[i],
          container,
          parentAnchor,
          MoveType.REORDER
        )
      }
    }
  }
  // move main view anchor if this is a re-order.
  // 插入结束占位符
  if (isReorder) {
    insert(anchor!, container, parentAnchor)
  }
}

interface TeleportTargetElement extends Element {
  // last teleport target
  _lpa?: Node | null
}

function hydrateTeleport(
  node: Node, // 老dom节点，也就是teleport的起始占位符
  vnode: VNode, // 新vnode
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  optimized: boolean,
  {
    o: { nextSibling, parentNode, querySelector }
  }: RendererInternals<Node, Element>,
  hydrateChildren: (
    node: Node | null,
    vnode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  // 新target
  const target = (vnode.target = resolveTarget<Element>(
    vnode.props as TeleportProps,
    querySelector
  ))
  if (target) {
    // if multiple teleports rendered to the same target element, we need to
    // pick up from where the last teleport finished instead of the first node
    // targetNode指向当前teleport在target中的第一个dom(第一个child dom 或 结束占位符)
    // 因为teleport都是插在target的末尾，所以target._lpa不会指向target内部的 其他不属于teleport的dom
    const targetNode =
      (target as TeleportTargetElement)._lpa || target.firstChild
    // teleport的children一定是array
    if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (isTeleportDisabled(vnode.props)) { // disabled，也就是容器是container
        // 混合children完，返回children的下一个dom，也就是位置dom
        vnode.anchor = hydrateChildren(
          nextSibling(node), // 这里的node指向teleport的起始占位符，所以首个child必须是nextSibling
          vnode,
          parentNode(node)!, // 起始占位符的父dom，也就是container
          parentComponent,
          parentSuspense,
          optimized
        )
        // 结束占位符
        vnode.targetAnchor = targetNode
      } else { // enabled，也就是容器是target
        // 容器是target的情况下，container中只有teleport的头尾占位符
        vnode.anchor = nextSibling(node)
        // target中一定有teleport的结束占位符
        vnode.targetAnchor = hydrateChildren(
          targetNode, // 首个child dom
          vnode,
          target,
          parentComponent,
          parentSuspense,
          optimized
        )
      }
      // 只有target中有多个teleport时，这个_lpa才起作用
      // vnode._lpa指向 下一个teleport 在target中的第一个dom(第一个child dom 或 结束占位符)
      // 这里vnode.targetAnchor指向的一定是teleport在target中的结束占位符
      ;(target as TeleportTargetElement)._lpa =
        vnode.targetAnchor && nextSibling(vnode.targetAnchor as Node)
    }
  }
  // vnode.anchor指向的是teleport在container中的结尾占位符
  // 这里返回container中teleport的下一个兄弟dom，继续hydrate流程
  return vnode.anchor && nextSibling(vnode.anchor as Node)
}

// Force-casted public typing for h and TSX props inference
export const Teleport = (TeleportImpl as any) as {
  __isTeleport: true
  new (): { $props: VNodeProps & TeleportProps }
}
