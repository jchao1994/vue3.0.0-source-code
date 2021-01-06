import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  ElementTypes,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  CREATE_BLOCK,
  FRAGMENT
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// 处理v-for
// v-for => 返回值是onExit函数，目的是等children都traverse之后处理 slot的key、fragment包裹、标记isBlock，更新forNode.codegenNode
export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper } = context
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed

      // 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      // forNode.source 指向v-for的list
      const renderExp = createCallExpression(helper(RENDER_LIST), [
        forNode.source
      ]) as ForRenderListExpression
      // node上的key属性对象
      const keyProp = findProp(node, `key`)
      // 根据是否有key标记 PatchFlags.KEYED_FRAGMENT | PatchFlags.UNKEYED_FRAGMENT
      // 这个标记会存储在forNode上
      const fragmentFlag = keyProp
        ? PatchFlags.KEYED_FRAGMENT
        : PatchFlags.UNKEYED_FRAGMENT
      // 创建type为 NodeTypes.VNODE_CALL 的对象，存放在forNode.codegenNode上
      // v-for对应的forNode会标记 isBlock 和 isForBlock
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT),
        undefined,
        renderExp, // children
        `${fragmentFlag} /* ${PatchFlagNames[fragmentFlag]} */`,
        undefined,
        undefined,
        true /* isBlock */, // v-for 是 block
        true /* isForBlock */,
        node.loc
      ) as ForCodegenNode

      // 给内部的slot添加key属性对象，对需要包裹fragment的情况进行包裹，以及标记isBlock
      // 最后将更新过的childBlock创建type为NodeTypes.JS_FUNCTION_EXPRESSION的对象，推入renderExp.arguments，更新forNode.codegenNode
      // 这里的renderExp指向v-for的list对应的对象
      return () => {
        // finish the codegen now that all children have been traversed
        let childBlock: BlockCodegenNode
        // 是否是template
        const isTemplate = isTemplateNode(node)
        const { children } = forNode
        // 需要fragment包裹
        // forNode是 template 或 非原生dom标签
        const needFragmentWrapper =
          children.length > 1 || children[0].type !== NodeTypes.ELEMENT
        // 找到内部的slot
        const slotOutlet = isSlotOutlet(node)
          ? node // node是slot  <slot v-for="xxx"></slot>
          : isTemplate &&
            node.children.length === 1 &&
            isSlotOutlet(node.children[0])
            // <template v-for="xxx"><slot></slot></template>
            ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
            : null
        const keyProperty = keyProp
          // 创建type为NodeTypes.JS_PROPERTY的对象
          ? createObjectProperty(
              `key`,
              keyProp.type === NodeTypes.ATTRIBUTE
                ? createSimpleExpression(keyProp.value!.content, true)
                : keyProp.exp!
            )
          : null
        if (slotOutlet) { // slot一定会带key属性对象
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            
            // 给slot中插入key属性对象
            injectProp(childBlock, keyProperty, context)
          }
        } else if (needFragmentWrapper) { // 需要包裹fragment
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          // 创建type为 NodeTypes.VNODE_CALL 的对象
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children,
            `${PatchFlags.STABLE_FRAGMENT} /* ${ // PatchFlags.STABLE_FRAGMENT
              PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
            } */`,
            undefined,
            undefined,
            true
          )
        } else {
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          // 常规情况的v-for，children[0]指向自身node，标记isBlock
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall
          childBlock.isBlock = true
          helper(OPEN_BLOCK)
          helper(CREATE_BLOCK)
        }

        // 创建type为NodeTypes.JS_FUNCTION_EXPRESSION的对象，推入renderExp.arguments
        // renderExp指向v-for的每一项对象
        renderExp.arguments.push(createFunctionExpression(
          // forNode.parseResult指向解析完成的{ source, value, key, index }
          // 返回[{ source, value, key, index }]
          createForLoopParams(forNode.parseResult),
          childBlock, // v-for的每一项都是block
          true /* force newline */
        ) as ForIteratorExpression)
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {
  // v-for没有value表达式，报错
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  // 解析v-for的表达式  (item, index, context) in xxx
  // 返回一个对象，这个对象包含item index context xxx各自对应的type为NodeTypes.SIMPLE_EXPRESSION的对象
  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode,
    context
  )

  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  const { addIdentifiers, removeIdentifiers, scopes } = context
  // (item, index, context) in xxx
  // source => xxx
  // value => item
  // key => index
  // index => context
  const { source, value, key, index } = parseResult

  // 创建forNode
  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,
    objectIndexAlias: index,
    parseResult,
    children: node.tagType === ElementTypes.TEMPLATE ? node.children : [node]
  }

  // forNode替换原来的ast node
  context.replaceNode(forNode)

  // bookkeeping
  // v-for计数
  scopes.vFor++
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  // 给内部的slot添加key属性对象，对需要包裹fragment的情况进行包裹，以及标记isBlock
  // 最后将更新过的childBlock创建type为NodeTypes.JS_FUNCTION_EXPRESSION的对象，推入renderExp.arguments，更新forNode.codegenNode
  // 这里的renderExp指向v-for的list对应的对象
  const onExit = processCodegen && processCodegen(forNode)

  // processFor的返回值函数
  // scopes.vFor-- 并且 执行onExit
  return () => {
    scopes.vFor--
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    if (onExit) onExit()
  }
}

