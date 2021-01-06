import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  ElementTypes,
  CallExpression,
  ObjectExpression,
  ElementNode,
  DirectiveNode,
  ExpressionNode,
  ArrayExpression,
  createCallExpression,
  createArrayExpression,
  createObjectProperty,
  createSimpleExpression,
  createObjectExpression,
  Property,
  ComponentNode,
  VNodeCall,
  TemplateTextChildNode,
  DirectiveArguments,
  createVNodeCall
} from '../ast'
import {
  PatchFlags,
  PatchFlagNames,
  isSymbol,
  isOn,
  isObject
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  RESOLVE_DIRECTIVE,
  RESOLVE_COMPONENT,
  RESOLVE_DYNAMIC_COMPONENT,
  MERGE_PROPS,
  TO_HANDLERS,
  TELEPORT,
  KEEP_ALIVE
} from '../runtimeHelpers'
import {
  getInnerRange,
  toValidAssetId,
  findProp,
  isCoreComponent,
  isBindKey,
  findDir
} from '../utils'
import { buildSlots } from './vSlot'
import { getStaticType } from './hoistStatic'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// generate a JavaScript AST for this element's codegen
// 处理 原生标签 | 组件
// 原生标签 | 组件 => 返回值是函数，目的是分析props children，更新shouldUseBlock patchFlag，最后创建type为 NodeTypes.VNODE_CALL 的对象作为node.codegenNode
export const transformElement: NodeTransform = (node, context) => {
  if (
    !(
      node.type === NodeTypes.ELEMENT &&
      (node.tagType === ElementTypes.ELEMENT || // 原生标签
        node.tagType === ElementTypes.COMPONENT) // 组件
    )
  ) {
    return
  }
  // perform the work on exit, after all child expressions have been
  // processed and merged.
  // 这个返回值函数作为onExit，traverse完node对应的整个树之后才会执行
  // 分析props children，更新shouldUseBlock patchFlag，最后创建type为 NodeTypes.VNODE_CALL 的对象作为node.codegenNode
  return function postTransformElement() {
    const { tag, props } = node
    // 是否是组件
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    // transform的目的是创建codegenNode来执行VNodeCall接口
    const vnodeTag = isComponent
      // 解析组件的name
      // 动态组件，返回 is | v-is 对应的type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      // 内建组件，找到内置名字直接返回
      // 自定义组件，返回 _component_${tag}
      ? resolveComponentType(node as ComponentNode, context)
      : `"${tag}"`
    // 动态组件 is | v-is
    const isDynamicComponent =
      isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT

    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let vnodePatchFlag: VNodeCall['patchFlag']
    let patchFlag: number = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    // 动态组件 | svg标签 | foreignObject标签 | 带动态key的原生标签，这四类需要使用block
    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      isDynamicComponent || // 动态组件
      (!isComponent && // 非组件
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        (tag === 'svg' || // svg
          tag === 'foreignObject' || // foreignObject
          // #938: elements with dynamic keys should be forced into blocks
          findProp(node, 'key', true))) // 有动态key属性 :key="xxx"

    // props
    // 处理props
    if (props.length > 0) {
      // 分析所有属性，根据属性是否动态，以及属性名动态还是属性值动态，进行标记
      // 返回 
      //    { props: propsExpression, // 分析完成的属性对象
      //      directives: runtimeDirectives, // 需要runtime的指令
      //      patchFlag, // patch标志，用于优化
      //      dynamicPropNames // 动态属性，用于优化
      //    }
      const propsBuildResult = buildProps(node, context)
      vnodeProps = propsBuildResult.props // 分析完成的属性对象
      patchFlag = propsBuildResult.patchFlag // patch标志，用于优化
      dynamicPropNames = propsBuildResult.dynamicPropNames // 动态属性，用于优化
      const directives = propsBuildResult.directives // 需要runtime的指令
      // type为NodeTypes.JS_ARRAY_EXPRESSION的对象
      vnodeDirectives =
        directives && directives.length
          // 创建type为NodeTypes.JS_ARRAY_EXPRESSION的对象
          ? (createArrayExpression(
              directives.map(dir => buildDirectiveArgs(dir, context))
            ) as DirectiveArguments)
          : undefined
    }

    // children
    // 处理children  KEEP_ALIVE 组件slots 原生标签children
    // 更新patchFlag，生成vnodeChildren
    if (node.children.length > 0) {
      if (vnodeTag === KEEP_ALIVE) { // keep-alive组件，设置为block，并标记 PatchFlags.DYNAMIC_SLOTS 强制更新
        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.
        // 将keep-alive设置为block，避免children作为其父block的children
        shouldUseBlock = true
        // 2. Force keep-alive to always be updated, since it uses raw children.
        // 标记PatchFlags.DYNAMIC_SLOTS，每次都会更新
        patchFlag |= PatchFlags.DYNAMIC_SLOTS
        if (__DEV__ && node.children.length > 1) {
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: ''
            })
          )
        }
      }

      // 组件的children作为slots
      const shouldBuildAsSlots =
        isComponent && // 组件
        // Teleport is not a real component and has dedicated runtime handling
        vnodeTag !== TELEPORT && // 非teleport
        // explained above.
        vnodeTag !== KEEP_ALIVE // 非keep-alive

      if (shouldBuildAsSlots) { // 组件传入children作为slots
        // buildSlots 暂时不看???
        const { slots, hasDynamicSlots } = buildSlots(node, context)
        vnodeChildren = slots
        // 标记 PatchFlags.DYNAMIC_SLOTS
        if (hasDynamicSlots) {
          patchFlag |= PatchFlags.DYNAMIC_SLOTS
        }
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) { // 原生标签 且 只有一个child
        const child = node.children[0]
        const type = child.type
        // check for dynamic text children
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION ||
          type === NodeTypes.COMPOUND_EXPRESSION
        // 标记 PatchFlags.TEXT 动态文本
        if (hasDynamicTextChild && !getStaticType(child)) {
          patchFlag |= PatchFlags.TEXT
        }
        // pass directly if the only child is a text node
        // (plain / interpolation / expression)
        if (hasDynamicTextChild || type === NodeTypes.TEXT) {
          vnodeChildren = child as TemplateTextChildNode
        } else {
          vnodeChildren = node.children
        }
      } else { // 原生标签 且 有多个child
        vnodeChildren = node.children
      }
    }

    // patchFlag & dynamicPropNames
    if (patchFlag !== 0) {
      if (__DEV__) {
        if (patchFlag < 0) {
          // special flags (negative and mutually exclusive)
          vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
        } else {
          // bitwise flags
          const flagNames = Object.keys(PatchFlagNames)
            .map(Number)
            .filter(n => n > 0 && patchFlag & n)
            .map(n => PatchFlagNames[n])
            .join(`, `)
          vnodePatchFlag = patchFlag + ` /* ${flagNames} */`
        }
      } else {
        // patchFlag转为string
        vnodePatchFlag = String(patchFlag)
      }
      // dynamicPropNames拼接成JSON字符串
      if (dynamicPropNames && dynamicPropNames.length) {
        vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames)
      }
    }

    // 创建type为 NodeTypes.VNODE_CALL 的对象作为node.codegenNode
    node.codegenNode = createVNodeCall(
      context,
      vnodeTag, // 标签名，如 "div"
      vnodeProps, // 分析完成的属性对象
      vnodeChildren, // 组件slots | 原生标签children
      vnodePatchFlag, // patchFlag字符串，如 8 /* PROPS */
      vnodeDynamicProps, // dynamicPropNames拼接成JSON字符串，如 ["name"]
      vnodeDirectives, // runtime指令对应的type为NodeTypes.JS_ARRAY_EXPRESSION的对象
      !!shouldUseBlock, // block标志
      false /* isForBlock */,
      node.loc
    )
  }
}

