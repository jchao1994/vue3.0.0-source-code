import {
  NodeTransform,
  NodeTypes,
  ElementTypes,
  createCallExpression,
  resolveComponentType,
  buildProps,
  ComponentNode,
  SlotFnBuilder,
  createFunctionExpression,
  buildSlots,
  FunctionExpression,
  TemplateChildNode,
  TELEPORT,
  createIfStatement,
  createSimpleExpression,
  getBaseTransformPreset,
  DOMNodeTransforms,
  DOMDirectiveTransforms,
  createReturnStatement,
  ReturnStatement,
  Namespaces,
  locStub,
  RootNode,
  TransformContext,
  CompilerOptions,
  TransformOptions,
  createRoot,
  createTransformContext,
  traverseNode,
  ExpressionNode,
  TemplateNode,
  SUSPENSE,
  TRANSITION_GROUP
} from '@vue/compiler-dom'
import { SSR_RENDER_COMPONENT } from '../runtimeHelpers'
import {
  SSRTransformContext,
  processChildren,
  processChildrenAsStatement
} from '../ssrCodegenTransform'
import { ssrProcessTeleport } from './ssrTransformTeleport'
import {
  ssrProcessSuspense,
  ssrTransformSuspense
} from './ssrTransformSuspense'
import { isSymbol, isObject, isArray } from '@vue/shared'

// We need to construct the slot functions in the 1st pass to ensure proper
// scope tracking, but the children of each slot cannot be processed until
// the 2nd pass, so we store the WIP slot functions in a weakmap during the 1st
// pass and complete them in the 2nd pass.
const wipMap = new WeakMap<ComponentNode, WIPSlotEntry[]>()

interface WIPSlotEntry {
  fn: FunctionExpression
  children: TemplateChildNode[]
  vnodeBranch: ReturnStatement
}

const componentTypeMap = new WeakMap<ComponentNode, symbol>()

