import {
  NodeTransform,
  NodeTypes,
  ElementTypes,
  TemplateLiteral,
  createTemplateLiteral,
  createInterpolation,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  buildProps,
  DirectiveNode,
  PlainElementNode,
  createCompilerError,
  ErrorCodes,
  CallExpression,
  createArrayExpression,
  ExpressionNode,
  JSChildNode,
  ArrayExpression,
  createAssignmentExpression,
  TextNode,
  hasDynamicKeyVBind,
  MERGE_PROPS,
  isBindKey,
  createSequenceExpression
} from '@vue/compiler-dom'
import {
  escapeHtml,
  isBooleanAttr,
  isSSRSafeAttrName,
  NO,
  propsToAttrMap
} from '@vue/shared'
import { createSSRCompilerError, SSRErrorCodes } from '../errors'
import {
  SSR_RENDER_ATTR,
  SSR_RENDER_CLASS,
  SSR_RENDER_STYLE,
  SSR_RENDER_DYNAMIC_ATTR,
  SSR_RENDER_ATTRS,
  SSR_INTERPOLATE,
  SSR_GET_DYNAMIC_MODEL_PROPS
} from '../runtimeHelpers'
import { SSRTransformContext, processChildren } from '../ssrCodegenTransform'

// for directives with children overwrite (e.g. v-html & v-text), we need to
// store the raw children so that they can be added in the 2nd pass.
const rawChildrenMap = new WeakMap<
  PlainElementNode,
  TemplateLiteral['elements'][0]
>()

