import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

// 处理v-once
// 返回值是函数，更新node.codegenNode的指向，标记需要缓存
export const transformOnce: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      if (node.codegenNode) {
        // node.codegenNode指向 表达式node.codegenNode 的对象，标记需要缓存
        node.codegenNode = context.cache(node.codegenNode, true /* isVNode */)
      }
    }
  }
}