// ssr component transform is done in two phases:
// In phase 1. we use `buildSlot` to analyze the children of the component into
// WIP slot functions (it must be done in phase 1 because `buildSlot` relies on
// the core transform context).
// In phase 2. we convert the WIP slots from phase 1 into ssr-specific codegen
// nodes.
// 组件
// 返回onExit函数，处理v-slot以及children，对每一个v-slot做一份失败备用分支，最后生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
export const ssrTransformComponent: NodeTransform = (node, context) => {
  if (
    node.type !== NodeTypes.ELEMENT ||
    node.tagType !== ElementTypes.COMPONENT
  ) {
    return
  }

  // 解析组件的name
  // 动态组件，返回 is | v-is 对应的type为 NodeTypes.JS_CALL_EXPRESSION 的对象
  // 内建组件，找到内置名字直接返回
  // 自定义组件，返回 _component_${tag}
  const component = resolveComponentType(node, context, true /* ssr */)
  if (isSymbol(component)) { // 内建组件
    componentTypeMap.set(node, component)
    if (component === SUSPENSE) { // suspense，暂时不看???
      return ssrTransformSuspense(node, context)
    }
    return // built-in component: fallthrough
  }

  // Build the fallback vnode-based branch for the component's slots.
  // We need to clone the node into a fresh copy and use the buildSlots' logic
  // to get access to the children of each slot. We then compile them with
  // a child transform pipeline using vnode-based transforms (instead of ssr-
  // based ones), and save the result branch (a ReturnStatement) in an array.
  // The branch is retrieved when processing slots again in ssr mode.
  const vnodeBranches: ReturnStatement[] = []
  // 克隆node
  const clonedNode = clone(node)

  // 返回onExit函数，处理v-slot以及children，对每一个v-slot做一份失败备用分支，最后生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
  return function ssrPostTransformComponent() {
    // Using the cloned node, build the normal VNode-based branches (for
    // fallback in case the child is render-fn based). Store them in an array
    // for later use.
    if (clonedNode.children.length) {
      // 处理自身v-slot以及children的v-slot，返回处理后的{ slots, hasDynamicSlots }，这里不需要返回值，仅仅用于生成失败备用分支???
      // 只有静态插槽内容slotsProperties => slots为NodeTypes.JS_OBJECT_EXPRESSION
      // 有动态插槽内容dynamicSlots => slots为NodeTypes.JS_CALL_EXPRESSION，其arguments有NodeTypes.JS_OBJECT_EXPRESSION和NodeTypes.JS_ARRAY_EXPRESSION
      // 每一个v-slot都做一份失败备用分支(NodeTypes.JS_RETURN_STATEMENT)，放在vnodeBranches中，这个失败备用分支走正常客户端render，而不是ssr
      buildSlots(clonedNode, context, (props, children) => {
        // 给插槽包裹一个带v-slot属性的template标签，进行客户端编译的traverse，返回NodeTypes.JS_RETURN_STATEMENT
        // 这里是作为失败备用分支的，所以走正常客户端render，而不是ssr
        vnodeBranches.push(createVNodeSlotBranch(props, children, context))
        // 返回空的NodeTypes.JS_FUNCTION_EXPRESSION
        return createFunctionExpression(undefined)
      })
    }

    // NodeTypes.JS_OBJECT_EXPRESSION
    const props =
      node.props.length > 0
        ? // note we are not passing ssr: true here because for components, v-on
          // handlers should still be passed
          // 对于组件来说，v-on还是需要处理的
          // 分析所有属性，根据属性是否动态，以及属性名动态还是属性值动态，进行标记
          // 返回 
          //    { props: propsExpression, // 分析完成的属性对象 NodeTypes.JS_OBJECT_EXPRESSION
          //      directives: runtimeDirectives, // 需要runtime的指令
          //      patchFlag, // patch标志，用于优化
          //      dynamicPropNames // 动态属性，用于优化
          //    }
          buildProps(node, context).props || `null`
        : `null`

    const wipEntries: WIPSlotEntry[] = []
    wipMap.set(node, wipEntries)

    // 对每一个v-slot都创建NodeTypes.JS_FUNCTION_EXPRESSION，连同children和对应的vnodeBranch推入wipEntries
    const buildSSRSlotFn: SlotFnBuilder = (props, children, loc) => {
      // NodeTypes.JS_FUNCTION_EXPRESSION
      const fn = createFunctionExpression(
        [props || `_`, `_push`, `_parent`, `_scopeId`],
        undefined, // no return, assign body later
        true, // newline
        true, // isSlot
        loc
      )
      wipEntries.push({
        fn,
        children,
        // also collect the corresponding vnode branch built earlier
        // 对应的vnodeBranch
        vnodeBranch: vnodeBranches[wipEntries.length]
      })
      return fn
    }

    // 处理自身v-slot以及children的v-slot，返回处理后的{ slots, hasDynamicSlots }
    // 只有静态插槽内容slotsProperties => slots为NodeTypes.JS_OBJECT_EXPRESSION
    // 有动态插槽内容dynamicSlots => slots为NodeTypes.JS_CALL_EXPRESSION，其arguments有NodeTypes.JS_OBJECT_EXPRESSION和NodeTypes.JS_ARRAY_EXPRESSION
    // 每一个v-slot都创建NodeTypes.JS_FUNCTION_EXPRESSION，连同children和对应的vnodeBranch推入wipEntries
    const slots = node.children.length
      ? buildSlots(node, context, buildSSRSlotFn).slots
      : `null`

    // 生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
    // <test v-slot="xxx">aaa</test>
    // =>
    // _ssrRenderComponent(_component_test, null, {
    //   default: _withCtx((xxx, _push, _parent, _scopeId) => {
    //     if (_push) {
    //       _push(`aaa`)
    //     } else {
    //       return [
    //         _createTextVNode("aaa")
    //       ]
    //     }
    //   }),
    //   _: 1 /* STABLE */
    // }, _parent)
    node.ssrCodegenNode = createCallExpression(
      context.helper(SSR_RENDER_COMPONENT),
      [component, props, slots, `_parent`]
    )
  }
}

// 组件
// 会重新起一个_push函数用于当前组件
export function ssrProcessComponent(
  node: ComponentNode,
  context: SSRTransformContext
) {
  if (!node.ssrCodegenNode) { // transform失败的内建组件
    // this is a built-in component that fell-through.
    const component = componentTypeMap.get(node)!
    if (component === TELEPORT) { // teleport
      // teleport的内容对象是NodeTypes.JS_FUNCTION_EXPRESSION，其body属性是NodeTypes.JS_BLOCK_STATEMENT
      return ssrProcessTeleport(node, context)
    } else if (component === SUSPENSE) { // suspense
      return ssrProcessSuspense(node, context)
    } else {
      // real fall-through (e.g. KeepAlive): just render its children.
      // 只有内建组件TransitionGroup会当作fragment解析
      processChildren(node.children, context, component === TRANSITION_GROUP)
    }
  } else { // transform成功
    // finish up slot function expressions from the 1st pass.
    const wipEntries = wipMap.get(node) || []
    for (let i = 0; i < wipEntries.length; i++) {
      const { fn, children, vnodeBranch } = wipEntries[i]
      // For each slot, we generate two branches: one SSR-optimized branch and
      // one normal vnode-based branch. The branches are taken based on the
      // presence of the 2nd `_push` argument (which is only present if the slot
      // is called by `_ssrRenderSlot`.

      // NodeTypes.JS_IF_STATEMENT
      fn.body = createIfStatement(
        // NodeTypes.SIMPLE_EXPRESSION
        createSimpleExpression(`_push`, false),
        // processChildren，返回NodeTypes.JS_BLOCK_STATEMENT
        processChildrenAsStatement(
          children,
          context,
          false,
          true /* withSlotScopeId */
        ),
        vnodeBranch
      )
    }
    // NodeTypes.JS_CALL_EXPRESSION
    // node.ssrCodegenNode => NodeTypes.JS_CALL_EXPRESSION
    // 会重新起一个_push函数用于当前组件
    context.pushStatement(createCallExpression(`_push`, [node.ssrCodegenNode]))
  }
}