// 原生dom标签
// 返回onExit函数，处理标签上的所有属性(包括指令和静态属性，除了v-on，因为ssr不处理事件)
export const ssrTransformElement: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT
  ) {
    return function ssrPostTransformElement() {
      // element
      // generate the template literal representing the open tag.
      // 起始标签
      const openTag: TemplateLiteral['elements'] = [`<${node.tag}`]
      // some tags need to be pasesd to runtime for special checks
      const needTagForRuntime =
        node.tag === 'textarea' || node.tag.indexOf('-') > 0

      // v-bind="obj" or v-bind:[key] can potentially overwrite other static
      // attrs and can affect final rendering result, so when they are present
      // we need to bail out to full `renderAttrs`
      // 是否有动态key的v-bind
      const hasDynamicVBind = hasDynamicKeyVBind(node)
      // 有动态key的v-bind
      if (hasDynamicVBind) {
        // 分析所有属性，根据属性是否动态，以及属性名动态还是属性值动态，进行标记
        // 返回 
        //    { props: propsExpression, // 分析完成的属性对象
        //      directives: runtimeDirectives, // 需要runtime的指令
        //      patchFlag, // patch标志，用于优化
        //      dynamicPropNames // 动态属性，用于优化
        //    }
        // ssr标志会做一些特殊处理，比如省略v-on，因为ssr不处理事件相关逻辑，只负责页面结构
        const { props } = buildProps(node, context, node.props, true /* ssr */)
        if (props) {
          // NodeTypes.JS_CALL_EXPRESSION
          const propsExp = createCallExpression(
            context.helper(SSR_RENDER_ATTRS),
            [props]
          )
          
          // 带动态绑定v-bind的textarea和input标签做另外处理
          if (node.tag === 'textarea') {
            // <textarea> with dynamic v-bind. We don't know if the final props
            // will contain .value, so we will have to do something special:
            // assign the merged props to a temp variable, and check whether
            // it contains value (if yes, render is as children).
            const tempId = `_temp${context.temps++}`
            propsExp.arguments = [
              // NodeTypes.JS_ASSIGNMENT_EXPRESSION
              createAssignmentExpression(
                // NodeTypes.SIMPLE_EXPRESSION
                createSimpleExpression(tempId, false),
                props
              )
            ]
            const existingText = node.children[0] as TextNode | undefined
            rawChildrenMap.set(
              node,
              createCallExpression(context.helper(SSR_INTERPOLATE), [
                createConditionalExpression(
                  createSimpleExpression(`"value" in ${tempId}`, false),
                  createSimpleExpression(`${tempId}.value`, false),
                  createSimpleExpression(
                    existingText ? existingText.content : ``,
                    true
                  ),
                  false
                )
              ])
            )
          } else if (node.tag === 'input') {
            // <input v-bind="obj" v-model>
            // we need to determine the props to render for the dynamic v-model
            // and merge it with the v-bind expression.
            const vModel = findVModel(node)
            if (vModel) {
              // 1. save the props (san v-model) in a temp variable
              const tempId = `_temp${context.temps++}`
              const tempExp = createSimpleExpression(tempId, false)
              propsExp.arguments = [
                // NodeTypes.JS_SEQUENCE_EXPRESSION
                createSequenceExpression([
                  createAssignmentExpression(tempExp, props),
                  createCallExpression(context.helper(MERGE_PROPS), [
                    tempExp,
                    createCallExpression(
                      context.helper(SSR_GET_DYNAMIC_MODEL_PROPS),
                      [
                        tempExp, // existing props
                        vModel.exp! // model
                      ]
                    )
                  ])
                ])
              ]
            }
          }

          if (needTagForRuntime) {
            propsExp.arguments.push(`"${node.tag}"`)
          }

          openTag.push(propsExp)
        }
      }

      // book keeping static/dynamic class merging.
      let dynamicClassBinding: CallExpression | undefined = undefined
      let staticClassBinding: string | undefined = undefined
      // all style bindings are converted to dynamic by transformStyle.
      // but we need to make sure to merge them.
      let dynamicStyleBinding: CallExpression | undefined = undefined

      for (let i = 0; i < node.props.length; i++) {
        const prop = node.props[i]
        // special cases with children override
        if (prop.type === NodeTypes.DIRECTIVE) { // 指令 v-xxx
          if (prop.name === 'html' && prop.exp) { // v-html
            rawChildrenMap.set(node, prop.exp)
          } else if (prop.name === 'text' && prop.exp) { // v-text
            // NodeTypes.INTERPOLATION
            node.children = [createInterpolation(prop.exp, prop.loc)]
          } else if (prop.name === 'slot') { // v-slot
            context.onError(
              createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, prop.loc)
            )
          } else if (isTextareaWithValue(node, prop) && prop.exp) { // textarea标签且v-bind="value"
            if (!hasDynamicVBind) { // v-bind的key是静态的
              node.children = [createInterpolation(prop.exp, prop.loc)]
            }
          } else { // v-bind v-model v-cloak v-once
            // Directive transforms.
            // v-bind v-model v-show v-on v-cloak v-once
            const directiveTransform = context.directiveTransforms[prop.name]
            if (!directiveTransform) {
              // no corresponding ssr directive transform found.
              context.onError(
                createSSRCompilerError(
                  SSRErrorCodes.X_SSR_CUSTOM_DIRECTIVE_NO_TRANSFORM,
                  prop.loc
                )
              )
            } else if (!hasDynamicVBind) { // 不是v-bind
              // directiveTransform还没看???
              const { props, ssrTagParts } = directiveTransform(
                prop,
                node,
                context
              )
              if (ssrTagParts) {
                openTag.push(...ssrTagParts)
              }
              for (let j = 0; j < props.length; j++) {
                const { key, value } = props[j]
                if (key.type === NodeTypes.SIMPLE_EXPRESSION && key.isStatic) {
                  let attrName = key.content
                  // static key attr
                  if (attrName === 'class') {
                    openTag.push(
                      ` class="`,
                      (dynamicClassBinding = createCallExpression(
                        context.helper(SSR_RENDER_CLASS),
                        [value]
                      )),
                      `"`
                    )
                  } else if (attrName === 'style') {
                    if (dynamicStyleBinding) {
                      // already has style binding, merge into it.
                      mergeCall(dynamicStyleBinding, value)
                    } else {
                      openTag.push(
                        ` style="`,
                        (dynamicStyleBinding = createCallExpression(
                          context.helper(SSR_RENDER_STYLE),
                          [value]
                        )),
                        `"`
                      )
                    }
                  } else {
                    attrName =
                      node.tag.indexOf('-') > 0
                        ? attrName // preserve raw name on custom elements
                        : propsToAttrMap[attrName] || attrName.toLowerCase()
                    if (isBooleanAttr(attrName)) {
                      openTag.push(
                        createConditionalExpression(
                          value,
                          createSimpleExpression(' ' + attrName, true),
                          createSimpleExpression('', true),
                          false /* no newline */
                        )
                      )
                    } else if (isSSRSafeAttrName(attrName)) {
                      openTag.push(
                        createCallExpression(context.helper(SSR_RENDER_ATTR), [
                          key,
                          value
                        ])
                      )
                    } else {
                      context.onError(
                        createSSRCompilerError(
                          SSRErrorCodes.X_SSR_UNSAFE_ATTR_NAME,
                          key.loc
                        )
                      )
                    }
                  }
                } else {
                  // dynamic key attr
                  // this branch is only encountered for custom directive
                  // transforms that returns properties with dynamic keys
                  const args: CallExpression['arguments'] = [key, value]
                  if (needTagForRuntime) {
                    args.push(`"${node.tag}"`)
                  }
                  openTag.push(
                    createCallExpression(
                      context.helper(SSR_RENDER_DYNAMIC_ATTR),
                      args
                    )
                  )
                }
              }
            }
          }
        } else {
          // special case: value on <textarea>
          if (node.tag === 'textarea' && prop.name === 'value' && prop.value) { // textarea标签的value静态属性
            rawChildrenMap.set(node, escapeHtml(prop.value.content))
          } else if (!hasDynamicVBind) { // 没有动态key的v-bind的情况下的静态属性
            // static prop
            if (prop.name === 'class' && prop.value) {
              staticClassBinding = JSON.stringify(prop.value.content)
            }
            // 静态属性直接key=value
            openTag.push(
              ` ${prop.name}` +
                (prop.value ? `="${escapeHtml(prop.value.content)}"` : ``)
            )
          }
        }
      }

      // handle co-existence of dynamic + static class bindings
      // 将静态class合并到动态class对象上，并移除原来的静态class
      // class="aaa" => class="aaa"
      // class="aaa" :class="bbb" => _ssrRenderClass([_ctx.bbb, "aaa"])
      if (dynamicClassBinding && staticClassBinding) {
        mergeCall(dynamicClassBinding, staticClassBinding)
        // 移除key为class的静态类名
        removeStaticBinding(openTag, 'class')
      }

      if (context.scopeId) {
        openTag.push(` ${context.scopeId}`)
      }

      // 生成ssrCodegenNode NodeTypes.JS_TEMPLATE_LITERAL
      // openTag包括起始标签 静态属性 指令 scopeId
      node.ssrCodegenNode = createTemplateLiteral(openTag)
    }
  }
}

