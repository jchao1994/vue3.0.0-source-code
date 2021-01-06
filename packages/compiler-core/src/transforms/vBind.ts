import { DirectiveTransform } from '../transform'
import { createObjectProperty, createSimpleExpression, NodeTypes } from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'

// v-bind without arg is handled directly in ./transformElements.ts due to it affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
export const transformBind: DirectiveTransform = (dir, node, context) => {
  // exp => 属性值value对象 type为NodeTypes.SIMPLE_EXPRESSION
  // modifers => .修饰符数组
  const { exp, modifiers, loc } = dir
  // 属性名对象 type为NodeTypes.SIMPLE_EXPRESSION
  const arg = dir.arg!
  // 没有属性值对象，或者没有属性值变量，报错
  if (!exp || (exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content)) {
    context.onError(createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc))
  }
  // .prop is no longer necessary due to new patch behavior
  // .sync is replaced by v-model:arg
  // 处理camel修饰符，更新属性名对象arg的content或children
  if (modifiers.includes('camel')) {
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        arg.content = camelize(arg.content)
      } else {
        // `_camelize${arg.content}`
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }
  return {
    props: [
      // 创建type为NodeTypes.JS_PROPERTY的对象
      createObjectProperty(arg!, exp || createSimpleExpression('', true, loc))
    ]
  }
}
