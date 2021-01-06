import {
  ElementNode,
  ObjectExpression,
  createObjectExpression,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
  createFunctionExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  Property,
  TemplateChildNode,
  SourceLocation,
  createConditionalExpression,
  ConditionalExpression,
  JSChildNode,
  SimpleExpressionNode,
  FunctionExpression,
  CallExpression,
  createCallExpression,
  createArrayExpression,
  SlotsExpression
} from '../ast'
import { TransformContext, NodeTransform } from '../transform'
import { createCompilerError, ErrorCodes } from '../errors'
import { findDir, isTemplateNode, assert, isVSlot, hasScopeRef } from '../utils'
import { CREATE_SLOTS, RENDER_LIST, WITH_CTX } from '../runtimeHelpers'
import { parseForExpression, createForLoopParams } from './vFor'

const isStaticExp = (p: JSChildNode): p is SimpleExpressionNode =>
  p.type === NodeTypes.SIMPLE_EXPRESSION && p.isStatic

const defaultFallback = createSimpleExpression(`undefined`, false)

// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
// 带v-slot或#的 组件 | template，也就是具名插槽，context.scopes.vSlot计数加1，返回值函数用于计数减1
export const trackSlotScopes: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.COMPONENT || // 组件
      node.tagType === ElementTypes.TEMPLATE) // template
  ) {
    // We are only checking non-empty v-slot here
    // since we only care about slots that introduce scope variables.
    // 找到v-slot或#的属性对象
    const vSlot = findDir(node, 'slot')
    if (vSlot) {
      // 属性值对象
      const slotProps = vSlot.exp
      if (!__BROWSER__ && context.prefixIdentifiers) {
        slotProps && context.addIdentifiers(slotProps)
      }
      // 具名插槽计数加1
      context.scopes.vSlot++
      return () => {
        if (!__BROWSER__ && context.prefixIdentifiers) {
          slotProps && context.removeIdentifiers(slotProps)
        }
        context.scopes.vSlot--
      }
    }
  }
}

// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
export const trackVForSlotScopes: NodeTransform = (node, context) => {
  let vFor
  if (
    isTemplateNode(node) &&
    node.props.some(isVSlot) &&
    (vFor = findDir(node, 'for'))
  ) {
    const result = (vFor.parseResult = parseForExpression(
      vFor.exp as SimpleExpressionNode,
      context
    ))
    if (result) {
      const { value, key, index } = result
      const { addIdentifiers, removeIdentifiers } = context
      value && addIdentifiers(value)
      key && addIdentifiers(key)
      index && addIdentifiers(index)

      return () => {
        value && removeIdentifiers(value)
        key && removeIdentifiers(key)
        index && removeIdentifiers(index)
      }
    }
  }
}

export type SlotFnBuilder = (
  slotProps: ExpressionNode | undefined,
  slotChildren: TemplateChildNode[],
  loc: SourceLocation
) => FunctionExpression

const buildClientSlotFn: SlotFnBuilder = (props, children, loc) =>
  createFunctionExpression(
    props,
    children,
    false /* newline */,
    true /* isSlot */,
    children.length ? children[0].loc : loc
  )

// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
// 处理自身v-slot以及children的v-slot，返回处理后的{ slots, hasDynamicSlots }
// 只有静态插槽内容slotsProperties => slots为NodeTypes.JS_OBJECT_EXPRESSION
// 有动态插槽内容dynamicSlots => slots为NodeTypes.JS_CALL_EXPRESSION，其arguments有NodeTypes.JS_OBJECT_EXPRESSION和NodeTypes.JS_ARRAY_EXPRESSION
// clonedNode => 每一个v-slot都做一份失败备用分支(NodeTypes.JS_RETURN_STATEMENT)，放在vnodeBranches中，这个失败备用分支走正常客户端render，而不是ssr
// node => 每一个v-slot都创建NodeTypes.JS_FUNCTION_EXPRESSION，连同children和对应的vnodeBranch推入wipEntries
export function buildSlots(
  node: ElementNode, // 组件node
  context: TransformContext,
  buildSlotFn: SlotFnBuilder = buildClientSlotFn
): {
  slots: SlotsExpression
  hasDynamicSlots: boolean
} {
  context.helper(WITH_CTX)

  const { children, loc } = node
  const slotsProperties: Property[] = []
  const dynamicSlots: (ConditionalExpression | CallExpression)[] = []

  // 生成默认插槽属性对象(NodeTypes.JS_PROPERTY)的函数
  const buildDefaultSlotProperty = (
    props: ExpressionNode | undefined,
    children: TemplateChildNode[]
  ) => createObjectProperty(`default`, buildSlotFn(props, children, loc)) // NodeTypes.JS_PROPERTY

  // If the slot is inside a v-for or another v-slot, force it to be dynamic
  // since it likely uses a scope variable.
  // 父标签或自身带v-for | 父标签带v-slot
  // 标记动态
  let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0
  // with `prefixIdentifiers: true`, this can be further optimized to make
  // it dynamic only when the slot actually uses the scope variables.
  if (!__BROWSER__ && context.prefixIdentifiers) {
    hasDynamicSlots = hasScopeRef(node, context.identifiers)
  }

  // 1. Check for slot with slotProps on component itself.
  //    <Comp v-slot="{ prop }"/>
  // v-slot指令对象
  const onComponentSlot = findDir(node, 'slot', true)
  // v-slot和其children解析为属性对象NodeTypes.JS_PROPERTY推入slotsProperties
  if (onComponentSlot) {
    const { arg, exp } = onComponentSlot
    // v-slot和其children解析为属性对象NodeTypes.JS_PROPERTY推入slotsProperties
    slotsProperties.push(
      // NodeTypes.JS_PROPERTY
      createObjectProperty(
        arg || createSimpleExpression('default', true), // 具名插槽 | default
        buildSlotFn(exp, children, loc) // 创建一个走客户端编译traverse的失败备用分支推入vnodeBranches，返回空的NodeTypes.JS_FUNCTION_EXPRESSION
      )
    )
  }

  // 2. Iterate through children and check for template slots
  //    <template v-slot:foo="{ prop }">
  let hasTemplateSlots = false
  let hasNamedDefaultSlot = false
  const implicitDefaultChildren: TemplateChildNode[] = []
  const seenSlotNames = new Set<string>()

  // 遍历内容children，处理子children的<template v-slot:foo="{ prop }">，直接作为当前节点的插槽
  // 根据是否还有v-if v-for来标记hasDynamicSlots
  // 动态插槽内容放在dynamicSlots，静态插槽内容放在slotsProperties
  for (let i = 0; i < children.length; i++) {
    const slotElement = children[i]
    let slotDir

    // slotElement 不是template 或 没有v-slot
    // 进行下一个slotElement
    if (
      !isTemplateNode(slotElement) ||
      !(slotDir = findDir(slotElement, 'slot', true))
    ) {
      // not a <template v-slot>, skip.
      if (slotElement.type !== NodeTypes.COMMENT) {
        implicitDefaultChildren.push(slotElement)
      }
      continue
    }

    // 到这里的一定是 <template v-slot:foo="{ prop }">

    // 带v-slot的标签内部不能再有带v-slot的template
    if (onComponentSlot) {
      // already has on-component slot - this is incorrect usage.
      context.onError(
        createCompilerError(ErrorCodes.X_V_SLOT_MIXED_SLOT_USAGE, slotDir.loc)
      )
      break
    }

    hasTemplateSlots = true
    const { children: slotChildren, loc: slotLoc } = slotElement
    const {
      arg: slotName = createSimpleExpression(`default`, true), // v-slot的属性名对象
      exp: slotProps, // v-slot的属性值对象
      loc: dirLoc
    } = slotDir

    // check if name is dynamic.
    let staticSlotName: string | undefined
    if (isStaticExp(slotName)) {
      staticSlotName = slotName ? slotName.content : `default` // 静态具名插槽
    } else {
      hasDynamicSlots = true // 标记动态slot
    }

    // 创建一个走客户端编译traverse的失败备用分支推入vnodeBranches，返回空的NodeTypes.JS_FUNCTION_EXPRESSION
    const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc)
    // check if this slot is conditional (v-if/v-for)
    let vIf: DirectiveNode | undefined
    let vElse: DirectiveNode | undefined
    let vFor: DirectiveNode | undefined
    // 同一组v-if v-else-if v-else都存储在dynamicSlots中的同一个conditional对象上，通过alternate连接
    // v-if v-else-if => NodeTypes.JS_CONDITIONAL_EXPRESSION
    // v-else => NodeTypes.JS_OBJECT_EXPRESSION
    // v-for => NodeTypes.JS_CALL_EXPRESSION
    // 有v-if v-for，就会标记hasDynamicSlots，插槽内容都放在dynamicSlots
    // 静态具名插槽放在slotsProperties
    if ((vIf = findDir(slotElement, 'if'))) { // v-if
      hasDynamicSlots = true
      dynamicSlots.push(
        // NodeTypes.JS_CONDITIONAL_EXPRESSION
        createConditionalExpression(
          vIf.exp!,
          // 给slotName和slotFunction创建NodeTypes.JS_OBJECT_EXPRESSION
          // slotName和slotFunction均创建成NodeTypes.JS_PROPERTY
          // consequent
          buildDynamicSlot(slotName, slotFunction),
          // alternate
          defaultFallback
        )
      )
    } else if ( // v-else-if v-else
      (vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))
    ) {
      // find adjacent v-if
      let j = i
      let prev
      while (j--) {
        prev = children[j]
        if (prev.type !== NodeTypes.COMMENT) {
          break
        }
      }
      if (prev && isTemplateNode(prev) && findDir(prev, 'if')) { // 相邻的是带v-if的template，v-else-if和v-else都会移除，只会剩下第一个v-if
        // remove node
        children.splice(i, 1)
        i--
        __TEST__ && assert(dynamicSlots.length > 0)
        // attach this slot to previous conditionalf
        // v-if对应的NodeTypes.JS_CONDITIONAL_EXPRESSION
        let conditional = dynamicSlots[
          dynamicSlots.length - 1
        ] as ConditionalExpression
        // 找到conditional.alternate的最后一个，也就是指向defaultFallback的那个
        while (
          conditional.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
        ) {
          conditional = conditional.alternate
        }
        conditional.alternate = vElse.exp
          // v-else-if
          // NodeTypes.JS_CONDITIONAL_EXPRESSION
          ? createConditionalExpression(
              vElse.exp,
              // NodeTypes.JS_OBJECT_EXPRESSION
              buildDynamicSlot(slotName, slotFunction),
              defaultFallback
            )
          // v-else
          // NodeTypes.JS_OBJECT_EXPRESSION
          : buildDynamicSlot(slotName, slotFunction)
      } else { // 相邻的不是带v-if的template，报错
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, vElse.loc)
        )
      }
    } else if ((vFor = findDir(slotElement, 'for'))) { // v-for
      hasDynamicSlots = true
      const parseResult =
        vFor.parseResult ||
        parseForExpression(vFor.exp as SimpleExpressionNode, context)
      if (parseResult) {
        // Render the dynamic slots as an array and add it to the createSlot()
        // args. The runtime knows how to handle it appropriately.
        dynamicSlots.push(
          // NodeTypes.JS_CALL_EXPRESSION
          createCallExpression(context.helper(RENDER_LIST), [
            parseResult.source,
            // NodeTypes.JS_FUNCTION_EXPRESSION
            createFunctionExpression(
              // 获取v-for的参数
              createForLoopParams(parseResult),
              // 插槽内容，也就是v-for的函数体
              // NodeTypes.JS_OBJECT_EXPRESSION
              buildDynamicSlot(slotName, slotFunction),
              true /* force newline */
            )
          ])
        )
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, vFor.loc)
        )
      }
    } else { // 静态具名插槽
      // check duplicate static names
      if (staticSlotName) {
        if (seenSlotNames.has(staticSlotName)) {
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_SLOT_DUPLICATE_SLOT_NAMES,
              dirLoc
            )
          )
          continue
        }
        seenSlotNames.add(staticSlotName)
        // 默认插槽
        if (staticSlotName === 'default') {
          hasNamedDefaultSlot = true
        }
      }
      // v-slot和其children解析为属性对象NodeTypes.JS_PROPERTY推入slotsProperties
      slotsProperties.push(createObjectProperty(slotName, slotFunction))
    }
  }

  // 没有v-slot
  // 子children也没有 <template v-slot:foo="{ prop }"> ，将所有children作为默认插槽
  // 子children有 <template v-slot:foo="{ prop }"> ，将剩下的implicitDefaultChildren推入slotsProperties，但在线编译会报错???
  if (!onComponentSlot) {
    if (!hasTemplateSlots) { // 这里的children和implicitDefaultChildren相同，都是完整的children
      // implicit default slot (on component)
      slotsProperties.push(buildDefaultSlotProperty(undefined, children))
    } else if (implicitDefaultChildren.length) { // 处理剩下的implicitDefaultChildren，推入slotsProperties
      // implicit default slot (mixed with named slots)
      if (hasNamedDefaultSlot) {
        context.onError(
          createCompilerError(
            ErrorCodes.X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN,
            implicitDefaultChildren[0].loc
          )
        )
      } else {
        slotsProperties.push(
          buildDefaultSlotProperty(undefined, implicitDefaultChildren)
        )
      }
    }
  }

  // NodeTypes.JS_OBJECT_EXPRESSION
  let slots = createObjectExpression(
    // slotsProperties添加一个key为 _ ，value为 createSimpleExpression(`1`, false) 的NodeTypes.JS_PROPERTY，标记STABLE
    slotsProperties.concat(
      createObjectProperty(`_`, createSimpleExpression(`1`, false))
    ),
    loc
  ) as SlotsExpression
  // 合并slotsProperties和dynamicSlots对应的对象，最后slots为NodeTypes.JS_CALL_EXPRESSION
  if (dynamicSlots.length) {
    // NodeTypes.JS_CALL_EXPRESSION
    slots = createCallExpression(context.helper(CREATE_SLOTS), [
      slots,
      // NodeTypes.JS_ARRAY_EXPRESSION
      createArrayExpression(dynamicSlots)
    ]) as SlotsExpression
  }

  // 只有slotsProperties => slots为NodeTypes.JS_OBJECT_EXPRESSION
  // 有dynamicSlots => slots为NodeTypes.JS_CALL_EXPRESSION，其arguments有NodeTypes.JS_OBJECT_EXPRESSION和NodeTypes.JS_ARRAY_EXPRESSION
  return {
    slots,
    hasDynamicSlots
  }
}

// 给slotName和slotFunction创建NodeTypes.JS_OBJECT_EXPRESSION
// slotName和slotFunction均创建成NodeTypes.JS_PROPERTY
function buildDynamicSlot(
  name: ExpressionNode,
  fn: FunctionExpression
): ObjectExpression {
  // NodeTypes.JS_OBJECT_EXPRESSION
  return createObjectExpression([
    // NodeTypes.JS_PROPERTY
    createObjectProperty(`name`, name),
    // NodeTypes.JS_PROPERTY
    createObjectProperty(`fn`, fn)
  ])
}
