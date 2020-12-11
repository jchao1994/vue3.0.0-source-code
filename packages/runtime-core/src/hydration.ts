import {
  VNode,
  normalizeVNode,
  Text,
  Comment,
  Static,
  Fragment,
  VNodeHook
} from './vnode'
import { flushPostFlushCbs } from './scheduler'
import { ComponentOptions, ComponentInternalInstance } from './component'
import { invokeDirectiveHook } from './directives'
import { warn } from './warning'
import { PatchFlags, ShapeFlags, isReservedProp, isOn } from '@vue/shared'
import { RendererInternals, invokeVNodeHook, setRef } from './renderer'
import {
  SuspenseImpl,
  SuspenseBoundary,
  queueEffectWithSuspense
} from './components/Suspense'
import { TeleportImpl } from './components/Teleport'

export type RootHydrateFunction = (
  vnode: VNode<Node, Element>,
  container: Element
) => void

const enum DOMNodeTypes {
  ELEMENT = 1,
  TEXT = 3,
  COMMENT = 8
}

let hasMismatch = false

const isSVGContainer = (container: Element) =>
  /svg/.test(container.namespaceURI!) && container.tagName !== 'foreignObject'

const isComment = (node: Node): node is Comment =>
  node.nodeType === DOMNodeTypes.COMMENT

