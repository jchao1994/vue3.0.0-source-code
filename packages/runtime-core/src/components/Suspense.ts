import { VNode, normalizeVNode, VNodeChild, VNodeProps } from '../vnode'
import { isFunction, isArray, ShapeFlags } from '@vue/shared'
import { ComponentInternalInstance, handleSetupResult } from '../component'
import { Slots } from '../componentSlots'
import {
  RendererInternals,
  MoveType,
  SetupRenderEffectFn,
  RendererNode,
  RendererElement
} from '../renderer'
import { queuePostFlushCb, queueJob } from '../scheduler'
import { updateHOCHostEl } from '../componentRenderUtils'
import { pushWarningContext, popWarningContext } from '../warning'
import { handleError, ErrorCodes } from '../errorHandling'

export interface SuspenseProps {
  onResolve?: () => void
  onRecede?: () => void
}

export const isSuspense = (type: any): boolean => type.__isSuspense

// Suspense exposes a component-like API, and is treated like a component
// in the compiler, but internally it's a special built-in type that hooks
// directly into the renderer.
export const SuspenseImpl = {
  // In order to make Suspense tree-shakable, we need to avoid importing it
  // directly in the renderer. The renderer checks for the __isSuspense flag
  // on a vnode's type and calls the `process` method, passing in renderer
  // internals.
  __isSuspense: true,
  process(
    n1: VNode | null, // 老vnode
    n2: VNode, // 新vnode
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    optimized: boolean,
    // platform-specific impl passed from renderer
    rendererInternals: RendererInternals // internals，用于render的一些内部方法
  ) {
    if (n1 == null) { // 首次渲染
      mountSuspense(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        optimized,
        rendererInternals
      )
    } else { // 更新渲染
      patchSuspense(
        n1,
        n2,
        container,
        anchor,
        parentComponent,
        isSVG,
        optimized,
        rendererInternals
      )
    }
  },
  hydrate: hydrateSuspense
}

// Force-casted public typing for h and TSX props inference
export const Suspense = ((__FEATURE_SUSPENSE__
  ? SuspenseImpl
  : null) as any) as {
  __isSuspense: true
  new (): { $props: VNodeProps & SuspenseProps }
}

// 首次渲染suspense
// 创建suspense对象，如果先将content渲染到空的div上，suspense.deps负责记录内部异步组件的数量
// 如果内部有异步组件，suspense先渲染fallback，等到所有异步组件加载完毕，deps置0
// 再将fallback卸载，将之前渲染好的content移动到原fallback的位置
// 只对内部组件设置更新effect，自身不做更新effect，只有首次执行一次
function mountSuspense(
  n2: VNode, // 新vnode
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  optimized: boolean,
  rendererInternals: RendererInternals
) {
  const {
    p: patch,
    o: { createElement }
  } = rendererInternals
  const hiddenContainer = createElement('div')
  // 根据slots解析content和fallback，创建suspense对象并返回
  const suspense = (n2.suspense = createSuspenseBoundary(
    n2,
    parentSuspense,
    parentComponent,
    container,
    hiddenContainer,
    anchor,
    isSVG,
    optimized,
    rendererInternals
  ))

  // start mounting the content subtree in an off-dom container
  // mount content到一个空的div容器hiddenContainer中
  // 这个过程中，如果子组件有defineAsyncComponent异步组件，那么会执行suspense.registerDep
  // deps的数量代表了内部异步组件的数量，当所有异步组件加载完毕之后，deps才会置0，执行suspense.resolve
  patch(
    null,
    suspense.subTree, // content
    hiddenContainer,
    null,
    parentComponent,
    suspense, // 父suspense
    isSVG,
    optimized
  )
  // now check if we have encountered any async deps
  if (suspense.deps > 0) { // 内部有异步组件，就先patch渲染fallback
    // mount the fallback tree
    patch(
      null,
      suspense.fallbackTree,
      container,
      anchor,
      parentComponent,
      null, // fallback tree will not have suspense context
      isSVG,
      optimized
    )
    n2.el = suspense.fallbackTree.el
  } else { // 内部没有异步组件，直接执行suspense.resolve，客户端渲染一定走这里
    // Suspense has no async deps. Just resolve.
    // 卸载fallback，将之前mount在空div上的subTree移动到fallback的位置
    // 将effects推入postFlushCbs队列 或 正在pengding parent suspense的effects 中，异步更新时会执行
    // 标记isResolved，清空effects，执行onResolved回调
    suspense.resolve()
  }
}