// textarea标签且v-bind="value"
function isTextareaWithValue(
  node: PlainElementNode,
  prop: DirectiveNode
): boolean {
  return !!(
    node.tag === 'textarea' &&
    prop.name === 'bind' &&
    isBindKey(prop.arg, 'value')
  )
}

// 将静态class合并到动态class对象上
function mergeCall(call: CallExpression, arg: string | JSChildNode) {
  const existing = call.arguments[0] as ExpressionNode | ArrayExpression
  if (existing.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.elements.push(arg)
  } else {
    call.arguments[0] = createArrayExpression([existing, arg])
  }
}

// 移除key为binding的静态部分
function removeStaticBinding(
  tag: TemplateLiteral['elements'],
  binding: string
) {
  const i = tag.findIndex(
    e => typeof e === 'string' && e.startsWith(` ${binding}=`)
  )
  if (i > -1) {
    tag.splice(i, 1)
  }
}

function findVModel(node: PlainElementNode): DirectiveNode | undefined {
  return node.props.find(
    p => p.type === NodeTypes.DIRECTIVE && p.name === 'model' && p.exp
  ) as DirectiveNode | undefined
}

// 原生dom
// <div><div></div><div></div></div>
// => _push(`<div${_ssrRenderAttrs(_mergeProps(_attrs, _cssVars))}><div></div><div></div></div>`
export function ssrProcessElement(
  node: PlainElementNode,
  context: SSRTransformContext
) {
   // 单标签
  const isVoidTag = context.options.isVoidTag || NO
  // 起始标签 静态属性 指令 scopeId
  const elementsToAdd = node.ssrCodegenNode!.elements
  for (let j = 0; j < elementsToAdd.length; j++) {
    context.pushStringPart(elementsToAdd[j])
  }

  // Handle slot scopeId
  if (context.withSlotScopeId) {
    // NodeTypes.SIMPLE_EXPRESSION
    context.pushStringPart(createSimpleExpression(`_scopeId`, false))
  }

  // close open tag
  context.pushStringPart(`>`)

  const rawChildren = rawChildrenMap.get(node)
  if (rawChildren) { // rawChildren是什么???
    context.pushStringPart(rawChildren)
  } else if (node.children.length) { // 递归遍历children
    processChildren(node.children, context)
  }

  // 不是单标签，添加结束标签
  if (!isVoidTag(node.tag)) {
    // push closing tag
    context.pushStringPart(`</${node.tag}>`)
  }
}
