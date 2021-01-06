import { NodeTransform } from '../transform'
import {
  NodeTypes,
  CompoundExpressionNode,
  createCallExpression,
  CallExpression,
  ElementTypes
} from '../ast'
import { isText } from '../utils'
import { CREATE_TEXT } from '../runtimeHelpers'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
// 处理文本child => 返回值是函数，目的将所有连续的文本child合并并替换为type为 NodeTypes.TEXT_CALL 的对象，其codegenNode是 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
export const transformText: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ROOT || // 根
    node.type === NodeTypes.ELEMENT ||
    node.type === NodeTypes.FOR || // v-for
    node.type === NodeTypes.IF_BRANCH // v-if v-else-if v-else
  ) {
    // perform the transform on node exit so that all expressions have already
    // been processed.
    // 返回函数作为onExit，等到traverse完node对应的整个树之后再执行，因为此时所有的表达式才完成了
    return () => {
      const children = node.children
      let currentContainer: CompoundExpressionNode | undefined = undefined
      let hasText = false

      // 找到所有连续的文本child，都合并成一个child对象 type为NodeTypes.COMPOUND_EXPRESSION
      // 文本都存放在新child对象的children中
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isText(child)) {
          hasText = true
          for (let j = i + 1; j < children.length; j++) {
            const next = children[j]
            if (isText(next)) {
              if (!currentContainer) {
                // 创建type为NodeTypes.COMPOUND_EXPRESSION的对象作为currentContainer，替换当前child
                currentContainer = children[i] = {
                  type: NodeTypes.COMPOUND_EXPRESSION,
                  loc: child.loc,
                  children: [child]
                }
              }
              // merge adjacent text node into current
              currentContainer.children.push(` + `, next)
              children.splice(j, 1)
              j--
            } else {
              currentContainer = undefined
              break
            }
          }
        }
      }

      // 没有文本 或 只有一个child的根 或 只有一个child的原生标签
      // 直接返回
      if (
        !hasText || // 没有文本
        // if this is a plain element with a single text child, leave it
        // as-is since the runtime has dedicated fast path for this by directly
        // setting textContent of the element.
        // for component root it's always normalized anyway.
        (children.length === 1 &&
          (node.type === NodeTypes.ROOT || // 根
            (node.type === NodeTypes.ELEMENT &&
              node.tagType === ElementTypes.ELEMENT))) // 原生标签
      ) {
        return
      }

      // pre-convert text nodes into createTextVNode(text) calls to avoid
      // runtime normalization.
      // 将前面处理好的文本child进一步处理，替换为type为 NodeTypes.TEXT_CALL 的对象，其codegenNode是 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isText(child) || child.type === NodeTypes.COMPOUND_EXPRESSION) {
          const callArgs: CallExpression['arguments'] = []
          // createTextVNode defaults to single whitespace, so if it is a
          // single space the code could be an empty call to save bytes.
          if (child.type !== NodeTypes.TEXT || child.content !== ' ') {
            callArgs.push(child)
          }
          // mark dynamic text with flag so it gets patched inside a block
          // 标记动态文本 PatchFlags.TEXT
          if (!context.ssr && child.type !== NodeTypes.TEXT) {
            callArgs.push(
              `${PatchFlags.TEXT} /* ${PatchFlagNames[PatchFlags.TEXT]} */`
            )
          }
          // child替换为type为 NodeTypes.TEXT_CALL 的对象，其codegenNode是 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
          children[i] = {
            type: NodeTypes.TEXT_CALL,
            content: child,
            loc: child.loc,
            codegenNode: createCallExpression(
              context.helper(CREATE_TEXT),
              callArgs
            )
          }
        }
      }
    }
  }
}