export const rawOptionsMap = new WeakMap<RootNode, CompilerOptions>()

const [baseNodeTransforms, baseDirectiveTransforms] = getBaseTransformPreset(
  true
)
const vnodeNodeTransforms = [...baseNodeTransforms, ...DOMNodeTransforms]
const vnodeDirectiveTransforms = {
  ...baseDirectiveTransforms,
  ...DOMDirectiveTransforms
}

// 给插槽包裹一个带v-slot属性的template标签，进行客户端编译的traverse，返回NodeTypes.JS_RETURN_STATEMENT
// 这里是作为失败备用分支的，所以走正常客户端render，而不是ssr
function createVNodeSlotBranch(
  props: ExpressionNode | undefined,
  children: TemplateChildNode[],
  parentContext: TransformContext
): ReturnStatement {
  // apply a sub-transform using vnode-based transforms.
  const rawOptions = rawOptionsMap.get(parentContext.root)!
  const subOptions = {
    ...rawOptions,
    // overwrite with vnode-based transforms
    nodeTransforms: [
      ...vnodeNodeTransforms,
      ...(rawOptions.nodeTransforms || [])
    ],
    directiveTransforms: {
      ...vnodeDirectiveTransforms,
      ...(rawOptions.directiveTransforms || {})
    }
  }

  // wrap the children with a wrapper template for proper children treatment.
  // 给插槽包裹一个带v-slot属性的template标签，进行客户端编译的traverse
  const wrapperNode: TemplateNode = {
    type: NodeTypes.ELEMENT,
    ns: Namespaces.HTML,
    tag: 'template',
    tagType: ElementTypes.TEMPLATE,
    isSelfClosing: false,
    // important: provide v-slot="props" on the wrapper for proper
    // scope analysis
    props: [
      {
        type: NodeTypes.DIRECTIVE,
        name: 'slot',
        exp: props,
        arg: undefined,
        modifiers: [],
        loc: locStub
      }
    ],
    children,
    loc: locStub,
    codegenNode: undefined
  }
  // 将node作为ast根节点，进行客户端编译的traverse
  // 这个subTransform是作为失败备用分支的，所以走正常客户端render，而不是ssr
  subTransform(wrapperNode, subOptions, parentContext)
  // NodeTypes.JS_RETURN_STATEMENT
  return createReturnStatement(children)
}

// 将node作为ast根节点，进行客户端编译的traverse
// 这个subTransform是作为失败备用分支的，所以走正常客户端render，而不是ssr
function subTransform(
  node: TemplateChildNode,
  options: TransformOptions,
  parentContext: TransformContext
) {
  // 创建ast根节点 NodeTypes.ROOT
  const childRoot = createRoot([node])
  // 创建根节点对应的上下文context
  const childContext = createTransformContext(childRoot, options)
  // this sub transform is for vnode fallback branch so it should be handled
  // like normal render functions
  // sub transform是作为失败备用分支，所以走正常render，而不是ssr
  childContext.ssr = false
  // inherit parent scope analysis state
  childContext.scopes = { ...parentContext.scopes }
  childContext.identifiers = { ...parentContext.identifiers }
  // traverse
  // 递归遍历整个childRoot，进行traverse
  traverseNode(childRoot, childContext)
  // merge helpers/components/directives/imports into parent context
  ;(['helpers', 'components', 'directives', 'imports'] as const).forEach(
    key => {
      childContext[key].forEach((value: any) => {
        ;(parentContext[key] as any).add(value)
      })
    }
  )
}

function clone(v: any): any {
  if (isArray(v)) {
    return v.map(clone)
  } else if (isObject(v)) {
    const res: any = {}
    for (const key in v) {
      res[key] = clone(v[key])
    }
    return res
  } else {
    return v
  }
}
