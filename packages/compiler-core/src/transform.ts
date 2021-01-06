import { TransformOptions } from './options'
import {
  RootNode,
  NodeTypes,
  ParentNode,
  TemplateChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode,
  SimpleExpressionNode,
  ElementTypes,
  CacheExpression,
  createCacheExpression,
  TemplateLiteral,
  createVNodeCall
} from './ast'
import {
  isString,
  isArray,
  NOOP,
  PatchFlags,
  PatchFlagNames
} from '@vue/shared'
import { defaultOnError } from './errors'
import {
  TO_DISPLAY_STRING,
  FRAGMENT,
  helperNameMap,
  CREATE_BLOCK,
  CREATE_COMMENT,
  OPEN_BLOCK
} from './runtimeHelpers'
import { isVSlot } from './utils'
import { hoistStatic, isSingleElementRoot } from './transforms/hoistStatic'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  // a platform specific compiler can import the base transform and augment
  // it by passing in this optional argument.
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult
) => DirectiveTransformResult

export interface DirectiveTransformResult {
  props: Property[]
  needRuntime?: boolean | symbol
  ssrTagParts?: TemplateLiteral['elements']
}

// A structural directive transform is a technically a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface ImportItem {
  exp: string | ExpressionNode
  path: string
}

export interface TransformContext extends Required<TransformOptions> {
  root: RootNode
  helpers: Set<symbol>
  components: Set<string>
  directives: Set<string>
  hoists: (JSChildNode | null)[]
  imports: Set<ImportItem>
  temps: number
  cached: number
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  parent: ParentNode | null
  childIndex: number
  currentNode: RootNode | TemplateChildNode | null
  helper<T extends symbol>(name: T): T
  helperString(name: symbol): string
  replaceNode(node: TemplateChildNode): void
  removeNode(node?: TemplateChildNode): void
  onNodeRemoved(): void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: JSChildNode): SimpleExpressionNode
  cache<T extends JSChildNode>(exp: T, isVNode?: boolean): CacheExpression | T
}

