import {
  NodeTransform,
  isSlotOutlet,
  processSlotOutlet,
  createCallExpression,
  SlotOutletNode,
  createFunctionExpression
} from '@vue/compiler-dom'
import { SSR_RENDER_SLOT } from '../runtimeHelpers'
import {
  SSRTransformContext,
  processChildrenAsStatement
} from '../ssrCodegenTransform'

// slot标签
// 生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
// <slot></slot> => _ssrRenderSlot(_ctx.$slots, "default", {}, null, _push, _parent)
export const ssrTransformSlotOutlet: NodeTransform = (node, context) => {
  if (isSlotOutlet(node)) {
    const { slotName, slotProps } = processSlotOutlet(node, context)
    // NodeTypes.JS_CALL_EXPRESSION
    node.ssrCodegenNode = createCallExpression(
      context.helper(SSR_RENDER_SLOT),
      [
        `_ctx.$slots`,
        slotName,
        slotProps || `{}`,
        `null`, // fallback content placeholder.
        `_push`,
        `_parent`
      ]
    )
  }
}

// slot标签
// 处理默认插槽，放到node.ssrCodegenNode.arguments[3]上
export function ssrProcessSlotOutlet(
  node: SlotOutletNode,
  context: SSRTransformContext
) {
  const renderCall = node.ssrCodegenNode!
  // has fallback content
  if (node.children.length) {
    // NodeTypes.JS_FUNCTION_EXPRESSION
    const fallbackRenderFn = createFunctionExpression([])
    // 默认插槽
    fallbackRenderFn.body = processChildrenAsStatement(node.children, context)
    // _renderSlot(slots, name, props, fallback, ...)
    renderCall.arguments[3] = fallbackRenderFn
  }
  context.pushStatement(node.ssrCodegenNode!)
}
