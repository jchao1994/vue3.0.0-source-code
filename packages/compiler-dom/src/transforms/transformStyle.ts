import {
  NodeTransform,
  NodeTypes,
  createSimpleExpression,
  SimpleExpressionNode,
  SourceLocation
} from '@vue/compiler-core'
import { parseStringStyle } from '@vue/shared'

// Parse inline CSS strings for static style attributes into an object.
// This is a NodeTransform since it works on the static `style` attribute and
// converts it into a dynamic equivalent:
// style="color: red" -> :style='{ "color": "red" }'
// It is then processed by `transformElement` and included in the generated
// props.
// 将静态属性style转换成动态绑定:style，等到transformElement返回的onExit执行时会对其做处理
export const transformStyle: NodeTransform = node => {
  if (node.type === NodeTypes.ELEMENT) {
    node.props.forEach((p, i) => {
      if (p.type === NodeTypes.ATTRIBUTE && p.name === 'style' && p.value) {
        // replace p with an expression node
        node.props[i] = {
          type: NodeTypes.DIRECTIVE,
          name: `bind`,
          arg: createSimpleExpression(`style`, true, p.loc),
          // 将用;连接的string属性值转换成NodeTypes.SIMPLE_EXPRESSION
          exp: parseInlineCSS(p.value.content, p.loc),
          modifiers: [],
          loc: p.loc
        }
      }
    })
  }
}

// 将用;连接的string属性值转换成NodeTypes.SIMPLE_EXPRESSION
const parseInlineCSS = (
  cssText: string,
  loc: SourceLocation
): SimpleExpressionNode => {
  // 将用;连接的string属性值转换成object
  const normalized = parseStringStyle(cssText)
  return createSimpleExpression(JSON.stringify(normalized), false, loc, true)
}