// 更新渲染suspense，会复用老的suspense对象
// 如果老suspense还未resolve，在空的div容器hiddenContainer上更新subTree，更新fallback到实际dom中
// 等到所有异步组件加载完毕，会触发suspense的resolve
// 如果老suspense已经resolve，直接更新subTree就行了，因为suspense内部的每个组件都有自己的render effect，这里会触发更新
function patchSuspense(
  n1: VNode, // 老vnode
  n2: VNode, // 新vnode
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  isSVG: boolean,
  optimized: boolean,
  { p: patch }: RendererInternals
) {
  // 复用suspense
  const suspense = (n2.suspense = n1.suspense)!
  suspense.vnode = n2
  // 拿到新vnode的content和fallback
  const { content, fallback } = normalizeSuspenseChildren(n2)
  const oldSubTree = suspense.subTree
  const oldFallbackTree = suspense.fallbackTree
  if (!suspense.isResolved) { // 老suspense还未resolve，也就是内部异步组件还未全部加载完毕
    // 依旧先在空的div容器hiddenContainer上更新subTree
    patch(
      oldSubTree,
      content,
      suspense.hiddenContainer,
      null,
      parentComponent,
      suspense,
      isSVG,
      optimized
    )
    // 先更新fallback到实际dom中，等到所有异步组件完成的时候，会触发suspense.resolve
    // 这里由于suspense未resolve，本身suspense.deps就肯定大于0，即使新suspense没有异步组件，所以这里没有deps为0的情况
    // 之后会更新suspense.subTree和suspense.fallbackTree，所以resolve的时候一定是最新的
    if (suspense.deps > 0) {
      // still pending. patch the fallback tree.
      patch(
        oldFallbackTree,
        fallback,
        container,
        anchor,
        parentComponent,
        null, // fallback tree will not have suspense context
        isSVG,
        optimized
      )
      n2.el = fallback.el
    }
    // If deps somehow becomes 0 after the patch it means the patch caused an
    // async dep component to unmount and removed its dep. It will cause the
    // suspense to resolve and we don't need to do anything here.
  } else { // 老suspense已经resolve
    // just normal patch inner content as a fragment
    // 这里正常更新subTree就行了，因为suspense内部的每个组件都有其自己的render effect，这里会触发更新
    patch(
      oldSubTree,
      content,
      container,
      anchor,
      parentComponent,
      suspense,
      isSVG,
      optimized
    )
    n2.el = content.el
  }
  suspense.subTree = content
  suspense.fallbackTree = fallback
}

export interface SuspenseBoundary {
  vnode: VNode
  parent: SuspenseBoundary | null
  parentComponent: ComponentInternalInstance | null
  isSVG: boolean
  optimized: boolean
  container: RendererElement
  hiddenContainer: RendererElement
  anchor: RendererNode | null
  subTree: VNode
  fallbackTree: VNode
  deps: number
  isHydrating: boolean
  isResolved: boolean
  isUnmounted: boolean
  effects: Function[]
  resolve(): void
  recede(): void
  move(
    container: RendererElement,
    anchor: RendererNode | null,
    type: MoveType
  ): void
  next(): RendererNode | null
  registerDep(
    instance: ComponentInternalInstance,
    setupRenderEffect: SetupRenderEffectFn
  ): void
  unmount(parentSuspense: SuspenseBoundary | null, doRemove?: boolean): void
}

let hasWarned = false

