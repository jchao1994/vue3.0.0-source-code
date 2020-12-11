import {
  ComponentInternalInstance,
  FunctionalComponent,
  Data
} from './component'
import {
  VNode,
  normalizeVNode,
  createVNode,
  Comment,
  cloneVNode,
  Fragment,
  VNodeArrayChildren,
  isVNode
} from './vnode'
import { handleError, ErrorCodes } from './errorHandling'
import { PatchFlags, ShapeFlags, isOn } from '@vue/shared'
import { warn } from './warning'
import { isHmrUpdating } from './hmr'

// mark the current rendering instance for asset resolution (e.g.
// resolveComponent, resolveDirective) during render
export let currentRenderingInstance: ComponentInternalInstance | null = null

export function setCurrentRenderingInstance(
  instance: ComponentInternalInstance | null
) {
  currentRenderingInstance = instance
}

// dev only flag to track whether $attrs was used during render.
// If $attrs was used during render then the warning for failed attrs
// fallthrough can be suppressed.
let accessedAttrs: boolean = false

export function markAttrsAccessed() {
  accessedAttrs = true
}

// instance => subTree vnode
// 这里的subTree指的是vue文件内部template中的内容
// 这里会调用之前编译好的或传入的 render函数 生成vnode，然后将之前的初始化vnode的属性合并过来
// 最终返回完整的vnode
export function renderComponentRoot(
  instance: ComponentInternalInstance // 组件实例
): VNode {
  const {
    type: Component,
    parent,
    vnode,
    proxy, // publicThis，由于Vue3.x没有类语法，这个proxy类似Vue2.x的this
    withProxy,
    props,
    slots,
    attrs,
    emit,
    renderCache
  } = instance

  let result
  // 当前rendering组件实例
  currentRenderingInstance = instance
  if (__DEV__) {
    accessedAttrs = false
  }
  try {
    let fallthroughAttrs
    if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) { // 状态组件，也就是vue文件
      // withProxy is a proxy with a different `has` trap only for
      // runtime-compiled render functions using `with` block.
      // withProxy仅仅用在模板编译出来的render函数外面包的 with(this) 上吗，这个this指向withProxy???
      const proxyToUse = withProxy || proxy
      result = normalizeVNode(
        // render生成vnode
        // 注意这里render的context是proxyToUse，也就是 instance.withProxy || instance.proxy
        // 对render函数过程中的取值已完成代理
        instance.render!.call(proxyToUse, proxyToUse!, renderCache)
      )
      fallthroughAttrs = attrs
    } else { // 函数组件，无状态组件
      // functional
      const render = Component as FunctionalComponent
      // in dev, mark attrs accessed if optional props (attrs === props)
      if (__DEV__ && attrs === props) {
        markAttrsAccessed()
      }
      // 函数组件直接执行构造函数，生成vnode
      result = normalizeVNode(
        render.length > 1
          ? render(
              props,
              __DEV__
                ? {
                    get attrs() {
                      markAttrsAccessed()
                      return attrs
                    },
                    slots,
                    emit
                  }
                  // context
                : { attrs, slots, emit }
            )
          : render(props, null as any /* we know it doesn't need it */)
      )
      // 没有props，说明之前的props都转成attrs了，这种情况下只取attrs中的 class style onXxx
      fallthroughAttrs = Component.props ? attrs : getFallthroughAttrs(attrs)
    }

    // attr merging
    // in dev mode, comments are preserved, and it's possible for a template
    // to have comments along side the root element which makes it a fragment

    // 通过render函数生成的根vnode，对应的是vue文件template内部的根dom
    let root = result
    let setRoot: ((root: VNode) => void) | undefined = undefined
    if (__DEV__) {
      ;[root, setRoot] = getChildRoot(result)
    }

    if (
      Component.inheritAttrs !== false &&
      fallthroughAttrs &&
      Object.keys(fallthroughAttrs).length
    ) {
      if (
        root.shapeFlag & ShapeFlags.ELEMENT || // 原生标签
        root.shapeFlag & ShapeFlags.COMPONENT // 组件
      ) {
        // 克隆一份根vnode
        root = cloneVNode(root, fallthroughAttrs)
      } else if (__DEV__ && !accessedAttrs && root.type !== Comment) {
        const allAttrs = Object.keys(attrs)
        const eventAttrs: string[] = []
        const extraAttrs: string[] = []
        for (let i = 0, l = allAttrs.length; i < l; i++) {
          const key = allAttrs[i]
          if (isOn(key)) { // 事件attr
            // remove `on`, lowercase first letter to reflect event casing accurately
            eventAttrs.push(key[2].toLowerCase() + key.slice(3))
          } else { // 普通attr
            extraAttrs.push(key)
          }
        }
        if (extraAttrs.length) {
          warn(
            `Extraneous non-props attributes (` +
              `${extraAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes.`
          )
        }
        if (eventAttrs.length) {
          warn(
            `Extraneous non-emits event listeners (` +
              `${eventAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes. ` +
              `If the listener is intended to be a component custom event listener only, ` +
              `declare it using the "emits" option.`
          )
        }
      }
    }

    // inherit scopeId
    // 继承父组件的scopeId
    // scopeId通过props的形式传入
    const parentScopeId = parent && parent.type.__scopeId
    if (parentScopeId) {
      root = cloneVNode(root, { [parentScopeId]: '' })
    }
    // inherit directives
    // 继承vnode的指令
    // root.dirs = vnode.dirs
    if (vnode.dirs) {
      if (__DEV__ && !isElementRoot(root)) {
        warn(
          `Runtime directive used on component with non-element root node. ` +
            `The directives will not function as intended.`
        )
      }
      root.dirs = vnode.dirs
    }
    // inherit transition data
    // 继承vnode的transition
    // root.transition = vnode.transition
    if (vnode.transition) {
      if (__DEV__ && !isElementRoot(root)) {
        warn(
          `Component inside <Transition> renders non-element root node ` +
            `that cannot be animated.`
        )
      }
      root.transition = vnode.transition
    }
    // inherit ref
    // 继承vnode的ref
    // root.ref = vnode.ref
    if (Component.inheritRef && vnode.ref != null) {
      root.ref = vnode.ref
    }

    // 将result更新为最新的root 根vnode
    if (__DEV__ && setRoot) {
      setRoot(root)
    } else {
      result = root
    }
  } catch (err) {
    handleError(err, instance, ErrorCodes.RENDER_FUNCTION)
    result = createVNode(Comment)
  }
  // 当前组件实例render结束，重置currentRenderingInstance为null
  currentRenderingInstance = null

  // 返回根vnode
  return result
}