// Note: hydration is DOM-specific
// But we have to place it in core due to tight coupling with core - splitting
// it out creates a ton of unnecessary complexity.
// Hydration also depends on some renderer internal logic which needs to be
// passed in via arguments.
// 将hydration放在runtime-core里面，可以避免不必要的复杂性
// hydration依赖一些客户端渲染render中的一些方法rendererInternals
// 包括patch unmount move remove mountComponent mountChildren 
// patchChildren patchBlockChildren getNextHostNode rendererOptions
// 其中rendererOptions就是 patchProp(处理class、style、onXXX等节点属性) 和 nodeOps(封装insert、remove等DOM节点操作)
// 这个函数的返回值是 [hydrate, hydrateNode] ，其中的 hydrate 就是服务端渲染的混合方法
export function createHydrationFunctions(
  rendererInternals: RendererInternals<Node, Element> // internals
) {
  const {
    mt: mountComponent,
    p: patch,
    o: { patchProp, nextSibling, parentNode, remove, insert, createComment }
  } = rendererInternals

  const hydrate: RootHydrateFunction = (vnode, container) => {
    // 走到这里的container是服务端渲染返回的根html，只有页面结构，需要在hydrate中由vue接管交互逻辑
    // 所以这里不需要重新生成页面结构，可以复用

    // dev模式下，服务端渲染失败，会走客户端渲染直接mount
    if (__DEV__ && !container.hasChildNodes()) {
      warn(
        `Attempting to hydrate existing markup but container is empty. ` +
          `Performing full mount instead.`
      )
      patch(null, vnode, container)
      return
    }
    hasMismatch = false
    hydrateNode(container.firstChild!, vnode, null, null)
    flushPostFlushCbs()
    if (hasMismatch && !__TEST__) {
      // this error should show up in production
      console.error(`Hydration completed but contains mismatches.`)
    }
  }

  const hydrateNode = (
    node: Node, // 老dom节点
    vnode: VNode, // 新vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized = false
  ): Node | null => {
    // fragment对应的dom实际上一个一组data分别为 [ 和 ]的注释dom
    // []中间部分即为fragment的子节点，也就是内容
    const isFragmentStart = isComment(node) && node.data === '['
    // 混合匹配失败，移除所有[]内的dom以及头尾注释dom，也就是移除fragment的内容
    // 针对这个vnode重新走客户端渲染render，直接mount
    // 返回实际的位置dom，也就是anchor
    const onMismatch = () =>
      handleMismtach(
        node,
        vnode,
        parentComponent,
        parentSuspense,
        isFragmentStart
      )

    const { type, ref, shapeFlag } = vnode
    // 只读属性nodeType
    // 1 元素节点
    // 2 属性节点
    // 3 文本节点
    // 8 注释节点
    const domType = node.nodeType
    vnode.el = node

    let nextNode: Node | null = null
    // 根据type，走不同的混合逻辑
    switch (type) {
      case Text: // 文本vnode
        if (domType !== DOMNodeTypes.TEXT) { // 文本类型匹配失败，走客户端渲染
          nextNode = onMismatch()
        } else { // 文本类型匹配成功

          // 文本内容匹配失败，但这里不走客户端渲染
          // 直接修改文本内容
          if ((node as Text).data !== vnode.children) {
            // 标记匹配失败
            hasMismatch = true
            __DEV__ &&
              warn(
                `Hydration text mismatch:` +
                  `\n- Client: ${JSON.stringify((node as Text).data)}` +
                  `\n- Server: ${JSON.stringify(vnode.children)}`
              )
            ;(node as Text).data = vnode.children as string
          }
          // 下一个dom节点
          nextNode = nextSibling(node)
        }
        break
      case Comment: // 注释vnode
        if (domType !== DOMNodeTypes.COMMENT || isFragmentStart) {
          // 注释节点类型匹配失败，这个节点走客户端渲染
          nextNode = onMismatch()
        } else {
          // 注释节点类型匹配成功，直接下一个dom
          // 注释节点的内容不会改变
          nextNode = nextSibling(node)
        }
        break
      case Static: // 静态vnode
        if (domType !== DOMNodeTypes.ELEMENT) {
          // 静态vnode只能对应元素节点，否则直接走客户端渲染
          nextNode = onMismatch()
        } else {
          // determine anchor, adopt content
          nextNode = node
          // if the static vnode has its content stripped during build,
          // adopt it from the server-rendered HTML.
          const needToAdoptContent = !(vnode.children as string).length
          // vnode.staticCount是什么???
          // 所有静态节点的outerHTML组成了这个vnode的children
          // 跳过这些静态节点，继续下一个dom
          for (let i = 0; i < vnode.staticCount; i++) {
            if (needToAdoptContent)
              vnode.children += (nextNode as Element).outerHTML
            if (i === vnode.staticCount - 1) {
              vnode.anchor = nextNode
            }
            nextNode = nextSibling(nextNode)!
          }
          return nextNode
        }
        break
      case Fragment: // fragment
        if (!isFragmentStart) { // fragment类型匹配失败，走客户端渲染
          nextNode = onMismatch()
        } else { // fragment类型匹配成功
          // 混合fragment，返回下一个需要混合的dom
          nextNode = hydrateFragment(
            node as Comment, // 开头注释dom，data为 [ ，也就是<--[-->
            vnode,
            parentComponent,
            parentSuspense,
            optimized
          )
        }
        break
      default:
        if (shapeFlag & ShapeFlags.ELEMENT) { // dom标签vnode
          if (
            domType !== DOMNodeTypes.ELEMENT ||
            vnode.type !== (node as Element).tagName.toLowerCase()
          ) { // 节点类型 或 标签类型 匹配失败，走客户端渲染
            nextNode = onMismatch()
          } else {
            // 混合dom元素节点
            // 这里会添加事件，执行onBeforeMount生命周期，并将onMounted生命周期推入postFlushCbs队列，等到异步更新时执行
            // 递归混合children(数组children)，或是替换文本(文本children)
            nextNode = hydrateElement(
              node as Element,
              vnode,
              parentComponent,
              parentSuspense,
              optimized
            )
          }
        } else if (shapeFlag & ShapeFlags.COMPONENT) { // 组件，包括有状态组件(常规vue文件)和无状态组件(函数组件)
          // when setting up the render effect, if the initial vnode already
          // has .el set, the component will perform hydration instead of mount
          // on its sub-tree.
          // 设置render effect时，如果初始化的vnode已经有了el属性，说明经过了服务端渲染
          // 这样就会在sub-tree上用混合hydration代替mount

          // 父容器
          const container = parentNode(node)!
          // 混合component，内部就是mountComponent
          const hydrateComponent = () => {
            mountComponent(
              vnode,
              container,
              null,
              parentComponent,
              parentSuspense,
              isSVGContainer(container),
              optimized
            )
          }
          // async component
          // 异步组件，加载完毕再进行hydrate混合
          // defineAsyncComponent异步组件的组件选项是{ __asyncLoader: load, name: 'AsyncComponentWrapper', setup: function }
          // __asyncLoader指向load方法，返回组件选项或者构造函数
          // 这里的hydrateComponent不需要接收参数
          // 因为load完成之后，内部闭包有个resolvedComp会指向加载完成组件
          // 这个异步组件执行setup的时候会返回 生成resolvedComp对应的初始vnode 的render函数
          // 这里相当于异步加载完成才进行渲染，自然loading和error组件不会生效
          // 因为服务端渲染返回的html已经有了对应的dom，不需要再显示loading或者error了
          const loadAsync = (vnode.type as ComponentOptions).__asyncLoader
          if (loadAsync) {
            loadAsync().then(hydrateComponent)
          } else {
            hydrateComponent()
          }
          // component may be async, so in the case of fragments we cannot rely
          // on component's rendered output to determine the end of the fragment
          // instead, we do a lookahead to find the end anchor node.
          // 由于组件可能是异步的，所以fragment不能依赖组件的混合结果，这里用查到的方式来找到结尾的anchor dom
          // 非fragment的情况，都是一一对应混合，所以不用知道混合结果，也就不用做特殊处理了

          nextNode = isFragmentStart
            // 找到[]后的第一个dom返回，也就是跳过整个fragment
            ? locateClosingAsyncAnchor(node)
            : nextSibling(node) // 非fragment，直接返回下一个dom继续混合
        } else if (shapeFlag & ShapeFlags.TELEPORT) { // teleport
          if (domType !== DOMNodeTypes.COMMENT) {
            nextNode = onMismatch()
          } else {
            nextNode = (vnode.type as typeof TeleportImpl).hydrate(
              node,
              vnode,
              parentComponent,
              parentSuspense,
              optimized,
              rendererInternals,
              hydrateChildren
            )
          }
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) { // suspense
          nextNode = (vnode.type as typeof SuspenseImpl).hydrate(
            node,
            vnode,
            parentComponent,
            parentSuspense,
            isSVGContainer(parentNode(node)!),
            optimized,
            rendererInternals,
            hydrateNode
          )
        } else if (__DEV__) {
          warn('Invalid HostVNode type:', type, `(${typeof type})`)
        }
    }

    // set ref
    // 清除老的ref，根据vnode和ref不同语法设置新的ref
    // ref依赖于hydrate完的dom或者组件实例，所以设置ref的操作放在hydrate完成之后
    if (ref != null && parentComponent) {
      setRef(ref, null, parentComponent, vnode)
    }

    return nextNode
  }

  // 混合dom元素节点
  // 这里会添加事件，执行onBeforeMount生命周期，并将onMounted生命周期推入postFlushCbs队列，等到异步更新时执行
  // 递归混合children(数组children)，或是替换文本(文本children)
  const hydrateElement = (
    el: Element, // 老dom
    vnode: VNode, // 新vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean
  ) => {
    // 是否经过模板编译
    // 原optimized可以手动传入
    // dynamicChildren是经过模板编译生成的
    optimized = optimized || !!vnode.dynamicChildren
    const { props, patchFlag, shapeFlag, dirs } = vnode
    // skip props & children if this is hoisted static nodes
    // PatchFlags.HOISTED标记代表静态节点???
    if (patchFlag !== PatchFlags.HOISTED) {
      // props
      // 添加事件逻辑
      // 由于服务端渲染不处理交互逻辑，所以事件直接添加
      // 这里有一点优化是把点击事件单独处理，会提高只有点击事件时的性能
      if (props) {
        if (
          !optimized ||
          (patchFlag & PatchFlags.FULL_PROPS || // 1 << 4
            patchFlag & PatchFlags.HYDRATE_EVENTS) // 1 << 5
        ) {
          for (const key in props) {
            // on开头事件，非生命周期
            // 由于服务端渲染不处理交互逻辑，所以事件直接添加
            if (!isReservedProp(key) && isOn(key)) {
              patchProp(el, key, null, props[key])
            }
          }
        } else if (props.onClick) {
          // Fast path for click listeners (which is most often) to avoid
          // iterating through props.
          // 将最常见的点击事件单独放在props.onClick
          // 这样在只有点击事件的情况下，不会去遍历props，一般情况下可以提高性能
          patchProp(el, 'onClick', null, props.onClick)
        }
      }
      // vnode / directive hooks
      // 执行onBeforeMount生命周期
      let vnodeHooks: VNodeHook | null | undefined
      if ((vnodeHooks = props && props.onVnodeBeforeMount)) {
        invokeVNodeHook(vnodeHooks, parentComponent, vnode)
      }
      // 执行自定义指令的beforeMount
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
      }
      // 将onMounted生命周期和自定义指令的mounted推入postFlushCbs队列，等到异步更新时执行
      if ((vnodeHooks = props && props.onVnodeMounted) || dirs) {
        queueEffectWithSuspense(() => {
          vnodeHooks && invokeVNodeHook(vnodeHooks, parentComponent, vnode)
          dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
        }, parentSuspense)
      }
      // children
      if (
        shapeFlag & ShapeFlags.ARRAY_CHILDREN && // 1 << 4 数组children
        // skip if element has innerHTML / textContent
        !(props && (props.innerHTML || props.textContent)) // 跳过带innerHTML和textContent的情况
      ) {
        // 递归混合children，对每一对child dom和vnode进行hydrateNode
        // 正常返回的next为null，如果有next，说明原dom多了
        let next = hydrateChildren(
          el.firstChild,
          vnode,
          el,
          parentComponent,
          parentSuspense,
          optimized
        )
        let hasWarned = false
        // 把原dom结构中多的dom节点都移除
        while (next) {
          hasMismatch = true
          if (__DEV__ && !hasWarned) {
            warn(
              `Hydration children mismatch in <${vnode.type as string}>: ` +
                `server rendered element contains more child nodes than client vdom.`
            )
            hasWarned = true
          }
          // The SSRed DOM contains more nodes than it should. Remove them.
          const cur = next
          next = next.nextSibling
          remove(cur)
        }
      } else if (shapeFlag & ShapeFlags.TEXT_CHILDREN) { // 1 << 3 文本children
        // 文本内容不匹配，但这里不走客户端渲染，直接替换文本
        if (el.textContent !== vnode.children) {
          hasMismatch = true
          __DEV__ &&
            warn(
              `Hydration text content mismatch in <${vnode.type as string}>:\n` +
                `- Client: ${el.textContent}\n` +
                `- Server: ${vnode.children as string}`
            )
          el.textContent = vnode.children as string
        }
      }
    }
    // 返回下一个dom继续混合
    return el.nextSibling
  }

  // 递归混合children
  // 对每一对child dom和vnode进行hydrateNode
  // 对不匹配(vnode多了)的情况走客户端渲染，直接mount
  const hydrateChildren = (
    node: Node | null, // 对应vnode的第一个child vnode
    vnode: VNode, // 新的父vnode
    container: Element, // 父容器dom
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean
  ): Node | null => {
    // 是否经过模板编译
    // 原optimized可以手动传入
    // dynamicChildren是经过模板编译生成的
    optimized = optimized || !!vnode.dynamicChildren
    const children = vnode.children as VNode[]
    const l = children.length
    let hasWarned = false
    for (let i = 0; i < l; i++) {
      const vnode = optimized
        ? children[i]
        : (children[i] = normalizeVNode(children[i]))
      if (node) { // 对每一对child node和vnode走混合逻辑，返回下一个node
        node = hydrateNode(
          node,
          vnode,
          parentComponent,
          parentSuspense,
          optimized
        )
      } else { // 没有对应dom节点，匹配失败，走客户端渲染
        hasMismatch = true
        if (__DEV__ && !hasWarned) {
          warn(
            `Hydration children mismatch in <${container.tagName.toLowerCase()}>: ` +
              `server rendered element contains fewer child nodes than client vdom.`
          )
          hasWarned = true
        }
        // the SSRed DOM didn't contain enough nodes. Mount the missing ones.
        patch(
          null,
          vnode,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVGContainer(container)
        )
      }
    }
    return node
  }

  // 混合fragment，返回下一个需要混合的dom
  const hydrateFragment = (
    node: Comment, // 老dom节点
    vnode: VNode, // 新vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean
  ) => {
    // 父容器dom
    const container = parentNode(node)!
    // 正常递归混合完children，这里会返回fragment的结束dom，也就是data为 ] 的注释dom
    const next = hydrateChildren(
      nextSibling(node)!, // fragment实际内容的第一个dom节点
      vnode,
      container,
      parentComponent,
      parentSuspense,
      optimized
    )
    if (next && isComment(next) && next.data === ']') {
      // next为fragment结束dom，直接返回下一个dom，继续混合过程
      return nextSibling((vnode.anchor = next))
    } else {
      // fragment didn't hydrate successfully, since we didn't get a end anchor
      // back. This should have led to node/children mismatch warnings.
      // next不是fragment的结束dom，说明丢失了结束dom
      // 这里直接添加一个data为 ] 的注释dom，当作fragment的结束dom
      // 而这个next就是下一个需要混合的dom

      hasMismatch = true
      // since the anchor is missing, we need to create one and insert it
      insert((vnode.anchor = createComment(`]`)), container, next)
      return next
    }
  }

  // 混合匹配失败，移除所有[]内的dom以及头尾注释dom，也就是移除fragment的内容
  // 针对这个vnode重新走客户端渲染render，直接mount
  // 返回实际的位置dom，也就是anchor
  const handleMismtach = (
    node: Node, // 老dom节点
    vnode: VNode, // 新vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isFragment: boolean // 是否fragment
  ): Node | null => {
    // 标记丢失匹配
    hasMismatch = true
    __DEV__ &&
      warn(
        `Hydration node mismatch:\n- Client vnode:`,
        vnode.type,
        `\n- Server rendered DOM:`,
        node,
        node.nodeType === DOMNodeTypes.TEXT
          ? `(text)`
          : isComment(node) && node.data === '['
            ? `(start of fragment)`
            : ``
      )
    vnode.el = null

    // 移除开头[]内的所有dom以及结束注释dom
    // 也就是移除fragment的内容
    if (isFragment) {
      // remove excessive fragment nodes
      // 找到[]后的第一个node
      const end = locateClosingAsyncAnchor(node)
      // 移除[]内的所有node
      while (true) {
        const next = nextSibling(node)
        if (next && next !== end) {
          remove(next)
        } else {
          break
        }
      }
    }

    // 此时已经删除所有[]，next指向实际的位置dom
    const next = nextSibling(node)
    const container = parentNode(node)!
    // 移除开头注释dom(fragment) 或 正常的dom(非fragment)
    remove(node)

    // 走客户端渲染逻辑，直接mount
    patch(
      null,
      vnode,
      container,
      next,
      parentComponent,
      parentSuspense,
      isSVGContainer(container)
    )
    return next
  }

  // 找到[]后的第一个dom返回，也就是跳过整个fragment
  const locateClosingAsyncAnchor = (node: Node | null): Node | null => {
    let match = 0
    while (node) {
      node = nextSibling(node)
      if (node && isComment(node)) {
        if (node.data === '[') match++
        if (node.data === ']') {
          if (match === 0) {
            return nextSibling(node)
          } else {
            match--
          }
        }
      }
    }
    return node
  }

  return [hydrate, hydrateNode] as const
}
