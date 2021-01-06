import {
  createStructuralDirectiveTransform,
  ForNode,
  processFor,
  createCallExpression,
  createFunctionExpression,
  createForLoopParams,
  NodeTypes
} from '@vue/compiler-dom'
import {
  SSRTransformContext,
  processChildrenAsStatement
} from '../ssrCodegenTransform'
import { SSR_RENDER_LIST } from '../runtimeHelpers'

// Plugin for the first transform pass, which simply constructs the AST node
export const ssrTransformFor = createStructuralDirectiveTransform(
  'for',
  processFor
)

// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
// value item context 表达式 对应 NodeTypes.JS_BLOCK_STATEMENT
// v-for的内容 对应 NodeTypes.JS_BLOCK_STATEMENT
// v-for总是当成fragment，添加头尾注释标志
// v-for会结束当前_push，用于开始_ssrRenderList
export function ssrProcessFor(node: ForNode, context: SSRTransformContext) {
  const needFragmentWrapper =
    node.children.length !== 1 || node.children[0].type !== NodeTypes.ELEMENT
  // NodeTypes.JS_FUNCTION_EXPRESSION
  const renderLoop = createFunctionExpression(
    createForLoopParams(node.parseResult)
  )
  // 递归处理children，返回NodeTypes.JS_BLOCK_STATEMENT
  renderLoop.body = processChildrenAsStatement(
    node.children,
    context,
    needFragmentWrapper
  )
  // v-for always renders a fragment
  // v-for总是当成fragment，添加头尾注释标志
  context.pushStringPart(`<!--[-->`)
  // <div v-for="(item,index) in list">111</div>
  // =>
  // _ssrRenderList(_ctx.list, (item, index) => {
  //   _push(`<div>111</div>`)
  // })
  context.pushStatement(
    createCallExpression(context.helper(SSR_RENDER_LIST), [
      node.source,
      renderLoop
    ])
  )
  context.pushStringPart(`<!--]-->`)
}