const getChildRoot = (
  vnode: VNode
): [VNode, ((root: VNode) => void) | undefined] => {
  if (vnode.type !== Fragment) {
    return [vnode, undefined]
  }
  const rawChildren = vnode.children as VNodeArrayChildren
  const dynamicChildren = vnode.dynamicChildren as VNodeArrayChildren
  const children = rawChildren.filter(child => {
    return !(isVNode(child) && child.type === Comment)
  })
  if (children.length !== 1) {
    return [vnode, undefined]
  }
  const childRoot = children[0]
  const index = rawChildren.indexOf(childRoot)
  const dynamicIndex = dynamicChildren
    ? dynamicChildren.indexOf(childRoot)
    : null
  const setRoot = (updatedRoot: VNode) => {
    rawChildren[index] = updatedRoot
    if (dynamicIndex !== null) dynamicChildren[dynamicIndex] = updatedRoot
  }
  return [normalizeVNode(childRoot), setRoot]
}

const getFallthroughAttrs = (attrs: Data): Data | undefined => {
  let res: Data | undefined
  for (const key in attrs) {
    if (key === 'class' || key === 'style' || isOn(key)) {
      ;(res || (res = {}))[key] = attrs[key]
    }
  }
  return res
}

const isElementRoot = (vnode: VNode) => {
  return (
    vnode.shapeFlag & ShapeFlags.COMPONENT ||
    vnode.shapeFlag & ShapeFlags.ELEMENT ||
    vnode.type === Comment // potential v-if branch switch
  )
}

