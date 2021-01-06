import {
  RootNode,
  BlockStatement,
  TemplateLiteral,
  createCallExpression,
  createTemplateLiteral,
  NodeTypes,
  TemplateChildNode,
  ElementTypes,
  createBlockStatement,
  CompilerOptions,
  IfStatement,
  CallExpression,
  isText
} from '@vue/compiler-dom'
import { isString, escapeHtml } from '@vue/shared'
import { SSR_INTERPOLATE, ssrHelpers } from './runtimeHelpers'
import { ssrProcessIf } from './transforms/ssrVIf'
import { ssrProcessFor } from './transforms/ssrVFor'
import { ssrProcessSlotOutlet } from './transforms/ssrTransformSlotOutlet'
import { ssrProcessComponent } from './transforms/ssrTransformComponent'
import { ssrProcessElement } from './transforms/ssrTransformElement'
import { createSSRCompilerError, SSRErrorCodes } from './errors'

// Because SSR codegen output is completely different from client-side output
// (e.g. multiple elements can be concatenated into a single template literal
// instead of each getting a corresponding call), we need to apply an extra
// transform pass to convert the template AST into a fresh JS AST before
// passing it to codegen.

// 递归处理整个ast树，结果存储在context.body上的多组 currentCall | statement
// 最后将整个context.body创建成NodeTypes.JS_BLOCK_STATEMENT，作为ast.codegenNode
export function ssrCodegenTransform(ast: RootNode, options: CompilerOptions) {
  const context = createSSRTransformContext(ast, options)
  const isFragment =
    ast.children.length > 1 && ast.children.some(c => !isText(c))
  // 递归处理整个ast树，结果存储在context.body上的多组 currentCall | statement
  processChildren(ast.children, context, isFragment)
  // NodeTypes.JS_BLOCK_STATEMENT
  ast.codegenNode = createBlockStatement(context.body)

  // Finalize helpers.
  // We need to separate helpers imported from 'vue' vs. '@vue/server-renderer'
  // 分离按需引入的源 vue @vue/server-renderer
  ast.ssrHelpers = [
    ...ast.helpers.filter(h => h in ssrHelpers),
    ...context.helpers
  ]
  ast.helpers = ast.helpers.filter(h => !(h in ssrHelpers))
}

export type SSRTransformContext = ReturnType<typeof createSSRTransformContext>

function createSSRTransformContext(
  root: RootNode,
  options: CompilerOptions,
  helpers: Set<symbol> = new Set(),
  withSlotScopeId = false
) {
  const body: BlockStatement['body'] = []
  let currentString: TemplateLiteral | null = null

  return {
    root,
    options,
    body,
    helpers,
    withSlotScopeId,
    onError:
      options.onError ||
      (e => {
        throw e
      }),
    helper<T extends symbol>(name: T): T {
      helpers.add(name)
      return name
    },
    // currentCall.arguments只有一个currentString，也就是ssr的_push只有一个参数，这个参数是拼接的字符串
    // 将内容推入这个currentString.elements
    // 但是context.body有多组currentCall
    pushStringPart(part: TemplateLiteral['elements'][0]) {
      if (!currentString) {
        // NodeTypes.JS_CALL_EXPRESSION
        const currentCall = createCallExpression(`_push`)
        body.push(currentCall)
        // NodeTypes.JS_TEMPLATE_LITERAL
        currentString = createTemplateLiteral([])
        currentCall.arguments.push(currentString)
      }
      const bufferedElements = currentString.elements
      const lastItem = bufferedElements[bufferedElements.length - 1]
      // 连续字符串合并
      if (isString(part) && isString(lastItem)) {
        bufferedElements[bufferedElements.length - 1] += part
      } else {
        bufferedElements.push(part)
      }
    },
    // 结束当前_push函数
    pushStatement(statement: IfStatement | CallExpression) {
      // close current string
      currentString = null
      body.push(statement)
    }
  }
}

function createChildContext(
  parent: SSRTransformContext,
  withSlotScopeId = parent.withSlotScopeId
): SSRTransformContext {
  // ensure child inherits parent helpers
  return createSSRTransformContext(
    parent.root,
    parent.options,
    parent.helpers,
    withSlotScopeId
  )
}