// 创建整个ast语法树对应的上下文context
export function createTransformContext(
  root: RootNode, // 解析完成的ast语法树
  {
    prefixIdentifiers = false,
    hoistStatic = false,
    cacheHandlers = false,
    nodeTransforms = [],
    directiveTransforms = {},
    transformHoist = null,
    isBuiltInComponent = NOOP,
    expressionPlugins = [],
    scopeId = null,
    ssr = false,
    onError = defaultOnError
  }: TransformOptions
): TransformContext {
  const context: TransformContext = {
    // options
    prefixIdentifiers,
    hoistStatic,
    cacheHandlers,
    nodeTransforms,
    directiveTransforms,
    transformHoist,
    isBuiltInComponent,
    expressionPlugins,
    scopeId,
    ssr,
    onError,

    // state
    root,
    // 存储用到的API，用于按需引入
    helpers: new Set(),
    components: new Set(),
    directives: new Set(),
    hoists: [],
    imports: new Set(),
    temps: 0,
    cached: 0,
    identifiers: {},
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0
    },
    parent: null,
    currentNode: root, // 指向当前节点对象
    childIndex: 0,

    // methods
    helper(name) {
      context.helpers.add(name)
      return name
    },
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`
    },
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__) {
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
          ? context.childIndex
          : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    hoist(exp) {
      context.hoists.push(exp)
      const identifier = createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc,
        true
      )
      identifier.hoisted = exp
      return identifier
    },
    cache(exp, isVNode = false) {
      // 创建 表达式 的对象，标记需要缓存
      return createCacheExpression(++context.cached, exp, isVNode)
    }
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    identifiers[id]!++
  }

  function removeId(id: string) {
    context.identifiers[id]!--
  }

  return context
}

// root  解析完成的ast语法树
// root上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
export function transform(root: RootNode, options: TransformOptions) {
  // 创建整个ast语法树对应的上下文context
  const context = createTransformContext(root, options)
  // 这里是对整个ast语法树进行处理，包括合并 分析props 更新patchFlag dynamicPropNames
  // 最终让ast语法树上的每一个node(不包括root自己)都有自己的codegenNode，用于后续生成代码
  traverseNode(root, context)
  // hoistStatic是什么，暂时不看???
  if (options.hoistStatic) {
    hoistStatic(root, context)
  }
  // 给root创建codegenNode属性，用于后续生成代码
  // ssr不走这里
  if (!options.ssr) {
    createRootCodegen(root, context)
  }
  // finalize meta information
  root.helpers = [...context.helpers]
  root.components = [...context.components]
  root.directives = [...context.directives]
  root.imports = [...context.imports]
  root.hoists = context.hoists
  root.temps = context.temps
  root.cached = context.cached
}

// 给root创建codegenNode属性，用于后续生成代码
function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  const child = children[0]
  if (children.length === 1) { // root的根节点不是fragment，child指向根节点，通常情况
    // if the single child is an element, turn it into a block.
    if (isSingleElementRoot(root, child) && child.codegenNode) {
      // single element root is never hoisted so codegenNode will never be
      // SimpleExpressionNode
      // child是element，标记isBlock，并将child.codegenNode赋值到root.codegenNode上
      // slot标签 IfNode ForNode 已经标记过isBlock了
      const codegenNode = child.codegenNode
      if (codegenNode.type === NodeTypes.VNODE_CALL) {
        codegenNode.isBlock = true
        helper(OPEN_BLOCK)
        helper(CREATE_BLOCK)
      }
      root.codegenNode = codegenNode
    } else {
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // root codegen falls through via genNode()
      // child没有codegenNode，root.codegenNode直接指向child
      root.codegenNode = child
    }
  } else if (children.length > 1) { // root的根节点是fragment
    // root has multiple nodes - return a fragment block.
    // 创建type为 NodeTypes.VNODE_CALL 的对象，作为root.codegenNode
    root.codegenNode = createVNodeCall(
      context,
      helper(FRAGMENT),
      undefined,
      root.children,
      `${PatchFlags.STABLE_FRAGMENT} /* ${
        PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
      } */`,
      undefined,
      undefined,
      true
    )
  } else { // 没有children，root也就不需要codegenNode
    // no children = noop. codegen will return null.
  }
}

// 标记context.parent和context.childIndex，递归遍历每一个child
export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue
    // context.parent标记当前child的parent
    context.parent = parent
    // context.childIndex标记当前child在parent中的index
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

// 这里是对整个ast语法树进行处理，包括合并 分析props 更新patchFlag dynamicPropNames
// 最终让ast语法树上的每一个node都有自己的codegenNode，用于后续生成代码
export function traverseNode(
  node: RootNode | TemplateChildNode, // 解析完成的ast语法树
  context: TransformContext // 整个ast语法树对应的上下文context
) {
  // 当前节点对象
  context.currentNode = node
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  // [transformOnce,transformIf,transformFor,transformExpression,transformSlotOutlet,transformElement,trackSlotScopes,transformText]
  // 对节点对象进行处理 v-once v-if v-for
  for (let i = 0; i < nodeTransforms.length; i++) {
    // v-once => 返回值是函数，更新node.codegenNode的指向，标记需要缓存
    // v-if => 返回值是数组，里面有处理v-if指向关系的回调，生成ifNode.codegenNode
    // v-for => 返回值是函数，目的是等children都traverse之后处理 slot的key、fragment包裹、标记isBlock
    // slot标签 => 没有返回值，执行这个方法，处理name和props，最后创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象作为node.codegenNode
    // 原生标签 | 组件 => 返回值是函数，目的是分析props children，更新shouldUseBlock patchFlag，最后创建type为 NodeTypes.VNODE_CALL 的对象作为node.codegenNode
    // 带v-slot或#的 组件 | template，也就是具名插槽，context.scopes.vSlot计数加1，返回值函数onExit用于计数减1
    // 处理文本child => 返回值是函数onExit，目的将所有连续的文本child合并并替换为type为 NodeTypes.TEXT_CALL 的对象，其codegenNode是 创建type为 NodeTypes.JS_CALL_EXPRESSION 的对象
    const onExit = nodeTransforms[i](node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    // 更新node为最新的node对象
    if (!context.currentNode) {
      // node was removed
      // v-else-if v-else会被移除
      return
    } else {
      // node may have been replaced
      // v-if v-for会被替换
      node = context.currentNode
    }
  }

  // 这里的node是经过上面一系列遍历之后的最新的node对象

  switch (node.type) {
    case NodeTypes.COMMENT: // 注释节点
      if (!context.ssr) {
        // inject import for the Comment symbol, which is needed for creating
        // comment nodes with `createVNode`
        context.helper(CREATE_COMMENT)
      }
      break
    case NodeTypes.INTERPOLATION: // ???
      // no need to traverse, but we need to inject toString helper
      if (!context.ssr) {
        context.helper(TO_DISPLAY_STRING)
      }
      break

    // for container types, further traverse downwards
    case NodeTypes.IF: // 只有v-if，v-else-if v-else不会走到这里
      // 这里的node.branches应该只有v-if自己
      // v-else-if v-else会在processIf过程中进行traverseNode(branch)
      for (let i = 0; i < node.branches.length; i++) {
        traverseNode(node.branches[i], context)
      }
      break
    case NodeTypes.IF_BRANCH: // v-if的branch
    case NodeTypes.FOR: // v-for
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT: // 根
      // 标记context.parent和context.childIndex，递归遍历每一个child
      traverseChildren(node, context)
      break
  }

  // exit transforms
  // traverse完node对应的整个树之后，遍历执行exitFns中的函数
  // 这里的作用是生成每一个node的codegenNode，用于生成代码
  let i = exitFns.length
  while (i--) {
    exitFns[i]()
  }
}

export function createStructuralDirectiveTransform(
  // v-if => /^(if|else|else-if)$/
  // v-for => 'for'
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  // 返回值是exitFns数组，里面有处理v-if指向关系的回调，生成ifNode.codegenNode
  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      // 带v-slot的template节点对象不在这里处理
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) {
        return
      }
      const exitFns = []
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          props.splice(i, 1)
          i--
          // processIf processFor 的返回值
          // v-if 返回的processCodegen函数的作用是完善同一组 v-if v-else-if v-else 到 ifNode 对象
          // ifNode.codegenNode 指向 v-if，通过 alternate 属性不断指向同组的下一个
          // v-else-if v-else  没有返回值，processCodegen在fn执行过程中就进行了
          // 也就是说，v-if在fn过程中没有执行processCodegen，而是放入exitFns中，后续应该会执行
          // 而v-else-if v-else在fn过程中直接执行processCodegen
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
