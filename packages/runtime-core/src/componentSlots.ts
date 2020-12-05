import { ComponentInternalInstance, currentInstance } from './component'
import {
  VNode,
  VNodeNormalizedChildren,
  normalizeVNode,
  VNodeChild,
  InternalObjectKey
} from './vnode'
import {
  isArray,
  isFunction,
  EMPTY_OBJ,
  ShapeFlags,
  PatchFlags,
  extend,
  def
} from '@vue/shared'
import { warn } from './warning'
import { isKeepAlive } from './components/KeepAlive'
import { withCtx } from './helpers/withRenderContext'
import { isHmrUpdating } from './hmr'

export type Slot = (...args: any[]) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type Slots = Readonly<InternalSlots>

export type RawSlots = {
  [name: string]: unknown
  // manual render fn hint to skip forced children updates
  $stable?: boolean
  // internal, for tracking slot owner instance. This is attached during
  // normalizeChildren when the component vnode is created.
  _ctx?: ComponentInternalInstance | null
  // internal, indicates compiler generated slots
  _?: 1
}

const isInternalKey = (key: string) => key[0] === '_' || key === '$stable'

// 处理array或者单个vnode类型的slot，最终都到normalizeVNode(单个vnode)
const normalizeSlotValue = (value: unknown): VNode[] =>
  isArray(value)
    ? value.map(normalizeVNode)
    : [normalizeVNode(value as VNodeChild)]

// 处理function类型的slot，最终到normalizeVNode(单个vnode)
const normalizeSlot = (
  key: string,
  rawSlot: Function,
  ctx: ComponentInternalInstance | null | undefined
): Slot =>
  withCtx((props: any) => {
    if (__DEV__ && currentInstance) {
      warn(
        `Slot "${key}" invoked outside of the render function: ` +
          `this will not track dependencies used in the slot. ` +
          `Invoke the slot function inside the render function instead.`
      )
    }
    return normalizeSlotValue(rawSlot(props))
  }, ctx)

// rawSlots  instance.vnode.children
// slots  instance.slots = {}
// 将rawSlots的格式化处理结果更新到slots中，每个slot都支持function array 单个vnode
// 处理后的slots为 key-vnode 的对象
const normalizeObjectSlots = (rawSlots: RawSlots, slots: InternalSlots) => {
  const ctx = rawSlots._ctx
  // 遍历slots，处理不同类型的slot，最终都到normalizeVNode(单个vnode)
  for (const key in rawSlots) {
    if (isInternalKey(key)) continue
    const value = rawSlots[key]
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx)
    } else if (value != null) {
      if (__DEV__) {
        warn(
          `Non-function value encountered for slot "${key}". ` +
            `Prefer function slots for better performance.`
        )
      }
      const normalized = normalizeSlotValue(value)
      slots[key] = () => normalized
    }
  }
}

// 将instance.vnode.children处理为默认slot
// instance.slots.default指向一个返回对应vnode的方法
const normalizeVNodeSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren // instance.vnode.children
) => {
  if (__DEV__ && !isKeepAlive(instance.vnode)) {
    warn(
      `Non-function value encountered for default slot. ` +
        `Prefer function slots for better performance.`
    )
  }
  const normalized = normalizeSlotValue(children)
  instance.slots.default = () => normalized
}

// 初始化slots
// 处理带slot标签的具名插槽和没有slot标签的默认插槽，更新到intance.slots上，默认插槽的名字为default
export const initSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren // instance.vnode.children
) => {
  if (instance.vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    // 有传入slots，表示children是有slot标签的具名插槽???
    if ((children as RawSlots)._ === 1) {
      instance.slots = children as InternalSlots
    } else {
      // 将rawSlots的格式化处理结果更新到instance.slots中，每个slot都支持function array 单个vnode
      // 处理后的slots为 key-vnode 的对象
      normalizeObjectSlots(children as RawSlots, (instance.slots = {}))
    }
  } else {
    // 没有传入slots，表示children没有slot标签，将children当作默认slot处理???
    instance.slots = {}
    if (children) {
      // 将instance.vnode.children处理为默认slot
      // instance.slots.default指向一个返回对应vnode的方法
      normalizeVNodeSlots(instance, children)
    }
  }
  // instance.slots.__vInternal = 1
  def(instance.slots, InternalObjectKey, 1)
}

// 更新插槽instance.slots，包括动态插槽(模板编译这里会有快速通道patchFlag)和默认插槽
// 静态插槽不需要更新
export const updateSlots = (
  instance: ComponentInternalInstance, // 组件实例
  children: VNodeNormalizedChildren // instance.vnode.children 新vnode的children，也就是slots
) => {
  const { vnode, slots } = instance
  let needDeletionCheck = true
  let deletionComparisonTarget = EMPTY_OBJ
  if (vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) { // 1 << 5
    if ((children as RawSlots)._ === 1) {
      // compiled slots.
      // 编译过的slots
      if (__DEV__ && isHmrUpdating) {
        // Parent was HMR updated so slot content may have changed.
        // force update slots and mark instance for hmr as well
        extend(slots, children as Slots)
      } else if (
        // bail on dynamic slots (v-if, v-for, reference of scope variables)
        !(vnode.patchFlag & PatchFlags.DYNAMIC_SLOTS) // 1 << 10 不是动态slots
      ) {
        // compiled AND static.
        // no need to update, and skip stale slots removal.
        // 静态slots，不需要更新，并跳过插槽移除
        needDeletionCheck = false
      } else { // 动态slots
        // compiled but dynamic - update slots, but skip normalization.
        // 合并新的slots到原来的slots上
        extend(slots, children as Slots)
      }
    } else {
      // 没有编译过，需要格式化处理新slots
      needDeletionCheck = !(children as RawSlots).$stable
      // 将children格式化处理结果更新到slots中，每个slot都支持function array 单个vnode
      // 处理后的slots为 key-vnode 的对象
      normalizeObjectSlots(children as RawSlots, slots)
    }
    // 需要对比删除的目标是新slots
    deletionComparisonTarget = children as RawSlots
  } else if (children) {
    // non slot object children (direct value) passed to a component
    // 传了单个value作为slot，那么就当作默认插槽处理，更新到instance.slots.default上
    // 这里已经完成了更新，下面的删除过程只需要防止default插槽被删除就行了
    normalizeVNodeSlots(instance, children)
    // deletionComparisonTarget中加上default，避免被删除
    deletionComparisonTarget = { default: 1 }
  }

  // delete stale slots
  // 遍历最新的所有slots，不在最新的deletionComparisonTarget中的slots都做删除
  // 最后slots剩下的都是deletionComparisonTarget中的slots，也就是新的slots
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && !(key in deletionComparisonTarget)) {
        delete slots[key]
      }
    }
  }
}