// 递归处理整个ast树，结果存储在context.body上的多组 currentCall | statement
export function processChildren(
  children: TemplateChildNode[],
  context: SSRTransformContext,
  asFragment = false
) {
  // fragment加上起始注释标志
  if (asFragment) {
    context.pushStringPart(`<!--[-->`)
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    switch (child.type) {
      case NodeTypes.ELEMENT:
        switch (child.tagType) {
          case ElementTypes.ELEMENT: // 原生dom
            ssrProcessElement(child, context)
            break
          case ElementTypes.COMPONENT: // 组件
            // 会重新起一个_push函数用于当前组件
            ssrProcessComponent(child, context)
            break
          case ElementTypes.SLOT: // slot标签
            // 处理默认插槽，放到node.ssrCodegenNode.arguments[3]上
            ssrProcessSlotOutlet(child, context)
            break
          case ElementTypes.TEMPLATE: // template标签，在线编译会对template当作原生dom处理???
            // TODO
            break
          default:
            context.onError(
              createSSRCompilerError(
                SSRErrorCodes.X_SSR_INVALID_AST_NODE,
                (child as any).loc
              )
            )
            // make sure we exhaust all possible types
            const exhaustiveCheck: never = child
            return exhaustiveCheck
        }
        break
      case NodeTypes.TEXT: // 文本child
        // 处理文本children
        // " & ' < > 转换成html格式
        context.pushStringPart(escapeHtml(child.content))
        break
      case NodeTypes.COMMENT: // 注释
        // no need to escape comment here because the AST can only
        // contain valid comments.
        context.pushStringPart(`<!--${child.content}-->`)
        break
      case NodeTypes.INTERPOLATION: // {{}}Mustache语法
        // {{xxx}} => _ssrInterpolate(_ctx.xxx)}
        context.pushStringPart(
          // NodeTypes.JS_CALL_EXPRESSION
          createCallExpression(context.helper(SSR_INTERPOLATE), [child.content])
        )
        break
      case NodeTypes.IF: // 一组v-if v-else-if v-else对应的ifNode
        // v-if v-else-if 对应 NodeTypes.JS_IF_STATEMENT，其consequent属性指向 NodeTypes.JS_BLOCK_STATEMENT
        // v-else 对应 NodeTypes.JS_BLOCK_STATEMENT
        // v-if v-else-if v-else 通过 alternate 连接，没有v-else，最后一个的 alternate 指向结束注释 NodeTypes.JS_BLOCK_STATEMENT
        ssrProcessIf(child, context)
        break
      case NodeTypes.FOR: // v-for
        // value item context 表达式 对应 NodeTypes.JS_BLOCK_STATEMENT
        // v-for的内容 对应 NodeTypes.JS_BLOCK_STATEMENT
        // v-for总是当成fragment，添加头尾注释标志
        // v-for会结束当前_push，用于开始_ssrRenderList
        ssrProcessFor(child, context)
        break
      case NodeTypes.IF_BRANCH: // v-if v-else-if v-else的branch对象存储在ifNode中，不会走这里的逻辑
        // no-op - handled by ssrProcessIf
        break
      case NodeTypes.TEXT_CALL: // 文本child对象，其codegenNode是type为NodeTypes.JS_CALL_EXPRESSION的对象
      case NodeTypes.COMPOUND_EXPRESSION: // 连续文本child合并后的对象
        // no-op - these two types can never appear as template child node since
        // `transformText` is not used during SSR compile.
        // 不会出现以上两种type，因为ssr编译不会执行transformText
        break
      default:
        context.onError(
          createSSRCompilerError(
            SSRErrorCodes.X_SSR_INVALID_AST_NODE,
            (child as any).loc
          )
        )
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = child
        return exhaustiveCheck
    }
  }
  // fragment加上结尾注释标志
  if (asFragment) {
    context.pushStringPart(`<!--]-->`)
  }
}

// 递归处理children，返回NodeTypes.JS_BLOCK_STATEMENT
export function processChildrenAsStatement(
  children: TemplateChildNode[],
  parentContext: SSRTransformContext,
  asFragment = false,
  withSlotScopeId = parentContext.withSlotScopeId
): BlockStatement {
  const childContext = createChildContext(parentContext, withSlotScopeId)
  // 递归处理children
  processChildren(children, childContext, asFragment)
  // NodeTypes.JS_BLOCK_STATEMENT
  return createBlockStatement(childContext.body)
}