const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

export interface ForParseResult {
  source: ExpressionNode
  value: ExpressionNode | undefined
  key: ExpressionNode | undefined
  index: ExpressionNode | undefined
}

// 解析v-for的表达式  (item, index, context) in xxx
// 返回一个对象，这个对象包含item index context xxx各自对应的type为NodeTypes.SIMPLE_EXPRESSION的对象
export function parseForExpression(
  input: SimpleExpressionNode, // dir.exp，也就是v-for的value表达式对象
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content // 表达式
  // 匹配 aaa in/of bbb
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  // LHS 指向 aaa
  // RHS 指向 bbb
  const [, LHS, RHS] = inMatch

  const result: ForParseResult = {
    // 根据整个value表达式的loc生成RHS的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
    // 这里的source对象对应的RHS
    source: createAliasExpression(
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined, // item对应的type为NodeTypes.SIMPLE_EXPRESSION的对象
    key: undefined, // index对应的type为NodeTypes.SIMPLE_EXPRESSION的对象
    index: undefined // context对应的type为NodeTypes.SIMPLE_EXPRESSION的对象
  }
  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }

  // 去除LHS两端的括号()并去重空格
  // (item, index, context) => item, index, context
  // (item, index) => item, index
  // (item) => item
  // item => item
  let valueContent = LHS.trim()
    .replace(stripParensRE, '')
    .trim()
  // item的第一个字符i的index
  const trimmedOffset = LHS.indexOf(valueContent)

  // 匹配第一个逗号及其之后的内容
  // item, index, context => , index, content
  // item, index => , index
  // item => null
  const iteratorMatch = valueContent.match(forIteratorRE)
  // 根据整个value表达式的loc生成key(也就是index)和context对应的的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
  if (iteratorMatch) {
    // item
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    // index
    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      // exp中key的第一个字符的index
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      // 根据整个value表达式的loc生成key的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
      result.key = createAliasExpression(loc, keyContent, keyOffset)
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    // context
    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        // 根据整个value表达式的loc生成context的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  // 根据整个value表达式的loc生成item的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
  if (valueContent) {
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

// 根据整个value表达式的loc生成RHS的loc对象，然后创建type为NodeTypes.SIMPLE_EXPRESSION的对象
function createAliasExpression(
  range: SourceLocation, // 整个value表达式的loc
  content: string, // RHS的去重空格内容，也就是list
  offset: number // RHS的index
): SimpleExpressionNode {
  return createSimpleExpression(
    content,
    false,
    // 根据整个value表达式的loc生成RHS的loc对象
    getInnerRange(range, offset, content.length)
  )
}

// 获取v-for的参数
export function createForLoopParams({
  value, // 解析完成的{ source, value, key, index }
  key,
  index
}: ForParseResult): ExpressionNode[] {
  const params: ExpressionNode[] = []
  if (value) {
    params.push(value)
  }
  if (key) {
    if (!value) {
      params.push(createSimpleExpression(`_`, false))
    }
    params.push(key)
  }
  if (index) {
    if (!key) {
      if (!value) {
        params.push(createSimpleExpression(`_`, false))
      }
      params.push(createSimpleExpression(`__`, false))
    }
    params.push(index)
  }
  return params
}
