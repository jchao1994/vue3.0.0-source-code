import { CompilerOptions } from './options'
import { baseParse } from './parse'
import { transform, NodeTransform, DirectiveTransform } from './transform'
import { generate, CodegenResult } from './codegen'
import { RootNode } from './ast'
import { isString, extend } from '@vue/shared'
import { transformIf } from './transforms/vIf'
import { transformFor } from './transforms/vFor'
import { transformExpression } from './transforms/transformExpression'
import { transformSlotOutlet } from './transforms/transformSlotOutlet'
import { transformElement } from './transforms/transformElement'
import { transformOn } from './transforms/vOn'
import { transformBind } from './transforms/vBind'
import { trackSlotScopes, trackVForSlotScopes } from './transforms/vSlot'
import { transformText } from './transforms/transformText'
import { transformOnce } from './transforms/vOnce'
import { transformModel } from './transforms/vModel'
import { defaultOnError, createCompilerError, ErrorCodes } from './errors'

export type TransformPreset = [
  NodeTransform[],
  Record<string, DirectiveTransform>
]

export function getBaseTransformPreset(
  prefixIdentifiers?: boolean
): TransformPreset {
  return [
    [
      // 返回值是函数，更新node.codegenNode的指向，标记需要缓存
      transformOnce,
      // 返回值是exitFns数组，创建ifNode替换原node，将v-if v-else-if v-else分别创建一个branch对象，存放在ifNode.branches上，处理v-if指向关系的回调，生成ifNode.codegenNode
      transformIf,
      // v-for => 返回值是onExit函数，目的是等children都traverse之后处理 slot的key、fragment包裹、标记isBlock，更新forNode.codegenNode
      transformFor,
      ...(!__BROWSER__ && prefixIdentifiers
        ? [
            // order is important
            trackVForSlotScopes,
            transformExpression
          ]
        : __BROWSER__ && __DEV__
          ? [transformExpression]
          : []),
      // slot标签 => 没有返回值，执行这个方法，处理name和props，最后创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象作为node.codegenNode
      transformSlotOutlet,
      // 原生标签 | 组件 => 返回值是函数，目的是分析props children，更新shouldUseBlock patchFlag，最后创建type为 NodeTypes.VNODE_CALL 的对象作为node.codegenNode
      transformElement,
      // 带v-slot或#的 组件 | template，也就是具名插槽，context.scopes.vSlot计数加1，返回值函数用于计数减1
      trackSlotScopes,
      // 处理文本child => 返回值是函数，目的将所有连续的文本child合并并替换为type为 NodeTypes.TEXT_CALL 的对象，其codegenNode是 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      transformText
    ],
    {
      on: transformOn,
      bind: transformBind,
      model: transformModel
    }
  ]
}

// we name it `baseCompile` so that higher order compilers like
// @vue/compiler-dom can export `compile` while re-exporting everything else.
// 1. 解析模板字符串，返回ast语法树
// 2. 让解析完成的ast语法树上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
// 3. 生成render函数代码并返回
export function baseCompile(
  template: string | RootNode, // 模板字符串
  options: CompilerOptions = {}
): CodegenResult {
  const onError = options.onError || defaultOnError
  const isModuleMode = options.mode === 'module'
  /* istanbul ignore if */
  if (__BROWSER__) {
    if (options.prefixIdentifiers === true) {
      onError(createCompilerError(ErrorCodes.X_PREFIX_ID_NOT_SUPPORTED))
    } else if (isModuleMode) {
      onError(createCompilerError(ErrorCodes.X_MODULE_MODE_NOT_SUPPORTED))
    }
  }

  const prefixIdentifiers =
    !__BROWSER__ && (options.prefixIdentifiers === true || isModuleMode)
  if (!prefixIdentifiers && options.cacheHandlers) {
    onError(createCompilerError(ErrorCodes.X_CACHE_HANDLER_NOT_SUPPORTED))
  }
  if (options.scopeId && !isModuleMode) {
    onError(createCompilerError(ErrorCodes.X_SCOPE_ID_NOT_SUPPORTED))
  }

  // 1. 解析模板字符串，返回ast语法树
  const ast = isString(template) ? baseParse(template, options) : template
  // nodeTransforms  [transformOnce,transformIf,transformFor,transformExpression,transformSlotOutlet,transformElement,trackSlotScopes,transformText]
  // directiveTransforms  { on: transformOn, bind: transformBind, model: transformModel }
  const [nodeTransforms, directiveTransforms] = getBaseTransformPreset(
    prefixIdentifiers
  )
  // 2. 让解析完成的ast语法树上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
  transform(
    ast,
    extend({}, options, {
      prefixIdentifiers,
      nodeTransforms: [
        ...nodeTransforms,
        ...(options.nodeTransforms || []) // user transforms
      ],
      directiveTransforms: extend(
        {},
        directiveTransforms,
        options.directiveTransforms || {} // user transforms
      )
    })
  )

  // 3. 生成render函数代码并返回
  // 根据ast语法树生成代码
  //    1) 生成引入API 自定义组件 自定义指令 temps的代码，这里有按需引入，可以实现tree-shaking
  //    2) 生成render函数的return代码
  return generate(
    ast,
    extend({}, options, {
      prefixIdentifiers
    })
  )
}
