import {
  createStructuralDirectiveTransform,
  TransformContext,
  traverseNode
} from '../transform'
import {
  NodeTypes,
  ElementTypes,
  ElementNode,
  DirectiveNode,
  IfBranchNode,
  SimpleExpressionNode,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  createObjectProperty,
  createObjectExpression,
  IfConditionalExpression,
  BlockCodegenNode,
  IfNode,
  createVNodeCall
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import {
  CREATE_BLOCK,
  FRAGMENT,
  CREATE_COMMENT,
  OPEN_BLOCK,
  TELEPORT
} from '../runtimeHelpers'
import { injectProp } from '../utils'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// 处理v-if
// 返回值是exitFns数组，创建ifNode替换原node，将v-if v-else-if v-else分别创建一个branch对象，存放在ifNode.branches上，处理v-if指向关系的回调，生成ifNode.codegenNode
export const transformIf = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  // dir  指令属性对象
  (node, dir, context) => {
    // ifNode  存放一组 v-if v-else-if v-else的对象
    // branch  存放单个 v-if | v-else-if | v-else 的对象
    // v-if => isRoot为true
    // v-else-if v-else => isRoot为false
    return processIf(node, dir, context, (ifNode, branch, isRoot) => {
      // Exit callback. Complete the codegenNode when all children have been
      // transformed.
      
      // 返回的函数的作用是完善同一组 v-if v-else-if v-else 到 ifNode 对象
      // ifNode.codegenNode 指向 v-if，通过 alternate 属性不断指向同组的下一个
      // ifNode.codegenNode 是 v-if
      // v-if | v-else-if 的 alternate 指向下一个 v-else-if | v-else
      // 最后一个 v-if | v-else-if 的 alternate 指向结束注释对象，以 v-if | v-else-if 结束的情况需要结束标志
      // v-else 没有 alternate，不需要指向，以 v-else 结束的情况不需要结束标志
      // ifNode.codegenNode 指向 v-if，通过 alternate 属性不断指向同组的下一个
      return () => {
        if (isRoot) { // v-if
          // v-if v-else-if  返回type为 NodeTypes.JS_CONDITIONAL_EXPRESSION 的对象
          // v-else  返回type为 NodeTypes.VNODE_CALL 的对象
          ifNode.codegenNode = createCodegenNodeForBranch(
            branch,
            0,
            context
          ) as IfConditionalExpression
        } else { // v-else-if v-else
          // attach this branch's codegen node to the v-if root.
          let parentCondition = ifNode.codegenNode!
          while (
            parentCondition.alternate.type ===
            NodeTypes.JS_CONDITIONAL_EXPRESSION
          ) {
            parentCondition = parentCondition.alternate
          }
          // v-if v-else-if  返回type为 NodeTypes.JS_CONDITIONAL_EXPRESSION 的对象
          // v-else  返回type为 NodeTypes.VNODE_CALL 的对象
          // 替换v-if v-else-if的注释节点为下一个v-else-if或v-else的branch对象对应的对象(NodeTypes.JS_CONDITIONAL_EXPRESSION | NodeTypes.VNODE_CALL)
          parentCondition.alternate = createCodegenNodeForBranch(
            branch,
            ifNode.branches.length - 1,
            context
          )
        }
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
// 返回的函数的作用是完善同一组 v-if v-else-if v-else 到 ifNode 对象
export function processIf(
  node: ElementNode,
  dir: DirectiveNode, // 指令属性对象
  context: TransformContext,
  processCodegen?: ( // ssr不传入这个参数
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean
  ) => (() => void) | undefined
) {
  // 不是v-else 且 没有属性值，报错，然后创建 属性值为true 的属性值对象dir.exp
  // 也就是v-if和v-else-if，如果没有传入属性值，会报错，且默认为true
  // v-if=xxx v-else-if=xxx v-else 只有v-else没有属性值
  if (
    dir.name !== 'else' &&
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim())
  ) {
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc)
    )
    dir.exp = createSimpleExpression(`true`, false, loc)
  }

  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (__DEV__ && __BROWSER__ && dir.exp) {
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (dir.name === 'if') { // v-if
    // 创建v-if的branch对象，存放单个 v-if | v-else-if | v-else 的对象
    const branch = createIfBranch(node, dir)
    // 创建ifNode对象，存放一组 v-if v-else-if v-else 的对象
    const ifNode: IfNode = {
      type: NodeTypes.IF,
      loc: node.loc,
      branches: [branch]
    }
    // 替换原来的节点对象为ifNode
    context.replaceNode(ifNode)
    // 返回的函数的作用是完善同一组 v-if v-else-if v-else 到 ifNode 对象
    // ssr不做这个处理
    if (processCodegen) {
      return processCodegen(ifNode, branch, true)
    }
  } else { // v-else-if v-else
    // locate the adjacent v-if
    const siblings = context.parent!.children
    const comments = []
    let i = siblings.indexOf(node)
    // 找到前一个相邻的 v-if | v-else-if
    // 一组的 v-if v-else-if v-else 只允许相邻
    while (i-- >= -1) {
      const sibling = siblings[i]
      if (__DEV__ && sibling && sibling.type === NodeTypes.COMMENT) {
        context.removeNode(sibling)
        comments.unshift(sibling)
        continue
      }
      // sibling正常已经替换成ifNode对象了
      if (sibling && sibling.type === NodeTypes.IF) { // 前一个相邻的兄弟节点是 v-if | v-else-if
        // move the node to the if node's branches
        // 将context.currentNode设置为null，移除当前node节点对象
        context.removeNode()
        // 创建当前node的branch对象，合并到ifNode的branches上
        const branch = createIfBranch(node, dir)
        if (__DEV__ && comments.length) {
          branch.children = [...comments, ...branch.children]
        }
        // ifNode.branches 按顺序存放 v-if v-else-if v-else 的branch对象
        sibling.branches.push(branch)
        // onExit函数的作用是完善同一组 v-if v-else-if v-else 到 ifNode 对象
        // ssr不做这个处理
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        // 由于前面移除了当前node节点对象，所以这里需要对这个node对应的branch对象重新traverse
        // traverseNode的结果会更新到branch对象上
        traverseNode(branch, context)
        // call on exit
        // 执行onExit，完善 ifNode 对象
        // 解析v-else-if v-else时，必然v-if已经全部完成，包括traverse整个v-if树之后的exitFns
        // 也就是说v-if的processCodegen已经执行完毕，这里可以直接执行v-else-if v-else的processCodegen
        // 而且v-else-if v-else会做removeNode操作，并在内部完成traverseNode，不会再在外部进行traverseNode
        if (onExit) onExit()
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        // traverseNode之后，context.currentNode可能有值，这里重新设置为null，表示当前node节点对象是被移除的
        context.currentNode = null
      } else { // 前一个相邻的兄弟节点不是 v-if | v-else-if ，报错
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
        )
      }
      break
    }
  }
}

function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp,
    children: node.tagType === ElementTypes.TEMPLATE ? node.children : [node]
  }
}

