import {
  ComponentNode,
  findProp,
  NodeTypes,
  createSimpleExpression,
  createFunctionExpression,
  createCallExpression,
  ExpressionNode
} from '@vue/compiler-dom'
import {
  SSRTransformContext,
  processChildrenAsStatement
} from '../ssrCodegenTransform'
import { createSSRCompilerError, SSRErrorCodes } from '../errors'
import { SSR_RENDER_TELEPORT } from '../runtimeHelpers'

// Note: this is a 2nd-pass codegen transform.
// teleport的内容对象是NodeTypes.JS_FUNCTION_EXPRESSION，其body属性是NodeTypes.JS_BLOCK_STATEMENT
export function ssrProcessTeleport(
  node: ComponentNode,
  context: SSRTransformContext
) {
  const targetProp = findProp(node, 'target')
  if (!targetProp) {
    context.onError(
      createSSRCompilerError(SSRErrorCodes.X_SSR_NO_TELEPORT_TARGET, node.loc)
    )
    return
  }

  let target: ExpressionNode | undefined
  if (targetProp.type === NodeTypes.ATTRIBUTE) { // 静态target属性，target指向NodeTypes.SIMPLE_EXPRESSION的对象
    target =
      targetProp.value && createSimpleExpression(targetProp.value.content, true)
  } else { // 动态target属性，target指向其属性值value对象exp
    target = targetProp.exp
  }
  if (!target) {
    context.onError(
      createSSRCompilerError(
        SSRErrorCodes.X_SSR_NO_TELEPORT_TARGET,
        targetProp.loc
      )
    )
    return
  }

  // disabled属性
  const disabledProp = findProp(node, 'disabled', false, true /* allow empty */)
  const disabled = disabledProp
    ? disabledProp.type === NodeTypes.ATTRIBUTE
      ? `true` // 静态disabled属性
      : disabledProp.exp || `false` // 动态disabled属性
    : `false`

  // teleport的内容对象
  // NodeTypes.JS_FUNCTION_EXPRESSION
  const contentRenderFn = createFunctionExpression(
    [`_push`],
    undefined, // Body is added later
    true, // newline
    false, // isSlot
    node.loc
  )
  // NodeTypes.JS_BLOCK_STATEMENT
  contentRenderFn.body = processChildrenAsStatement(node.children, context)
  // <teleport to="aaa">xxx</teleport>
  // => 
  // _ssrRenderTeleport(_push, (_push) => {
  //   _push(`xxx`)
  // }, "aaa", false, _parent)
  context.pushStatement(
    // NodeTypes.JS_CALL_EXPRESSION
    // _ssrRenderTeleport
    createCallExpression(context.helper(SSR_RENDER_TELEPORT), [
      `_push`,
      contentRenderFn,
      target,
      disabled,
      `_parent`
    ])
  )
}