// 解析组件的name
// 动态组件，返回 is | v-is 对应的type为 NodeTypes.JS_CALL_EXPRESSION 的对象
// 内建组件，找到内置名字直接返回
// 自定义组件，返回 _component_${tag}
export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false
) {
  const { tag } = node

  // 1. dynamic component
  // 动态组件
  const isProp =
    node.tag === 'component' ? findProp(node, 'is') : findDir(node, 'is')
  // 有 is | v-is，也就是动态组件，返回 is | v-is 对应的type为 NodeTypes.JS_CALL_EXPRESSION 的对象
  if (isProp) {
    const exp =
      isProp.type === NodeTypes.ATTRIBUTE
        ? isProp.value && createSimpleExpression(isProp.value.content, true)
        : isProp.exp
    if (exp) {
      // 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
        exp
      ])
    }
  }

  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
  // 内建组件，找到内置名字直接返回
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // built-ins are simply fallthroughs / have special handling during ssr
    // no we don't need to import their runtime equivalents
    if (!ssr) context.helper(builtIn)
    return builtIn
  }

  // 3. user component (resolve)
  // 自定义组件，将tag添加到context.components中
  context.helper(RESOLVE_COMPONENT)
  context.components.add(tag)
  // 返回 _component_${tag}
  return toValidAssetId(tag, `component`)
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