// 根据slots解析content和fallback，创建suspense对象并返回
function createSuspenseBoundary(
  vnode: VNode, // 新vnode
  parent: SuspenseBoundary | null,
  parentComponent: ComponentInternalInstance | null,
  container: RendererElement,
  hiddenContainer: RendererElement, // 空的div
  anchor: RendererNode | null,
  isSVG: boolean,
  optimized: boolean,
  rendererInternals: RendererInternals,
  isHydrating = false
): SuspenseBoundary {
  /* istanbul ignore if */
  if (__DEV__ && !__TEST__ && !hasWarned) {
    hasWarned = true
    // @ts-ignore `console.info` cannot be null error
    console[console.info ? 'info' : 'log'](
      `<Suspense> is an experimental feature and its API will likely change.`
    )
  }

  const {
    p: patch,
    m: move,
    um: unmount,
    n: next,
    o: { parentNode }
  } = rendererInternals

  const getCurrentTree = () =>
    suspense.isResolved || suspense.isHydrating
      ? suspense.subTree
      : suspense.fallbackTree

  // 传入slot children，default作为content，fallback作为loading
  // 传入一个slot，直接作为content，没有loading
  // 返回 { content: vnode, fallback: vnode | null }
  const { content, fallback } = normalizeSuspenseChildren(vnode)
  // 创建suspense对象
  const suspense: SuspenseBoundary = {
    vnode,
    parent,
    parentComponent,
    isSVG,
    optimized,
    container,
    hiddenContainer,
    anchor,
    deps: 0,
    subTree: content, // content作为subTree
    fallbackTree: fallback,
    isHydrating,
    isResolved: false,
    isUnmounted: false,
    effects: [],

    // 卸载fallback，将之前mount在空div上的subTree移动到fallback的位置
    // 将effects推入postFlushCbs队列 或 正在pengding parent suspense的effects 中，异步更新时会执行
    // 标记isResolved，清空effects，执行onResolved回调
    resolve() {
      if (__DEV__) {
        if (suspense.isResolved) {
          throw new Error(
            `resolveSuspense() is called on an already resolved suspense boundary.`
          )
        }
        if (suspense.isUnmounted) {
          throw new Error(
            `resolveSuspense() is called on an already unmounted suspense boundary.`
          )
        }
      }
      const {
        vnode,
        subTree, // content
        fallbackTree, // fallback
        effects,
        parentComponent,
        container
      } = suspense

      if (suspense.isHydrating) { // 服务端渲染
        suspense.isHydrating = false
      } else { // 客户端渲染
        // this is initial anchor on mount
        // 位置dom
        let { anchor } = suspense
        // unmount fallback tree
        // mount过fallbackTree，这里需要做卸载
        if (fallbackTree.el) {
          // if the fallback tree was mounted, it may have been moved
          // as part of a parent suspense. get the latest anchor for insertion
          anchor = next(fallbackTree)
          // 卸载fallbackTree
          unmount(fallbackTree, parentComponent, suspense, true)
        }
        // move content from off-dom container to actual container
        // 将之前mount的空div上的subTree移动到fallbackTree的位置
        move(subTree, container, anchor, MoveType.ENTER)
      }

      const el = (vnode.el = subTree.el!)
      // suspense as the root node of a component...
      // 更新父suspense.vnode.el
      // 父suspense的subTree是当前suspense
      // 更新父suspense.vnode.el指向当前suspense.vnode.el
      // 也就是suspense.vnode.el指向的是内部第一个不为suspense的subTree.el
      if (parentComponent && parentComponent.subTree === vnode) {
        parentComponent.vnode.el = el
        // 更新父suspense.vnode.el
        // 父suspense的subTree是当前suspense
        // 更新父suspense.vnode.el指向当前suspense.vnode.el
        // 也就是suspense.vnode.el指向的是内部第一个不为suspense的subTree.el
        updateHOCHostEl(parentComponent, el)
      }
      // check if there is a pending parent suspense
      let parent = suspense.parent
      let hasUnresolvedAncestor = false
      // 向上找正在pending的parent suspense，找到就合并effects到parent.effects上
      while (parent) {
        // parent没有resolve完成，也就是一个pending的parent suspense
        // 将当前suspense的effects推入parent.effects中
        if (!parent.isResolved) {
          // found a pending parent suspense, merge buffered post jobs
          // into that parent
          parent.effects.push(...effects)
          hasUnresolvedAncestor = true
          break
        }
        parent = parent.parent
      }
      // no pending parent suspense, flush all jobs
      // 没有正在pending的parent suspense，直接将当前suspense的effects推入postFlushCbs队列，等待异步更新时执行
      // 如果找到了正在pending的parent suspense，这里就不推入postFlushCbs队列，等到这个parent suspense时再推入
      if (!hasUnresolvedAncestor) {
        queuePostFlushCb(effects)
      }
      // 标志suspense resolve完成
      suspense.isResolved = true
      // 清空effects
      suspense.effects = []
      // invoke @resolve event
      // 给suspense传入的onResolve回调在这里执行
      const onResolve = vnode.props && vnode.props.onResolve
      if (isFunction(onResolve)) {
        onResolve()
      }
    },

    // 回退
    // 将subTree重新移动到空的div容器hiddenContainer上
    // 重新mount fallback
    // 完成之后执行onRecede回调
    recede() {
      suspense.isResolved = false
      const {
        vnode,
        subTree,
        fallbackTree,
        parentComponent,
        container,
        hiddenContainer,
        isSVG,
        optimized
      } = suspense

      // move content tree back to the off-dom container
      const anchor = next(subTree)
      move(subTree, hiddenContainer, null, MoveType.LEAVE)
      // remount the fallback tree
      patch(
        null,
        fallbackTree,
        container,
        anchor,
        parentComponent,
        null, // fallback tree will not have suspense context
        isSVG,
        optimized
      )
      const el = (vnode.el = fallbackTree.el!)
      // suspense as the root node of a component...
      if (parentComponent && parentComponent.subTree === vnode) {
        parentComponent.vnode.el = el
        updateHOCHostEl(parentComponent, el)
      }

      // invoke @recede event
      const onRecede = vnode.props && vnode.props.onRecede
      if (isFunction(onRecede)) {
        onRecede()
      }
    },

    // 移动当前渲染的内容(content/fallback)
    move(container, anchor, type) {
      move(getCurrentTree(), container, anchor, type)
      suspense.container = container
    },

    // 当前渲染的内容(content/fallback)的下一个兄弟dom
    next() {
      return next(getCurrentTree())
    },

    // instance是suspense内部的defineAsyncComponent异步组件
    // 在异步组件未加载完成之前suspense.deps加1，在加载完成执行promise.then时suspense.deps减1
    // 只要有异步组件，suspense一开始的deps一定大于0，所以会先渲染fallback
    // 等到所有的异步组件加载完成，deps为0，这时suspense会执行resolve，卸载fallback，将渲染在空div上的content移动到原fallback的位置
    // 这个registerDep方法，只会在首次mount的时候执行一次
    registerDep(instance, setupRenderEffect) {
      // suspense is already resolved, need to recede.
      // use queueJob so it's handled synchronously after patching the current
      // suspense tree
      // suspense已经resolved，需要回退
      // 将subTree重新移动到空的div容器hiddenContainer上
      // 重新mount fallback
      // 完成之后执行onRecede回调
      // 什么情况下，这里会已经resolved???
      if (suspense.isResolved) {
        queueJob(() => {
          suspense.recede()
        })
      }

      // 什么情况下会有这个hydratedEl???
      // 服务端渲染返回的html???
      const hydratedEl = instance.vnode.el
      // dep加1，等到promise.then再减1
      suspense.deps++
      // instance.asyncDep就是promise形式的setupResult
      // 这里promise内部完成异步加载组件，然后把组件选项封装成一个 生成初始vnode 的render函数
      instance
        .asyncDep!.catch(err => {
          handleError(err, instance, ErrorCodes.SETUP_FUNCTION)
        })
        // asyncSetupResult是 生成初始vnode 的render函数
        .then(asyncSetupResult => {
          // retry when the setup() promise resolves.
          // component may have been unmounted before resolve.
          if (instance.isUnmounted || suspense.isUnmounted) {
            return
          }
          // 加载完成，dep减1
          suspense.deps--
          // retry from this component
          instance.asyncResolved = true
          // 首次渲染，这里的vnode应该为instance的初始vnode
          const { vnode } = instance
          if (__DEV__) {
            pushWarningContext(vnode)
          }
          // 将render函数放在instance.render上
          handleSetupResult(instance, asyncSetupResult, false)
          if (hydratedEl) {
            // vnode may have been replaced if an update happened before the
            // async dep is resolved.
            // 在异步加载完成之前如果有更新，这里vnode.el会发生改变，所以要设置到原来的值hydratedEl
            vnode.el = hydratedEl
          }
          // instance.update 首次mount / 更新渲染
          setupRenderEffect(
            instance,
            vnode,
            // component may have been moved before resolve.
            // if this is not a hydration, instance.subTree will be the comment
            // placeholder.
            // container
            hydratedEl
              ? parentNode(hydratedEl)!
              : parentNode(instance.subTree.el!)!, // 创建的占位注释节点的父节点
            // anchor will not be used if this is hydration, so only need to
            // consider the comment placeholder case.
            // anchor
            hydratedEl ? null : next(instance.subTree), // 创建的占位注释节点的下一个兄弟dom
            suspense,
            isSVG,
            optimized
          )
          // 更新父suspense.vnode.el
          // 父suspense的subTree是当前suspense
          // 更新父suspense.vnode.el指向当前suspense.vnode.el
          // 也就是suspense.vnode.el指向的是内部第一个不为suspense的subTree.el
          updateHOCHostEl(instance, vnode.el)
          if (__DEV__) {
            popWarningContext()
          }
          // suspense的所有异步组件都加载完了，执行suspense.resolve
          // 卸载fallback，将之前mount在空div上的subTree移动到fallback的位置
          // 将effects推入postFlushCbs队列 或 正在pengding parent suspense的effects 中，异步更新时会执行
          // 标记isResolved，清空effects，执行onResolved回调
          if (suspense.deps === 0) {
            suspense.resolve()
          }
        })
    },

    // 卸载suspense
    unmount(parentSuspense, doRemove) {
      suspense.isUnmounted = true
      // 卸载subTree
      unmount(suspense.subTree, parentComponent, parentSuspense, doRemove)
      // 如果suspense还未resolve，就需要卸载fallbackTree
      if (!suspense.isResolved) {
        unmount(
          suspense.fallbackTree,
          parentComponent,
          parentSuspense,
          doRemove
        )
      }
    }
  }

  return suspense
}