// v-if v-else-if  返回type为 NodeTypes.JS_CONDITIONAL_EXPRESSION 的对象
// v-else  返回type为 NodeTypes.VNODE_CALL 的对象
function createCodegenNodeForBranch(
  branch: IfBranchNode, // 存放单个 v-if | v-else-if | v-else 的对象
  index: number, // v-if => 0
  context: TransformContext
): IfConditionalExpression | BlockCodegenNode {
  if (branch.condition) { // v-if v-else-if 有条件语句，也就是value值对象dir.exp
    // 创建type为 NodeTypes.JS_CONDITIONAL_EXPRESSION 的对象
    return createConditionalExpression(
      branch.condition,
      // 创建type为 NodeTypes.VNODE_CALL 的对象
      createChildrenCodegenNode(branch, index, context),
      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      // 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      // 这个对象是标记 v-if v-else-if 结束的注释对象
      createCallExpression(context.helper(CREATE_COMMENT), [
        __DEV__ ? '"v-if"' : '""',
        'true'
      ])
    ) as IfConditionalExpression
  } else { // v-else
    // 创建type为 NodeTypes.VNODE_CALL 的对象
    return createChildrenCodegenNode(branch, index, context)
  }
}

// 创建type为 NodeTypes.VNODE_CALL 的对象
function createChildrenCodegenNode(
  branch: IfBranchNode,
  index: number, // v-if => 0
  context: TransformContext
): BlockCodegenNode {
  const { helper } = context
  // { type: NodeTypes.JS_PROPERTY, loc, key: createSimpleExpression(key, true), value: createSimpleExpression(index + '', false) }
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(index + '', false)
  )
  const { children } = branch
  const firstChild = children[0]
  // 有多个child(当前节点是template) 或 第一个child不是NodeTypes.ELEMENT
  // 标记需要包裹fragment
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT
  if (needFragmentWrapper) {
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) { // 当前节点是带v-for且不是template
      // optimize away nested fragments when child is a ForNode
      // 看到v-for再回来看???
      const vnodeCall = firstChild.codegenNode!
      injectProp(vnodeCall, keyProperty, context)
      return vnodeCall
    } else { // template 或 当前节点不带v-for
      // 创建type为 NodeTypes.VNODE_CALL 的对象
      return createVNodeCall(
        context,
        helper(FRAGMENT), // 添加到context.helpers中，返回FRAGMENT
        // { type: NodeTypes.JS_OBJECT_EXPRESSION, loc, properties: [keyProperty] }
        createObjectExpression([keyProperty]),
        children,
        `${PatchFlags.STABLE_FRAGMENT} /* ${
          PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
        } */`,
        undefined,
        undefined,
        true, // v-if v-else-if v-else 都是block
        false,
        branch.loc
      )
    }
  } else {
    const vnodeCall = (firstChild as ElementNode)
      .codegenNode as BlockCodegenNode
    // Change createVNode to createBlock.
    if (
      vnodeCall.type === NodeTypes.VNODE_CALL &&
      // component vnodes are always tracked and its children are
      // compiled into slots so no need to make it a block
      ((firstChild as ElementNode).tagType !== ElementTypes.COMPONENT ||
        // teleport has component type but isn't always tracked
        vnodeCall.tag === TELEPORT)
    ) {
      vnodeCall.isBlock = true
      helper(OPEN_BLOCK)
      helper(CREATE_BLOCK)
    }
    // inject branch key
    injectProp(vnodeCall, keyProperty, context)
    return vnodeCall
  }
}
