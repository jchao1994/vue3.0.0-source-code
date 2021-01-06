import {
  SourceLocation,
  Position,
  ElementNode,
  NodeTypes,
  CallExpression,
  createCallExpression,
  DirectiveNode,
  ElementTypes,
  TemplateChildNode,
  RootNode,
  ObjectExpression,
  Property,
  JSChildNode,
  createObjectExpression,
  SlotOutletNode,
  TemplateNode,
  RenderSlotCall,
  ExpressionNode,
  IfBranchNode,
  TextNode,
  InterpolationNode,
  VNodeCall
} from './ast'
import { TransformContext } from './transform'
import {
  MERGE_PROPS,
  TELEPORT,
  SUSPENSE,
  KEEP_ALIVE,
  BASE_TRANSITION
} from './runtimeHelpers'
import { isString, isObject, hyphenate, extend } from '@vue/shared'
import { parse } from '@babel/parser'
import { walk } from 'estree-walker'
import { Node } from '@babel/types'

export const isBuiltInType = (tag: string, expected: string): boolean =>
  tag === expected || tag === hyphenate(expected)

// teleport suspense keepAlive baseTransition
export function isCoreComponent(tag: string): symbol | void {
  if (isBuiltInType(tag, 'Teleport')) {
    return TELEPORT
  } else if (isBuiltInType(tag, 'Suspense')) {
    return SUSPENSE
  } else if (isBuiltInType(tag, 'KeepAlive')) {
    return KEEP_ALIVE
  } else if (isBuiltInType(tag, 'BaseTransition')) {
    return BASE_TRANSITION
  }
}

export const parseJS: typeof parse = (code, options) => {
  if (__BROWSER__) {
    assert(
      !__BROWSER__,
      `Expression AST analysis can only be performed in non-browser builds.`
    )
    return null as any
  } else {
    return parse(code, options)
  }
}

interface Walker {
  enter?(node: Node, parent: Node): void
  leave?(node: Node): void
}

export const walkJS = (ast: Node, walker: Walker) => {
  if (__BROWSER__) {
    assert(
      !__BROWSER__,
      `Expression AST analysis can only be performed in non-browser builds.`
    )
    return null as any
  } else {
    return (walk as any)(ast, walker)
  }
}

const nonIdentifierRE = /^\d|[^\$\w]/
// 数字 $ _ 开头 => 返回true
// 其他 => 返回false
export const isSimpleIdentifier = (name: string): boolean =>
  !nonIdentifierRE.test(name)

const memberExpRE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*$/
export const isMemberExpression = (path: string): boolean => {
  if (!path) return false
  return memberExpRE.test(path.trim())
}

// 根据整个value表达式的loc生成RHS的loc对象
// 返回的loc
// source指向loc.source.substr(offset, length)
// start指向loc.start+offset的位置
// end指向loc.start+offset+length的位置
export function getInnerRange(
  loc: SourceLocation, // 整个value表达式的loc
  offset: number,
  length?: number
): SourceLocation {
  __TEST__ && assert(offset <= loc.source.length)
  const source = loc.source.substr(offset, length)
  const newLoc: SourceLocation = {
    source,
    start: advancePositionWithClone(loc.start, loc.source, offset),
    end: loc.end
  }

  if (length != null) {
    __TEST__ && assert(offset + length <= loc.source.length)
    newLoc.end = advancePositionWithClone(
      loc.start,
      loc.source,
      offset + length
    )
  }

  return newLoc
}

// 不影响原pos，返回一个克隆的pos
// 返回的pos是解析完numberOfCharacters对应长度后的
export function advancePositionWithClone(
  pos: Position,
  source: string,
  numberOfCharacters: number = source.length
): Position {
  // 获取解析完numberOfCharacters之后的新的offset line column更新到pos中
  return advancePositionWithMutation(
    extend({}, pos),
    source,
    numberOfCharacters
  )
}

// advance by mutation without cloning (for performance reasons), since this
// gets called a lot in the parser
// 获取解析完numberOfCharacters之后的新的offset line column更新到pos中
export function advancePositionWithMutation(
  pos: Position, // context
  source: string, // context.source
  numberOfCharacters: number = source.length
): Position {
  // 这次numberOfCharacters所占的行数
  let linesCount = 0
  // 最后一次换行是numberOfCharacters中的第几个
  // numberOfCharacters - lastNewLinePos就表示了 最后一行的字符串个数+1，也就是指向下一列
  let lastNewLinePos = -1
  for (let i = 0; i < numberOfCharacters; i++) {
    // 换行
    if (source.charCodeAt(i) === 10 /* newline char code */) {
      linesCount++
      lastNewLinePos = i
    }
  }

  // offset跳过当前numberOfCharacters
  pos.offset += numberOfCharacters
  // 下一行
  pos.line += linesCount
  // 下一列
  pos.column =
    lastNewLinePos === -1
      ? pos.column + numberOfCharacters
      : numberOfCharacters - lastNewLinePos

  return pos
}

export function assert(condition: boolean, msg?: string) {
  /* istanbul ignore if */
  if (!condition) {
    throw new Error(msg || `unexpected compiler condition`)
  }
}