// SSR混合hydrateNode中的suspense，在hydate混合过程中处理suspense
// renderToString应该完整处理了suspense，也就是页面一定有内容subTree或fallback，不急着做页面更新
// 所以suspense这里的状态只有 成功的subTree 或 失败的fallback，没有 进行中的fallback
// 所以直接混合新的subTree就可以，如果有异步组件，会直接跳过，等待加载完毕后再做处理
function hydrateSuspense(
  node: Node, // 老dom节点
  vnode: VNode, // 新vnode
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null, // 父suspense，不是自身suspense
  isSVG: boolean,
  optimized: boolean,
  rendererInternals: RendererInternals,
  hydrateNode: (
    node: Node,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  /* eslint-disable no-restricted-globals */
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    node.parentNode!,
    document.createElement('div'),
    null,
    isSVG,
    optimized,
    rendererInternals,
    true /* hydrating */
  ))
  // there are two possible scenarios for server-rendered suspense:
  // - success: ssr content should be fully resolved
  // - failure: ssr content should be the fallback branch.
  // however, on the client we don't really know if it has failed or not
  // attempt to hydrate the DOM assuming it has succeeded, but we still
  // need to construct a suspense boundary first
  // hydrate过程中也会加载异步组件，修改suspense.deps
  // result指向下一个老dom
  // 这里即使node是fallback，也直接混合subTree，需要看一下renderToString中如何处理suspense的???
  // renderToString中应该会完成整个suspense，如果这里还是fallback，说明异步加载组件失败了，这里也是直接混合subTree???
  // updateHOCHostEl保证这里的node一定对应的是suspense内部第一个非suspense的subTree
  // 也就是如果是嵌套的suspense，那么每个suspense的node都指向同一个dom，而subTree会层层往下取，直到第一个非suspense的subTree
  const result = hydrateNode(
    node,
    suspense.subTree,
    parentComponent,
    suspense,
    optimized
  )
  if (suspense.deps === 0) {
    suspense.resolve()
  }
  return result
  /* eslint-enable no-restricted-globals */
}

// 传入slot children，default作为content，fallback作为loading
// 传入一个slot，直接作为content，没有loading
// 返回 { content: vnode, fallback: vnode | null }
export function normalizeSuspenseChildren(
  vnode: VNode
): {
  content: VNode
  fallback: VNode
} {
  const { shapeFlag, children } = vnode
  if (shapeFlag & ShapeFlags.SLOTS_CHILDREN) {// 传入slot children，default作为content，fallback作为loading
    const { default: d, fallback } = children as Slots
    return {
      content: normalizeVNode(isFunction(d) ? d() : d),
      fallback: normalizeVNode(isFunction(fallback) ? fallback() : fallback)
    }
  } else { // 传入一个slot，直接作为content，没有loading
    return {
      content: normalizeVNode(children as VNodeChild),
      fallback: normalizeVNode(null)
    }
  }
}

export function queueEffectWithSuspense(
  fn: Function | Function[],
  suspense: SuspenseBoundary | null
): void {
  if (suspense && !suspense.isResolved) {
    if (isArray(fn)) {
      suspense.effects.push(...fn)
    } else {
      suspense.effects.push(fn)
    }
  } else {
    queuePostFlushCb(fn)
  }
}
