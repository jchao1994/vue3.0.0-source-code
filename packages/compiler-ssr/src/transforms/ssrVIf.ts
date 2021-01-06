import {
  createStructuralDirectiveTransform,
  processIf,
  IfNode,
  createIfStatement,
  createBlockStatement,
  createCallExpression,
  IfBranchNode,
  BlockStatement,
  NodeTypes
} from '@vue/compiler-dom'
import {
  SSRTransformContext,
  processChildrenAsStatement
} from '../ssrCodegenTransform'

// Plugin for the first transform pass, which simply constructs the AST node
export const ssrTransformIf = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  processIf
)

// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
// v-if v-else-if 对应 NodeTypes.JS_IF_STATEMENT，其consequent属性指向 NodeTypes.JS_BLOCK_STATEMENT
// v-else 对应 NodeTypes.JS_BLOCK_STATEMENT
// v-if v-else-if v-else 通过 alternate 连接，没有v-else，最后一个的 alternate 指向结束注释 NodeTypes.JS_BLOCK_STATEMENT
export function ssrProcessIf(node: IfNode, context: SSRTransformContext) {
  // node.branches => v-if v-else-if v-else对应的branch对象数组
  const [rootBranch] = node.branches
  // NodeTypes.JS_IF_STATEMENT
  const ifStatement = createIfStatement(
    // test
    rootBranch.condition!,
    // processChildren，返回NodeTypes.JS_BLOCK_STATEMENT
    // consequent
    processIfBranch(rootBranch, context)
  )
  context.pushStatement(ifStatement)

  let currentIf = ifStatement
  // 跳过rootBranch，遍历剩下的v-else-if v-else对应的branch对象
  for (let i = 1; i < node.branches.length; i++) {
    const branch = node.branches[i]
    // processChildren，返回NodeTypes.JS_BLOCK_STATEMENT
    const branchBlockStatement = processIfBranch(branch, context)
    if (branch.condition) { // else-if
      // NodeTypes.JS_IF_STATEMENT
      currentIf = currentIf.alternate = createIfStatement(
        branch.condition,
        branchBlockStatement
      )
    } else { // else
      // NodeTypes.JS_BLOCK_STATEMENT
      currentIf.alternate = branchBlockStatement
    }
  }

  // 最后一个 v-if | v-else-if
  // currentIf.alternate指向结束注释
  if (!currentIf.alternate) {
    // NodeTypes.JS_BLOCK_STATEMENT
    currentIf.alternate = createBlockStatement([
      createCallExpression(`_push`, ['`<!---->`'])
    ])
  }
}

// processChildren，返回NodeTypes.JS_BLOCK_STATEMENT
function processIfBranch(
  branch: IfBranchNode,
  context: SSRTransformContext
): BlockStatement {
  const { children } = branch
  const needFragmentWrapper =
    (children.length !== 1 || children[0].type !== NodeTypes.ELEMENT) &&
    // optimize away nested fragments when the only child is a ForNode
    !(children.length === 1 && children[0].type === NodeTypes.FOR)
  // processChildren，返回NodeTypes.JS_BLOCK_STATEMENT
  return processChildrenAsStatement(children, context, needFragmentWrapper)
}