// 找到node上指令name对应的属性对象
export function findDir(
  node: ElementNode,
  name: string | RegExp,
  allowEmpty: boolean = false
): DirectiveNode | undefined {
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (
      p.type === NodeTypes.DIRECTIVE &&
      (allowEmpty || p.exp) &&
      (isString(name) ? p.name === name : name.test(p.name))
    ) {
      return p
    }
  }
}

export function findProp(
  node: ElementNode,
  name: string,
  dynamicOnly: boolean = false,
  allowEmpty: boolean = false
): ElementNode['props'][0] | undefined {
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (dynamicOnly) continue
      if (p.name === name && (p.value || allowEmpty)) {
        return p
      }
    } else if (p.name === 'bind' && p.exp && isBindKey(p.arg, name)) {
      return p
    }
  }
}

export function isBindKey(arg: DirectiveNode['arg'], name: string): boolean {
  return !!(
    arg &&
    arg.type === NodeTypes.SIMPLE_EXPRESSION &&
    arg.isStatic &&
    arg.content === name
  )
}

export function hasDynamicKeyVBind(node: ElementNode): boolean {
  return node.props.some(
    p =>
      p.type === NodeTypes.DIRECTIVE &&
      p.name === 'bind' &&
      (!p.arg || // v-bind="obj"
      p.arg.type !== NodeTypes.SIMPLE_EXPRESSION || // v-bind:[_ctx.foo]
        !p.arg.isStatic) // v-bind:[foo]
  )
}

export function isText(
  node: TemplateChildNode
): node is TextNode | InterpolationNode {
  return node.type === NodeTypes.INTERPOLATION || node.type === NodeTypes.TEXT
}

export function isVSlot(p: ElementNode['props'][0]): p is DirectiveNode {
  return p.type === NodeTypes.DIRECTIVE && p.name === 'slot'
}

export function isTemplateNode(
  node: RootNode | TemplateChildNode
): node is TemplateNode {
  return (
    node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.TEMPLATE
  )
}

// node是slot
export function isSlotOutlet(
  node: RootNode | TemplateChildNode
): node is SlotOutletNode {
  return node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.SLOT
}

// 给node对应的props或者arguments[2]中插入prop属性对象
export function injectProp(
  node: VNodeCall | RenderSlotCall,
  prop: Property,
  context: TransformContext
) {
  let propsWithInjection: ObjectExpression | CallExpression
  const props =
    node.type === NodeTypes.VNODE_CALL ? node.props : node.arguments[2]
  if (props == null || isString(props)) {
    propsWithInjection = createObjectExpression([prop])
  } else if (props.type === NodeTypes.JS_CALL_EXPRESSION) {
    // merged props... add ours
    // only inject key to object literal if it's the first argument so that
    // if doesn't override user provided keys
    const first = props.arguments[0] as string | JSChildNode
    if (!isString(first) && first.type === NodeTypes.JS_OBJECT_EXPRESSION) {
      first.properties.unshift(prop)
    } else {
      props.arguments.unshift(createObjectExpression([prop]))
    }
    propsWithInjection = props
  } else if (props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    let alreadyExists = false
    // check existing key to avoid overriding user provided keys
    if (prop.key.type === NodeTypes.SIMPLE_EXPRESSION) {
      const propKeyName = prop.key.content
      alreadyExists = props.properties.some(
        p =>
          p.key.type === NodeTypes.SIMPLE_EXPRESSION &&
          p.key.content === propKeyName
      )
    }
    if (!alreadyExists) {
      props.properties.unshift(prop)
    }
    propsWithInjection = props
  } else {
    // single v-bind with expression, return a merged replacement
    propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
      createObjectExpression([prop]),
      props
    ])
  }
  if (node.type === NodeTypes.VNODE_CALL) {
    node.props = propsWithInjection
  } else {
    node.arguments[2] = propsWithInjection
  }
}

// 将组件名和指令名非 大小字母 数字 下划线 转换为 _ ，并在开头加上 _component_ _directive_
export function toValidAssetId(
  name: string,
  type: 'component' | 'directive'
): string {
  // \w => 大小字母 数字 下划线
  return `_${type}_${name.replace(/[^\w]/g, '_')}`
}

// Check if a node contains expressions that reference current context scope ids
export function hasScopeRef(
  node: TemplateChildNode | IfBranchNode | ExpressionNode | undefined,
  ids: TransformContext['identifiers']
): boolean {
  if (!node || Object.keys(ids).length === 0) {
    return false
  }
  switch (node.type) {
    case NodeTypes.ELEMENT:
      for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i]
        if (
          p.type === NodeTypes.DIRECTIVE &&
          (hasScopeRef(p.arg, ids) || hasScopeRef(p.exp, ids))
        ) {
          return true
        }
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.FOR:
      if (hasScopeRef(node.source, ids)) {
        return true
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.IF:
      return node.branches.some(b => hasScopeRef(b, ids))
    case NodeTypes.IF_BRANCH:
      if (hasScopeRef(node.condition, ids)) {
        return true
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.SIMPLE_EXPRESSION:
      return (
        !node.isStatic &&
        isSimpleIdentifier(node.content) &&
        !!ids[node.content]
      )
    case NodeTypes.COMPOUND_EXPRESSION:
      return node.children.some(c => isObject(c) && hasScopeRef(c, ids))
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      return hasScopeRef(node.content, ids)
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      return false
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      return false
  }
}
