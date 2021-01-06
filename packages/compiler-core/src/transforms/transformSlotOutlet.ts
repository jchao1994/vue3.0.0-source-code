import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  CallExpression,
  createCallExpression,
  ExpressionNode,
  SlotOutletNode,
  createFunctionExpression
} from '../ast'
import { isSlotOutlet, findProp } from '../utils'
import { buildProps, PropsExpression } from './transformElement'
import { createCompilerError, ErrorCodes } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'

// 处理slot标签
// 处理slot标签上的name和props，生成slotName和slotProps
// 结合children合成slotArgs数组，最后创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象作为node.codegenNode
// slot标签 => 没有返回值，执行这个方法，处理name和props，最后创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象作为node.codegenNode
export const transformSlotOutlet: NodeTransform = (node, context) => {
  // node是slot
  if (isSlotOutlet(node)) {
    const { children, loc } = node
    // 解析slot标签，返回 { slotName, slotProps }
    // slotName => slot的name(静态name="xxx") 或 name对象(动态:name="xxx")
    // slotProps => 分析完成的属性对象
    const { slotName, slotProps } = processSlotOutlet(node, context)

    const slotArgs: CallExpression['arguments'] = [
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
      slotName
    ]

    if (slotProps) {
      slotArgs.push(slotProps)
    }

    if (children.length) {
      if (!slotProps) {
        slotArgs.push(`{}`)
      }
      // 创建type为NodeTypes.JS_FUNCTION_EXPRESSION的对象 推入slotArgs
      slotArgs.push(createFunctionExpression([], children, false, false, loc))
    }

    // slotArgs => ['$slots', slotName]
    // slotArgs => ['$slots', slotName, slotProps]
    // slotArgs => ['$slots', slotName, {}, createFunctionExpression([], children, false, false, loc)]
    // slotArgs => ['$slots', slotName, slotProps, createFunctionExpression([], children, false, false, loc)]
    // 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象作为node.codegenNode
    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

// 解析slot标签，返回 { slotName, slotProps }
// slotName => slot的name(静态name="xxx") 或 name对象(动态:name="xxx")
// slotProps => 分析完成的属性对象
export function processSlotOutlet(
  node: SlotOutletNode, // slot对应的node对象
  context: TransformContext
): SlotOutletProcessResult {
  let slotName: string | ExpressionNode = `"default"`
  let slotProps: PropsExpression | undefined = undefined

  // check for <slot name="xxx" OR :name="xxx" />
  const name = findProp(node, 'name')
  // 传入name，替换default
  if (name) {
    if (name.type === NodeTypes.ATTRIBUTE && name.value) {
      // static name
      // name="xxx" 静态属性
      // slotName指向xxx
      slotName = JSON.stringify(name.value.content)
    } else if (name.type === NodeTypes.DIRECTIVE && name.exp) {
      // dynamic name
      // :name="xxx" 动态属性
      // slotName指向属性值xxx对应的对象
      slotName = name.exp
    }
  }

  // props去除name
  const propsWithoutName = name
    ? node.props.filter(p => p !== name)
    : node.props
  if (propsWithoutName.length > 0) {
    // 分析所有属性，根据属性是否动态，以及属性名动态还是属性值动态，进行标记
    // 返回 
    //    { props: propsExpression, // 分析完成的属性对象
    //      directives: runtimeDirectives, // 需要runtime的指令
    //      patchFlag, // patch标志，用于优化
    //      dynamicPropNames // 动态属性，用于优化
    //    }
    const { props, directives } = buildProps(node, context, propsWithoutName)
    // 分析完成的属性对象
    slotProps = props
    // slot标签上不应该有需要runtime的指令(包括所有自定义指令)
    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc
        )
      )
    }
  }

  return {
    slotName, // slot的name(静态name="xxx") 或 name对象(动态:name="xxx")
    slotProps // 分析完成的属性对象
  }
}
