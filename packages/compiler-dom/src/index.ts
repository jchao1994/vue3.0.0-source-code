import {
  baseCompile,
  baseParse,
  CompilerOptions,
  CodegenResult,
  ParserOptions,
  RootNode,
  noopDirectiveTransform,
  NodeTransform,
  DirectiveTransform
} from '@vue/compiler-core'
import { parserOptions } from './parserOptions'
import { transformStyle } from './transforms/transformStyle'
import { transformVHtml } from './transforms/vHtml'
import { transformVText } from './transforms/vText'
import { transformModel } from './transforms/vModel'
import { transformOn } from './transforms/vOn'
import { transformShow } from './transforms/vShow'
import { warnTransitionChildren } from './transforms/warnTransitionChildren'
import { stringifyStatic } from './transforms/stringifyStatic'
import { extend } from '@vue/shared'

export { parserOptions }

export const DOMNodeTransforms: NodeTransform[] = [
  transformStyle,
  ...(__DEV__ ? [warnTransitionChildren] : [])
]

export const DOMDirectiveTransforms: Record<string, DirectiveTransform> = {
  cloak: noopDirectiveTransform,
  html: transformVHtml,
  text: transformVText,
  model: transformModel, // override compiler-core
  on: transformOn, // override compiler-core
  show: transformShow
}

// 1. 解析模板字符串，返回ast语法树
// 2. 让解析完成的ast语法树上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
// 3. 生成render函数代码并返回
export function compile(
  template: string, // 模板字符串
  options: CompilerOptions = {}
): CodegenResult {
  // 1. 解析模板字符串，返回ast语法树
  // 2. 让解析完成的ast语法树上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
  // 3. 生成render函数代码并返回
  return baseCompile(
    template,
    extend({}, parserOptions, options, {
      nodeTransforms: [...DOMNodeTransforms, ...(options.nodeTransforms || [])],
      directiveTransforms: extend(
        {},
        DOMDirectiveTransforms,
        options.directiveTransforms || {}
      ),
      transformHoist: __BROWSER__ ? null : stringifyStatic
    })
  )
}

export function parse(template: string, options: ParserOptions = {}): RootNode {
  return baseParse(template, extend({}, parserOptions, options))
}

export * from './runtimeHelpers'
export { transformStyle } from './transforms/transformStyle'
export { createDOMCompilerError, DOMErrorCodes } from './errors'
export * from '@vue/compiler-core'
