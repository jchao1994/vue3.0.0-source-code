import {
  CodegenResult,
  baseParse,
  parserOptions,
  transform,
  generate,
  CompilerOptions,
  transformExpression,
  trackVForSlotScopes,
  trackSlotScopes,
  noopDirectiveTransform,
  transformBind,
  transformStyle
} from '@vue/compiler-dom'
import { ssrCodegenTransform } from './ssrCodegenTransform'
import { ssrTransformElement } from './transforms/ssrTransformElement'
import {
  ssrTransformComponent,
  rawOptionsMap
} from './transforms/ssrTransformComponent'
import { ssrTransformSlotOutlet } from './transforms/ssrTransformSlotOutlet'
import { ssrTransformIf } from './transforms/ssrVIf'
import { ssrTransformFor } from './transforms/ssrVFor'
import { ssrTransformModel } from './transforms/ssrVModel'
import { ssrTransformShow } from './transforms/ssrVShow'

export function compile(
  template: string,
  options: CompilerOptions = {}
): CodegenResult {
  options = {
    ...options,
    // apply DOM-specific parsing options
    ...parserOptions,
    ssr: true,
    scopeId: options.mode === 'function' ? null : options.scopeId,
    // always prefix since compiler-ssr doesn't have size concern
    prefixIdentifiers: true,
    // disable optimizations that are unnecessary for ssr
    cacheHandlers: false,
    hoistStatic: false
  }

  // 1. 解析模板字符串，返回ast语法树，同客户端编译
  const ast = baseParse(template, options)

  // Save raw options for AST. This is needed when performing sub-transforms
  // on slot vnode branches.
  rawOptionsMap.set(ast, options)

  // 2. 给解析完成的ast语法树上进行第一步处理，用于后续转换成context.body，并整合成根ast.codegenNode
  // transform同客户端编译，但nodeTransforms和directiveTransforms不同
  transform(ast, {
    ...options,
    nodeTransforms: [
      // ssr中的v-if v-else-if v-else不通过alternate连接，只存放在ifNode.branches上，每一个branch对象type为NodeTypes.IF_BRANCH
      // ssr的ifNode没有codegenNode属性
      // 返回值是onExit函数，创建ifNode替换原node，将v-if v-else-if v-else分别创建一个branch对象，存放在ifNode.branches上
      ssrTransformIf,
      // ssr的forNode没有codegenNode属性，也不处理slot的key、fragment包裹、标记isBlock
      // 返回值是onExit函数，创建forNode替换原node
      ssrTransformFor,
      // 带v-for和v-slot的template标签 => context上增加value key index计数，返回onExit函数，context上减少value key index计数
      trackVForSlotScopes,
      // {{}}Mustache语法 非v-for的指令属性值对象 动态指令属性名的属性名对象 => 给node中的变量添加前缀 _ctx. ，将node转换成NodeTypes.COMPOUND_EXPRESSION，或保持原node
      transformExpression,
      // slot标签 => 无返回值，生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
      ssrTransformSlotOutlet,
      // 原生dom标签 => 返回onExit函数，处理标签上的所有属性(包括指令和静态属性，除了v-on，因为ssr不处理事件)，生成ssrCodegenNode NodeTypes.JS_TEMPLATE_LITERAL
      ssrTransformElement,
      // 组件 => 返回onExit函数，处理v-slot以及children，对每一个v-slot做一份失败备用分支，最后生成ssrCodegenNode NodeTypes.JS_CALL_EXPRESSION
      ssrTransformComponent,
      // 带v-slot或#的 组件 | template，也就是具名插槽，context.scopes.vSlot计数加1，返回值函数用于计数减1
      trackSlotScopes,
      // 将静态属性style转换成动态绑定:style，等到transformElement返回的onExit执行时会对其做处理
      transformStyle,
      ...(options.nodeTransforms || []) // user transforms
    ],
    directiveTransforms: {
      // reusing core v-bind
      // 同客户端编译
      bind: transformBind,
      // model and show has dedicated SSR handling
      model: ssrTransformModel,
      show: ssrTransformShow,
      // the following are ignored during SSR
      on: noopDirectiveTransform,
      cloak: noopDirectiveTransform,
      once: noopDirectiveTransform,
      ...(options.directiveTransforms || {}) // user transforms
    }
  })

  // traverse the template AST and convert into SSR codegen AST
  // by replacing ast.codegenNode.
  // 3. 根据上面transform的结果，对ast做第二步处理，将ast节点处理到context.body，最后整体作为ast.codegenNode，用于后续生成ssrRender函数
  // 递归处理整个ast树，结果存储在context.body上的多组 currentCall | statement
  // 最后将整个context.body创建成NodeTypes.JS_BLOCK_STATEMENT，作为根ast.codegenNode
  ssrCodegenTransform(ast, options)

  // 4. 生成ssrRender函数代码并返回
  // 根据ast语法树生成代码
  //    1) 生成引入API 自定义组件 自定义指令 temps的代码，这里有按需引入，可以实现tree-shaking
  //    2) 生成ssrRender函数的return代码
  return generate(ast, options)
}