// 分析所有属性，根据属性是否动态，以及属性名动态还是属性值动态，进行标记
// 返回 
//    { props: propsExpression, // 分析完成的属性对象
//      directives: runtimeDirectives, // 需要runtime的指令
//      patchFlag, // patch标志，用于优化
//      dynamicPropNames // 动态属性，用于优化
//    }
export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] = node.props,
  ssr = false
): {
  props: PropsExpression | undefined
  directives: DirectiveNode[]
  patchFlag: number
  dynamicPropNames: string[]
} {
  const { tag, loc: elementLoc } = node
  // 是否是组件
  const isComponent = node.tagType === ElementTypes.COMPONENT
  let properties: ObjectExpression['properties'] = []
  const mergeArgs: PropsExpression[] = []
  const runtimeDirectives: DirectiveNode[] = []

  // patchFlag analysis
  let patchFlag = 0
  let hasRef = false
  let hasClassBinding = false
  let hasStyleBinding = false
  let hasHydrationEventBinding = false
  let hasDynamicKeys = false
  const dynamicPropNames: string[] = []

  const analyzePatchFlag = ({ key, value }: Property) => {
    if (key.type === NodeTypes.SIMPLE_EXPRESSION && key.isStatic) { // 静态key
      // 属性名
      const name = key.content
      if (
        !isComponent && // 非组件
        isOn(name) && // onXXX
        // omit the flag for click handlers becaues hydration gives click
        // dedicated fast path.
        name.toLowerCase() !== 'onclick' && // 不是onclick
        // omit v-model handlers
        name !== 'onUpdate:modelValue' // 不是v-model的onUpdate:modelValue
      ) {
        hasHydrationEventBinding = true
      }
      // 缓存或是常量的属性直接return
      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION ||
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getStaticType(value) > 0)
      ) {
        // skip if the prop is a cached handler or has constant value
        return
      }
      if (name === 'ref') { // 标记hasRef
        hasRef = true
      } else if (name === 'class' && !isComponent) { // 非组件 标记hasClassBinding
        hasClassBinding = true
      } else if (name === 'style' && !isComponent) { // 非组件 标记hasStyleBinding
        hasStyleBinding = true
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) { // 动态属性
        dynamicPropNames.push(name)
      }
    } else { // 动态key，标记hasDynamicKeys
      hasDynamicKeys = true
    }
  }

  // 遍历props
  // 更新properties mergeArgs(v-bind/v-on的对象语法才会有这个mergeArgs) runtimeDirectives
  for (let i = 0; i < props.length; i++) {
    // static attribute
    const prop = props[i]
    if (prop.type === NodeTypes.ATTRIBUTE) { // 普通属性，也就是静态属性
      const { loc, name, value } = prop
      if (name === 'ref') {
        hasRef = true
      }
      // skip :is on <component>
      // 忽略组件上的 is 属性，应该不是 :is
      if (name === 'is' && tag === 'component') {
        continue
      }
      properties.push(
        // 创建type为NodeTypes.JS_PROPERTY的对象
        createObjectProperty(
          // 创建type为NodeTypes.SIMPLE_EXPRESSION的对象
          createSimpleExpression(
            name,
            true,
            // name对应的loc对象
            getInnerRange(loc, 0, name.length)
          ),
          // 创建type为NodeTypes.SIMPLE_EXPRESSION的对象
          createSimpleExpression(
            value ? value.content : '',
            true,
            value ? value.loc : loc
          )
        )
      )
    } else { // 指令 v- : @ #
      // directives
      // name => 指令名
      // arg => 属性名对象，没有属性名的情况这里为undefined，如 v-xxx
      // exp => value对象，没有属性值的情况这里为undefined，如 #default v-xxx
      // loc => 从属性名开始到value结束的loc
      const { name, arg, exp, loc } = prop
      // v-bind :
      const isBind = name === 'bind'
      // v-on @
      const isOn = name === 'on'

      // skip v-slot - it is handled by its dedicated transform.
      // v-slot不在这里处理
      if (name === 'slot') {
        // v-slot只支持组件，其他会报错
        if (!isComponent) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc)
          )
        }
        continue
      }
      // skip v-once - it is handled by its dedicated transform.
      // v-once不在这里处理
      if (name === 'once') {
        continue
      }
      // skip v-is and :is on <component>
      // v-is :is不在这里处理
      if (
        name === 'is' ||
        (isBind && tag === 'component' && isBindKey(arg, 'is'))
      ) {
        continue
      }
      // skip v-on in SSR compilation
      // SSR中不处理v-on
      if (isOn && ssr) {
        continue
      }

      // special case for v-bind and v-on with no argument
      // 没有属性名的v-bind v-on，如 v-on="{ mousedown: doThis, mouseup: doThat }" 对象语法
      // 对properties做处理，最终都推入mergeArgs，然后结束当前循环，进行下一个prop
      if (!arg && (isBind || isOn)) {
        hasDynamicKeys = true
        if (exp) { // 正常都有value对象，对properties做处理，最终都推入mergeArgs
          // 将前面解析properties做合并style class onXXX处理，推入mergeArgs中
          if (properties.length) {
            mergeArgs.push(
              // 合并style class onXXX，动态key继续保留
              // 创建type为NodeTypes.JS_OBJECT_EXPRESSION的对象
              createObjectExpression(dedupeProperties(properties), elementLoc)
            )
            properties = []
          }
          if (isBind) { // v-bind :  直接将exp推入mergeArgs
            mergeArgs.push(exp)
          } else { // v-on @  将type为NodeTypes.JS_CALL_EXPRESSION的对象推入mergeArgs
            // v-on="obj" -> toHandlers(obj)
            mergeArgs.push({
              type: NodeTypes.JS_CALL_EXPRESSION,
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: [exp]
            })
          }
        } else { // 没有value对象，报错
          context.onError(
            createCompilerError(
              isBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc
            )
          )
        }
        continue
      }

      // 处理指令，内建指令直接推入properties，需要runtime的推入runtimeDirectives
      // 自定义指令一律推入runtimeDirectives
      // 内建指令 v-cloak v-html v-text v-model v-on v-show
      const directiveTransform = context.directiveTransforms[name]
      if (directiveTransform) { // 内建指令
        // has built-in directive transform.
        // 内建指令directiveTransform 暂时不看???
        // v-bind => 处理camel修饰符，更新属性名对象arg的content或children，最后创建type为NodeTypes.JS_PROPERTY的对象返回
        const { props, needRuntime } = directiveTransform(prop, node, context)
        !ssr && props.forEach(analyzePatchFlag)
        properties.push(...props)
        if (needRuntime) {
          runtimeDirectives.push(prop)
          if (isSymbol(needRuntime)) {
            directiveImportMap.set(prop, needRuntime)
          }
        }
      } else { // 自定义指令
        // no built-in transform, this is a user custom directive.
        runtimeDirectives.push(prop)
      }
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // 生成propsExpression
  // has v-bind="object" or v-on="object", wrap with mergeProps
  if (mergeArgs.length) { // 有mergeArgs，说明有v-bind v-on对象语法
    // 将前面解析properties做合并style class onXXX处理，推入mergeArgs中
    // 同上，上面的循环遍历处理了对象语法之前的properties，这里处理对象语法之后的properties
    if (properties.length) {
      mergeArgs.push(
        createObjectExpression(dedupeProperties(properties), elementLoc)
      )
    }
    if (mergeArgs.length > 1) {
      // 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
      propsExpression = createCallExpression(
        context.helper(MERGE_PROPS),
        mergeArgs,
        elementLoc
      )
    } else { // 对象语法，但是对象中是单个，直接作为propsExpression
      // single v-bind with nothing else - no need for a mergeProps call
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) { // 没有mergeArgs，说明没有v-bind v-on对象语法
    // 创建type为NodeTypes.JS_OBJECT_EXPRESSION的对象
    propsExpression = createObjectExpression(
      dedupeProperties(properties),
      elementLoc
    )
  }

  // patchFlag analysis
  // 根据所有属性的情况，设置patchFlag
  if (hasDynamicKeys) { // 动态属性名
    patchFlag |= PatchFlags.FULL_PROPS
  } else {
    if (hasClassBinding) { // 动态class
      patchFlag |= PatchFlags.CLASS
    }
    if (hasStyleBinding) { // 动态style
      patchFlag |= PatchFlags.STYLE
    }
    if (dynamicPropNames.length) { // 有动态属性，key是静态的
      patchFlag |= PatchFlags.PROPS
    }
    if (hasHydrationEventBinding) { // 需要混合events
      patchFlag |= PatchFlags.HYDRATE_EVENTS
    }
  }
  // 根据属性判断不需要patch的情况，如果有ref或者需要runtime的指令，就还是需要patch的，标记PatchFlags.NEED_PATCH
  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || runtimeDirectives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH
  }

  return {
    props: propsExpression, // 分析完成的属性对象
    directives: runtimeDirectives, // 需要runtime的指令
    patchFlag, // patch标志，用于优化
    dynamicPropNames // 动态属性，用于优化
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
// 合并style class onXXX，动态key继续保留
function dedupeProperties(properties: Property[]): Property[] {
  const knownProps: Map<string, Property> = new Map()
  const deduped: Property[] = []
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]
    // dynamic keys are always allowed
    // 动态key
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }
    const name = prop.key.content
    const existing = knownProps.get(name)
    // 合并style class onXXX
    if (existing) {
      if (name === 'style' || name === 'class' || name.startsWith('on')) {
        mergeAsArray(existing, prop)
      }
      // unexpected duplicate, should have emitted error during parse
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

function mergeAsArray(existing: Property, incoming: Property) {
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.value.elements.push(incoming.value)
  } else {
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc
    )
  }
}

function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext
): ArrayExpression {
  const dirArgs: ArrayExpression['elements'] = []
  const runtime = directiveImportMap.get(dir)
  if (runtime) {
    dirArgs.push(context.helperString(runtime))
  } else {
    // inject statement for resolving directive
    context.helper(RESOLVE_DIRECTIVE)
    context.directives.add(dir.name)
    dirArgs.push(toValidAssetId(dir.name, `directive`))
  }
  const { loc } = dir
  if (dir.exp) dirArgs.push(dir.exp)
  if (dir.arg) {
    if (!dir.exp) {
      dirArgs.push(`void 0`)
    }
    dirArgs.push(dir.arg)
  }
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) {
      if (!dir.exp) {
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      createObjectExpression(
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression)
        ),
        loc
      )
    )
  }
  return createArrayExpression(dirArgs, dir.loc)
}

// props拼接成JSON字符串
function stringifyDynamicPropNames(props: string[]): string {
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}