// 对比新老vnode的props和children来判断是否需要更新组件
export function shouldUpdateComponent(
  prevVNode: VNode, // 老vnode
  nextVNode: VNode, // 新vnode
  optimized?: boolean // 是否经过模板编译标志
): boolean {
  const { props: prevProps, children: prevChildren } = prevVNode
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode

  // Parent component's render function was hot-updated. Since this may have
  // caused the child component's slots content to have changed, we need to
  // force the child to update as well.
  if (__DEV__ && (prevChildren || nextChildren) && isHmrUpdating) {
    return true
  }

  // force child update for runtime directive or transition on component vnode.
  // 有自定义指令或着transition，会强制更新
  if (nextVNode.dirs || nextVNode.transition) {
    return true
  }

  // 1. 模板编译且带patchFlag，可以走快速通道
  // 2. 没有经过模板编译
  // 3. 模板编译，但没有patchFlag，说明纯静态，不需要更新，直接省去对比判断
  if (patchFlag > 0) { // 模板编译且带patchFlag，可以走快速通道
    if (patchFlag & PatchFlags.DYNAMIC_SLOTS) {
      // slot content that references values that might have changed,
      // e.g. in a v-for
      // 有动态slots，需要更新
      return true
    }
    if (patchFlag & PatchFlags.FULL_PROPS) {
      // 新老props不同，需要更新
      if (!prevProps) {
        return !!nextProps
      }
      // presence of this flag indicates props are always non-null
      return hasPropsChanged(prevProps, nextProps!)
    } else if (patchFlag & PatchFlags.PROPS) { // 1 << 3 PatchFlags.PROPS表示有部分props为动态props，且key都放在了vnode.dynamicProps中
      // 动态props不同，需要更新
      const dynamicProps = nextVNode.dynamicProps!
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i]
        if (nextProps![key] !== prevProps![key]) {
          return true
        }
      }
    }
  } else if (!optimized) { // 没有经过模板编译
    // this path is only taken by manually written render functions
    // so presence of any children leads to a forced update
    // nextChildren必须是稳定的，或者新老props相同，才不需要更新
    // 其他情况，都需要更新
    // 这里的nextChildren.$stable什么情况下才会有???

    if (prevChildren || nextChildren) {
      if (!nextChildren || !(nextChildren as any).$stable) {
        return true
      }
    }
    if (prevProps === nextProps) {
      return false
    }
    if (!prevProps) {
      return !!nextProps
    }
    if (!nextProps) {
      return true
    }
    return hasPropsChanged(prevProps, nextProps)
  }

  return false
}

// props浅比较
function hasPropsChanged(prevProps: Data, nextProps: Data): boolean {
  const nextKeys = Object.keys(nextProps)
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i]
    if (nextProps[key] !== prevProps[key]) {
      return true
    }
  }
  return false
}

// 更新父suspense.vnode.el
// 父suspense的subTree是当前suspense
// 更新父suspense.vnode.el指向当前suspense.vnode.el
// 也就是suspense.vnode.el指向的是内部第一个不为suspense的subTree.el
// updateHOCHostEl用来保证hydrateNode时的node(也就是dom)一定是与suspense内部第一个非suspense的subTree对应
export function updateHOCHostEl(
  { vnode, parent }: ComponentInternalInstance,
  el: typeof vnode.el // HostNode
) {
  // 父suspense的subTree是当前suspense
  // 更新父suspense.vnode.el指向当前suspense.vnode.el
  // 也就是suspense.vnode.el指向的是内部第一个不为suspense的subTree.el
  while (parent && parent.subTree === vnode) {
    ;(vnode = parent.vnode).el = el
    parent = parent.parent
  }
}
