import { CodegenOptions } from './options'
import {
  RootNode,
  TemplateChildNode,
  TextNode,
  CommentNode,
  ExpressionNode,
  NodeTypes,
  JSChildNode,
  CallExpression,
  ArrayExpression,
  ObjectExpression,
  Position,
  InterpolationNode,
  CompoundExpressionNode,
  SimpleExpressionNode,
  FunctionExpression,
  ConditionalExpression,
  CacheExpression,
  locStub,
  SSRCodegenNode,
  TemplateLiteral,
  IfStatement,
  AssignmentExpression,
  ReturnStatement,
  VNodeCall,
  SequenceExpression
} from './ast'
import { SourceMapGenerator, RawSourceMap } from 'source-map'
import {
  advancePositionWithMutation,
  assert,
  isSimpleIdentifier,
  toValidAssetId
} from './utils'
import { isString, isArray, isSymbol } from '@vue/shared'
import {
  helperNameMap,
  TO_DISPLAY_STRING,
  CREATE_VNODE,
  RESOLVE_COMPONENT,
  RESOLVE_DIRECTIVE,
  SET_BLOCK_TRACKING,
  CREATE_COMMENT,
  CREATE_TEXT,
  PUSH_SCOPE_ID,
  POP_SCOPE_ID,
  WITH_SCOPE_ID,
  WITH_DIRECTIVES,
  CREATE_BLOCK,
  OPEN_BLOCK,
  CREATE_STATIC,
  WITH_CTX
} from './runtimeHelpers'
import { ImportItem } from './transform'

const PURE_ANNOTATION = `/*#__PURE__*/`

type CodegenNode = TemplateChildNode | JSChildNode | SSRCodegenNode

export interface CodegenResult {
  code: string
  ast: RootNode
  map?: RawSourceMap
}

export interface CodegenContext extends Required<CodegenOptions> {
  source: string
  code: string
  line: number
  column: number
  offset: number
  indentLevel: number
  pure: boolean
  map?: SourceMapGenerator
  helper(key: symbol): string
  push(code: string, node?: CodegenNode): void
  indent(): void
  deindent(withoutNewLine?: boolean): void
  newline(): void
}

// 创建上下文
function createCodegenContext(
  ast: RootNode,
  {
    mode = 'function',
    prefixIdentifiers = mode === 'module',
    sourceMap = false,
    filename = `template.vue.html`,
    scopeId = null,
    optimizeBindings = false,
    runtimeGlobalName = `Vue`,
    runtimeModuleName = `vue`,
    ssr = false
  }: CodegenOptions
): CodegenContext {
  const context: CodegenContext = {
    mode,
    prefixIdentifiers,
    sourceMap,
    filename,
    scopeId,
    optimizeBindings,
    runtimeGlobalName,
    runtimeModuleName,
    ssr,
    source: ast.loc.source,
    code: ``,
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,
    pure: false,
    map: undefined,
    helper(key) {
      return `_${helperNameMap[key]}`
    },
    // 添加代码到context.code中
    push(code, node) {
      context.code += code
      if (!__BROWSER__ && context.map) {
        if (node) {
          let name
          if (node.type === NodeTypes.SIMPLE_EXPRESSION && !node.isStatic) {
            const content = node.content.replace(/^_ctx\./, '')
            if (content !== node.content && isSimpleIdentifier(content)) {
              name = content
            }
          }
          addMapping(node.loc.start, name)
        }
        advancePositionWithMutation(context, code)
        if (node && node.loc !== locStub) {
          addMapping(node.loc.end)
        }
      }
    },
    // 增加缩进context.indentLevel，控制代码的缩进格式
    // 添加换行符和缩进
    indent() {
      newline(++context.indentLevel)
    },
    // 减少缩进context.indentLevel，控制代码的缩进格式
    // 添加换行符和缩进
    deindent(withoutNewLine = false) {
      if (withoutNewLine) {
        --context.indentLevel
      } else {
        newline(--context.indentLevel)
      }
    },
    // 添加换行符
    newline() {
      newline(context.indentLevel)
    }
  }

  function newline(n: number) {
    context.push('\n' + `  `.repeat(n))
  }

  function addMapping(loc: Position, name?: string) {
    context.map!.addMapping({
      name,
      source: context.filename,
      original: {
        line: loc.line,
        column: loc.column - 1 // source-map column is 0 based
      },
      generated: {
        line: context.line,
        column: context.column - 1
      }
    })
  }

  if (!__BROWSER__ && sourceMap) {
    // lazy require source-map implementation, only in non-browser builds
    context.map = new SourceMapGenerator()
    context.map!.setSourceContent(filename, context.source)
  }

  return context
}

// 根据ast语法树生成代码
//    1) 生成引入API 自定义组件 自定义指令 temps的代码，这里有按需引入，可以实现tree-shaking
//    2) 生成render/ssrRender函数的return代码
export function generate(
  ast: RootNode, // 此时的ast语法树上每一个node都有自己的codegenNode，用于生成代码
  options: CodegenOptions = {}
): CodegenResult {
  // 创建上下文
  const context = createCodegenContext(ast, options)
  const {
    mode,
    push,
    prefixIdentifiers,
    indent,
    deindent,
    newline,
    scopeId,
    ssr
  } = context
  const hasHelpers = ast.helpers.length > 0
  const useWithBlock = !prefixIdentifiers && mode !== 'module'
  const genScopeId = !__BROWSER__ && scopeId != null && mode === 'module'

  // preambles
  // 预处理
  if (!__BROWSER__ && mode === 'module') { // ssr编译
    // 按需引入 vue @vue/server-renderer 中的API
    genModulePreamble(ast, context, genScopeId)
  } else { // 客户端编译
    // 引入Vue 按需引入createVnode createCommentVnode createTextVnode createStaticVnode
    // 最后添加换行符和return
    genFunctionPreamble(ast, context)
  }

  // enter render function
  if (genScopeId && !ssr) {
    // const render = /*#__PURE__*/_withId(
    push(`const render = ${PURE_ANNOTATION}_withId(`)
  }
  if (!ssr) {
    // 添加render函数的开头部分
    push(`function render(_ctx, _cache) {`)
  } else {
    // 添加ssrRender函数的开头部分
    push(`function ssrRender(_ctx, _push, _parent) {`)
  }
  // 增加缩进context.indentLevel，控制代码的缩进格式
  // 添加换行符和缩进
  indent()

  // 包裹 with (_ctx)
  // 按需引入所有用到的API
  if (useWithBlock) {
    push(`with (_ctx) {`)
    indent()
    // function mode const declarations should be inside with block
    // also they should be renamed to avoid collision with user properties
    // 按需引入所有用到的API
    if (hasHelpers) {
      push(
        `const { ${ast.helpers
          .map(s => `${helperNameMap[s]}: _${helperNameMap[s]}`)
          .join(', ')} } = _Vue`
      )
      push(`\n`)
      newline()
    }
  }

  // generate asset resolution statements
  // 按需引入自定义组件，添加到context.code中
  // const _component_component1 = _resolveComponent("component1")
  if (ast.components.length) {
    genAssets(ast.components, 'component', context)
    if (ast.directives.length || ast.temps > 0) {
      newline()
    }
  }
  // 按需引入自定义指令，添加到context.code中
  // const _directive_xxx = _resolveDirective("xxx")
  if (ast.directives.length) {
    genAssets(ast.directives, 'directive', context)
    if (ast.temps > 0) {
      newline()
    }
  }
  // ast.temps存储的是什么???
  if (ast.temps > 0) {
    // let _temp0, _temp1, _temp2
    push(`let `)
    for (let i = 0; i < ast.temps; i++) {
      push(`${i > 0 ? `, ` : ``}_temp${i}`)
    }
  }
  // 给components directives temps之后加上一行空行
  if (ast.components.length || ast.directives.length || ast.temps) {
    push(`\n`)
    newline()
  }

  // generate the VNode tree expression
  // 上面已经完成了API 自定义组件 自定义指令 temps的引入
  // 这里开始生成render函数的return部分
  // return (_openBlock(), _createBlock("div", null, [
  //   _createVNode("div", { key: "xxx" }),
  //   _createVNode(_component_component1),
  //   _withDirectives(_createVNode(_component_component2, {
  //     modelValue: _ctx.xxx,
  //     "onUpdate:modelValue": $event => (_ctx.xxx = $event)
  //   }, null, 8 /* PROPS */, ["modelValue", "onUpdate:modelValue"]), [
  //     [_directive_xxx, _ctx.xxx]
  //   ]),
  //   _createVNode(_Transition)
  // ]))
  if (!ssr) {
    push(`return `)
  }

  if (ast.codegenNode) {
    // 递归整个ast语法树，生成整个ast对应的代码，作为render函数
    genNode(ast.codegenNode, context)
  } else {
    // 没有codegenNode，返回null
    push(`null`)
  }

  // 添加useWithBlock的结尾，也就是 with (_ctx) { 对应的结尾 }
  if (useWithBlock) {
    // 减少缩进context.indentLevel，控制代码的缩进格式
    // 添加换行符和缩进
    deindent()
    push(`}`)
  }

  // 添加 function render(_ctx, _cache) { 对应的结尾 }
  // 添加 function ssrRender(_ctx, _push, _parent) { 对应的结尾 }
  deindent()
  push(`}`)

  // 添加genScopeId的结尾，也就是 const render = /*#__PURE__*/_withId( 对应的结尾 )
  if (genScopeId && !ssr) {
    push(`)`)
  }

  return {
    // ast语法树
    ast,
    // 最终生成的代码，也就是render函数
    code: context.code,
    // SourceMapGenerator does have toJSON() method but it's not in the types
    map: context.map ? (context.map as any).toJSON() : undefined
  }
}

// 预处理
// 引入Vue 按需引入createVnode createCommentVnode createTextVnode createStaticVnode
// 最后添加换行符和return
function genFunctionPreamble(ast: RootNode, context: CodegenContext) {
  const {
    ssr,
    prefixIdentifiers,
    push,
    newline,
    runtimeModuleName,
    runtimeGlobalName
  } = context
  const VueBinding =
    !__BROWSER__ && ssr
      ? `require(${JSON.stringify(runtimeModuleName)})` // 'require(vue)'
      : runtimeGlobalName // 'Vue'
  const aliasHelper = (s: symbol) => `${helperNameMap[s]}: _${helperNameMap[s]}`
  // Generate const declaration for helpers
  // In prefix mode, we place the const declaration at top so it's done
  // only once; But if we not prefixing, we place the declaration inside the
  // with block so it doesn't incur the `in` check cost for every helper access.
  if (ast.helpers.length > 0) {
    if (!__BROWSER__ && prefixIdentifiers) {
      push(
        `const { ${ast.helpers.map(aliasHelper).join(', ')} } = ${VueBinding}\n`
      )
    } else {
      // "with" mode.
      // save Vue in a separate variable to avoid collision
      // const _Vue = Vue
      // 引入Vue
      push(`const _Vue = ${VueBinding}\n`)
      // in "with" mode, helpers are declared inside the with block to avoid
      // has check cost, but hoists are lifted out of the function - we need
      // to provide the helper here.
      if (ast.hoists.length) {
        const staticHelpers = [
          CREATE_VNODE,
          CREATE_COMMENT,
          CREATE_TEXT,
          CREATE_STATIC
        ]
          .filter(helper => ast.helpers.includes(helper))
          .map(aliasHelper)
          .join(', ')
        // const { createVnode: _createVnode, createCommentVnode: _createCommentVnode, createTextVnode: _createTextVnode, createStaticVnode: _createStaticVnode } = _Vue
        // 按需引入 创建vnode的方法
        push(`const { ${staticHelpers} } = _Vue\n`)
      }
    }
  }
  // generate variables for ssr helpers
  if (!__BROWSER__ && ast.ssrHelpers && ast.ssrHelpers.length) {
    // ssr guaruntees prefixIdentifier: true
    push(
      `const { ${ast.ssrHelpers
        .map(aliasHelper)
        .join(', ')} } = require("@vue/server-renderer")\n`
    )
  }
  genHoists(ast.hoists, context)
  // 添加换行符
  newline()
  // 添加return
  push(`return `)
}

// 按需引入 vue @vue/server-renderer 中的API
function genModulePreamble(
  ast: RootNode,
  context: CodegenContext,
  genScopeId: boolean
) {
  const {
    push,
    helper,
    newline,
    scopeId,
    optimizeBindings,
    runtimeModuleName
  } = context

  if (genScopeId) {
    ast.helpers.push(WITH_SCOPE_ID)
    if (ast.hoists.length) {
      ast.helpers.push(PUSH_SCOPE_ID, POP_SCOPE_ID)
    }
  }

  // generate import statements for helpers
  if (ast.helpers.length) {
    if (optimizeBindings) {
      // when bundled with webpack with code-split, calling an import binding
      // as a function leads to it being wrapped with `Object(a.b)` or `(0,a.b)`,
      // incurring both payload size increase and potential perf overhead.
      // therefore we assign the imports to vairables (which is a constant ~50b
      // cost per-component instead of scaling with template size)
      push(
        `import { ${ast.helpers
          .map(s => helperNameMap[s])
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`
      )
      push(
        `\n// Binding optimization for webpack code-split\nconst ${ast.helpers
          .map(s => `_${helperNameMap[s]} = ${helperNameMap[s]}`)
          .join(', ')}\n`
      )
    } else {
      push(
        `import { ${ast.helpers
          .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`
      )
    }
  }

  if (ast.ssrHelpers && ast.ssrHelpers.length) {
    push(
      `import { ${ast.ssrHelpers
        .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
        .join(', ')} } from "@vue/server-renderer"\n`
    )
  }

  if (ast.imports.length) {
    genImports(ast.imports, context)
    newline()
  }

  if (genScopeId) {
    push(
      `const _withId = ${PURE_ANNOTATION}${helper(WITH_SCOPE_ID)}("${scopeId}")`
    )
    newline()
  }

  // 暂时不看???
  genHoists(ast.hoists, context)
  newline()
  push(`export `)
}

// 按需引入自定义组件和自定义指令，添加到context.code中
function genAssets(
  assets: string[],
  type: 'component' | 'directive',
  { helper, push, newline }: CodegenContext
) {
  // `_${helperNameMap[type === 'component' ? RESOLVE_COMPONENT : RESOLVE_DIRECTIVE]}`
  const resolver = helper(
    type === 'component' ? RESOLVE_COMPONENT : RESOLVE_DIRECTIVE
  )
  for (let i = 0; i < assets.length; i++) {
    const id = assets[i]
    push(
      // const _component_component2 = _resolveComponent("component2")
      // const _directive_xxx = _resolveDirective("xxx")
      `const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)})`
    )
    if (i < assets.length - 1) {
      newline()
    }
  }
}

function genHoists(hoists: (JSChildNode | null)[], context: CodegenContext) {
  if (!hoists.length) {
    return
  }
  context.pure = true
  const { push, newline, helper, scopeId, mode } = context
  const genScopeId = !__BROWSER__ && scopeId != null && mode !== 'function'
  newline()

  // push scope Id before initilaizing hoisted vnodes so that these vnodes
  // get the proper scopeId as well.
  if (genScopeId) {
    push(`${helper(PUSH_SCOPE_ID)}("${scopeId}")`)
    newline()
  }

  hoists.forEach((exp, i) => {
    if (exp) {
      push(`const _hoisted_${i + 1} = `)
      genNode(exp, context)
      newline()
    }
  })

  if (genScopeId) {
    push(`${helper(POP_SCOPE_ID)}()`)
    newline()
  }
  context.pure = false
}

function genImports(importsOptions: ImportItem[], context: CodegenContext) {
  if (!importsOptions.length) {
    return
  }
  importsOptions.forEach(imports => {
    context.push(`import `)
    genNode(imports.exp, context)
    context.push(` from '${imports.path}'`)
    context.newline()
  })
}

function isText(n: string | CodegenNode) {
  return (
    isString(n) ||
    n.type === NodeTypes.SIMPLE_EXPRESSION ||
    n.type === NodeTypes.TEXT ||
    n.type === NodeTypes.INTERPOLATION ||
    n.type === NodeTypes.COMPOUND_EXPRESSION
  )
}

// nodes超过3个，用换行缩进的格式添加代码
// nodes不超过3个 => [1,2,3]
// nodes超过3个 => 
//    [
//      1,
//      2,
//      3,
//      4
//    ]
function genNodeListAsArray(
  nodes: (string | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext
) {
  const multilines =
    nodes.length > 3 ||
    ((!__BROWSER__ || __DEV__) && nodes.some(n => isArray(n) || !isText(n)))
  context.push(`[`)
  multilines && context.indent()
  genNodeList(nodes, context, multilines)
  multilines && context.deindent()
  context.push(`]`)
}

// nodes => [tag, props, children, patchFlag, dynamicProps] 中有数据的部分
// nodes => [tag, null, children, patchFlag, dynamicProps]
// nodes => [tag, null, null, patchFlag]
// nodes => [tag, null, children]
// 按顺序添加代码，并在中间用, 间隔
// <div key='xxx'>aaa</div> => "div", { key: "xxx" }, "aaa"

// nodes => children
// 遍历children，执行genNode
function genNodeList(
  nodes: (string | symbol | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
  multilines: boolean = false,
  comma: boolean = true
) {
  const { push, newline } = context
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isString(node)) { // tag patchFlag dynamicProps
      push(node)
    } else if (isArray(node)) { // children
      genNodeListAsArray(node, context)
    } else {
      // props
      // children中的每一个child
      // v-for的children(NodeTypes.JS_CALL_EXPRESSION)
      // v-for的每一项对象(NodeTypes.JS_FUNCTION_EXPRESSION)
      // slot标签的children对象(NodeTypes.JS_FUNCTION_EXPRESSION)
      // {{}} Mustache语法(NodeTypes.INTERPOLATION)
      genNode(node, context)
    }
    if (i < nodes.length - 1) {
      if (multilines) {
        comma && push(',')
        newline()
      } else {
        comma && push(', ')
      }
    }
  }
}

// node => ast.codegenNode
function genNode(node: CodegenNode | symbol | string, context: CodegenContext) {
  if (isString(node)) {
    context.push(node)
    return
  }
  // 添加API，如 _createBlock _createVNode
  if (isSymbol(node)) {
    context.push(context.helper(node))
    return
  }
  switch (node.type) {
    case NodeTypes.ELEMENT:
    case NodeTypes.IF:
    case NodeTypes.FOR: // element if for已经生成了对应的codegenNode用于生成代码，直接genNode
      __DEV__ &&
        assert(
          node.codegenNode != null,
          `Codegen node is missing for element/if/for node. ` +
            `Apply appropriate transforms first.`
        )
      genNode(node.codegenNode!, context)
      break
    case NodeTypes.TEXT: // 文本child
      genText(node, context)
      break
    case NodeTypes.SIMPLE_EXPRESSION: // prop的属性值value对象(虽然属性名对象也是type为NodeTypes.SIMPLE_EXPRESSION，但是不走这里的逻辑) v-for的list对象 {{}}Mustache语法的content对象
      // 静态(包裹引号) | 动态(不作变动) 添加到context.code中
      genExpression(node, context)
      break
    case NodeTypes.INTERPOLATION: // {{}}Mustache语法
      genInterpolation(node, context)
      break
    case NodeTypes.TEXT_CALL: // 文本child对象，其codegenNode是type为NodeTypes.JS_CALL_EXPRESSION的对象
      genNode(node.codegenNode, context)
      break
    case NodeTypes.COMPOUND_EXPRESSION: // 连续文本child合并后的对象
      genCompoundExpression(node, context)
      break
    case NodeTypes.COMMENT: // 注释
      // dev模式下添加注释代码
      // <!-- xxx --> => _createCommentVNode(" xxx ")
      genComment(node, context)
      break
    case NodeTypes.VNODE_CALL: // 根不为fragment的root 组件 原生标签 v-else v-for
      // <div v-xxx key="key" name1="name1" :name2="name2"></div>
      // =>
      // _withDirectives((_openBlock(), _createBlock("div", {
      //   key: "key",
      //   name1: "name1",
      //   name2: _ctx.name2
      // }, null, 8 /* PROPS */, ["name2"])), [
      //   [_directive_xxx]
      // ])
      // 添加整个node的代码，这里会遍历内部的props和children
      genVNodeCall(node, context)
      break

    case NodeTypes.JS_CALL_EXPRESSION: // 带v-bind或v-on对象语法的props 最后一个v-if或v-else-if的注释对象 v-for的children对象 slot标签 文本child的codegenNode ssr的_push ssr的{{}}Mustache语法 ssr的组件 带动态插槽的ssr组件插槽 ssr的slot标签 ssr的v-for
      genCallExpression(node, context)
      break
    case NodeTypes.JS_OBJECT_EXPRESSION: // 不带v-bind v-on对象语法的props，常规props ssr的组件props ssr的组件静态插槽
      // 遍历node.properties，处理所有属性(静态|动态)，添加到context.code中
      genObjectExpression(node, context)
      break
    case NodeTypes.JS_ARRAY_EXPRESSION: // 指令 ssr的组件动态插槽
      genArrayExpression(node, context)
      break
    case NodeTypes.JS_FUNCTION_EXPRESSION: // v-for的每一项对象 slot标签的children对象 ssr的v-for的renderLoop
      genFunctionExpression(node, context)
      break
    case NodeTypes.JS_CONDITIONAL_EXPRESSION: // v-if v-else-if(v-else-if和v-else会解析为node.alternate依次连接)
      genConditionalExpression(node, context)
      break
    case NodeTypes.JS_CACHE_EXPRESSION: // v-once
      genCacheExpression(node, context)
      break

    // SSR only types
    // 下面都是ssr的类型
    case NodeTypes.JS_BLOCK_STATEMENT: // ssr根节点 v-if的内容 v-else-if的内容 v-else的内容 v-for的内容
      // node.body => context.body
      !__BROWSER__ && genNodeList(node.body, context, true, false)
      break
    case NodeTypes.JS_TEMPLATE_LITERAL: // _push的参数对象(文本child 注释 {{}}Mustache语法 原生dom 组件)
      // _push的参数，永远只有一个，这里对其做字符串的拼接
      // 通过`${}`拼接，对$和\前面多加一个\，做转义
      !__BROWSER__ && genTemplateLiteral(node, context)
      break
    case NodeTypes.JS_IF_STATEMENT: // v-if v-else-if
      !__BROWSER__ && genIfStatement(node, context)
      break
    case NodeTypes.JS_ASSIGNMENT_EXPRESSION: // 带动态绑定v-bind的textarea和input标签???
      !__BROWSER__ && genAssignmentExpression(node, context)
      break
    case NodeTypes.JS_SEQUENCE_EXPRESSION: // 带v-model的input标签???
      !__BROWSER__ && genSequenceExpression(node, context)
      break
    case NodeTypes.JS_RETURN_STATEMENT: // v-slot失败备用分支，经过客户端编译后重新走一遍genNode
      !__BROWSER__ && genReturnStatement(node, context)
      break

    /* istanbul ignore next */
    case NodeTypes.IF_BRANCH: // v-if v-else-if v-else生成的branch对象会存储在ifNode上，不会走到这里，可以忽略
      // noop
      break
    default:
      if (__DEV__) {
        assert(false, `unhandled codegen node type: ${(node as any).type}`)
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = node
        return exhaustiveCheck
      }
  }
}

// 文本child
function genText(
  node: TextNode | SimpleExpressionNode,
  context: CodegenContext
) {
  context.push(JSON.stringify(node.content), node)
}

// node => prop的属性值value对象
// 静态(包裹引号) | 动态(不作变动) 添加到context.code中
function genExpression(node: SimpleExpressionNode, context: CodegenContext) {
  const { content, isStatic } = node
  // 静态属性值value，直接包裹引号添加到context.code中
  // 动态属性值value(也就是v-bind绑定的)，添加value.content(这个指向属性值变量，不需要包裹引号)到context.code中
  context.push(isStatic ? JSON.stringify(content) : content, node)
}

// {{}} Mustache语法
// {{ xxx }} => _toDisplayString(_ctx.xxx)
function genInterpolation(node: InterpolationNode, context: CodegenContext) {
  const { push, helper, pure } = context
  if (pure) push(PURE_ANNOTATION)
  push(`${helper(TO_DISPLAY_STRING)}(`)
  genNode(node.content, context)
  push(`)`)
}

// 连续文本child合并后的对象
// aaa{{bbb}} => "aaa" + _toDisplayString(_ctx.bbb)
function genCompoundExpression(
  node: CompoundExpressionNode,
  context: CodegenContext
) {
  for (let i = 0; i < node.children!.length; i++) {
    const child = node.children![i]
    if (isString(child)) {
      context.push(child)
    } else {
      genNode(child, context)
    }
  }
}

// node => type为NodeTypes.JS_PROPERTY的对象
// 将属性名添加到代码中，常规静态属性在这里会包裹引号，数字 $ _开头的静态属性以及动态属性不会包裹引号
function genExpressionAsPropertyKey(
  node: ExpressionNode,
  context: CodegenContext
) {
  const { push } = context
  if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
    push(`[`)
    genCompoundExpression(node, context)
    push(`]`)
  } else if (node.isStatic) { // 静态属性 node.content指向静态属性名
    // name="name" => "name"
    // only quote keys if necessary
    // 数字 $ _ 开头 => 返回true，不用包裹引号
    // 其他 => 返回false，需要包裹引号
    // 但是实际编译出来数字开头的还是包裹了引号，哪里加的???
    const text = isSimpleIdentifier(node.content)
      ? node.content
      : JSON.stringify(node.content)
    push(text, node)
  } else { // 动态属性 node.content指向属性名变量
    // [name]="name" => [name]
    // 动态属性也没有包裹引号，而编译出来是包裹引号的???
    push(`[${node.content}]`, node)
  }
}

// dev模式下添加注释代码
// <!-- xxx --> => _createCommentVNode(" xxx ")
function genComment(node: CommentNode, context: CodegenContext) {
  if (__DEV__) {
    const { push, helper, pure } = context
    if (pure) {
      push(PURE_ANNOTATION)
    }
    // <!-- xxx --> => _createCommentVNode(" xxx ")
    push(`${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`, node)
  }
}

// type为NodeTypes.VNODE_CALL的node对象生成代码
// _withDirectives((_openBlock(), _createBlock(...)), [[_directive_xxx]])
// _withDirectives(_createVnode(...), [[_directive_xxx]])
function genVNodeCall(node: VNodeCall, context: CodegenContext) {
  const { push, helper, pure } = context
  const {
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    isForBlock
  } = node
  // _withDirectives(
  if (directives) {
    push(helper(WITH_DIRECTIVES) + `(`)
  }
  // (_openBlock(),
  // (_openBlock(true), 
  if (isBlock) {
    push(`(${helper(OPEN_BLOCK)}(${isForBlock ? `true` : ``}), `)
  }
  // /*#__PURE__*/
  // 这个是什么???
  if (pure) {
    push(PURE_ANNOTATION)
  }
  // Block => _createBlock( ，_createBlock之前一定有 _openBlock
  // 非Block => _createVnode(
  push(helper(isBlock ? CREATE_BLOCK : CREATE_VNODE) + `(`, node)
  genNodeList(
    // 提取args中有数据的部分
    // args => [tag, props, children, patchFlag, dynamicProps]
    // 返回 => [tag, null, children, patchFlag, dynamicProps]
    // 返回 => [tag, null, null, patchFlag]
    // 返回 => [tag, null, children]
    genNullableArgs([tag, props, children, patchFlag, dynamicProps]),
    context
  )
  // _createBlock( 对应的结尾 )
  // _createVnode( 对应的结尾 )
  push(`)`)
  // (_openBlock(), _createBlock(...) 对应的结尾 )
  // (_openBlock(true), _createBlock(...) 对应的结尾 )
  if (isBlock) {
    push(`)`)
  }
  // _withDirectives( 的结尾不止 ) ，还有 [[_directive_1, _directive_2, _directive_3]] 指令名数组
  // , [
  //   [_directive_xxx]
  // ])
  if (directives) {
    push(`, `)
    genNode(directives, context)
    push(`)`)
  }
}

// 提取args中有数据的部分
// args => [tag, props, children, patchFlag, dynamicProps]
// 返回 => [tag, null, children, patchFlag, dynamicProps]
// 返回 => [tag, null, null, patchFlag]
// 返回 => [tag, null, children]
function genNullableArgs(args: any[]): CallExpression['arguments'] {
  let i = args.length
  // 从后遍历args找到第一个不为null的，跳出循环
  while (i--) {
    if (args[i] != null) break
  }
  // 提取有数据的部分
  return args.slice(0, i + 1).map(arg => arg || `null`)
}

// JavaScript
// v-if | v-else-if 的注释对象 => _createCommentVNode("v-if", true)
// v-for的children => _renderList(list, (xxx) => { return ... }, 128 /* KEYED_FRAGMENT */)
// slot标签 <slot name="xxx" test="test"><div>1</div><div>2</div></slot>
//    => _renderSlot(_ctx.$slots, "xxx", { test: "test" }, () => [_createVnode("div", null, "1"), _createVnode("div", null, "2")])
// 文本child
//    xxx => _createTextVNode("xxx")
//    {{ xxx }} => _createTextVNode(_toDisplayString(_ctx.xxx), 1 /* TEXT */)
function genCallExpression(node: CallExpression, context: CodegenContext) {
  const { push, helper, pure } = context
  const callee = isString(node.callee) ? node.callee : helper(node.callee)
  if (pure) {
    push(PURE_ANNOTATION)
  }
  // _createCommentVNode(
  // _renderList(
  // _renderSlot(
  // _createTextVnode(
  push(callee + `(`, node)
  // ["v-if", true] => "v-if", true
  // [list变量对象(NodeTypes.SIMPLE_EXPRESSION), v-for的每一项对象(NodeTypes.JS_FUNCTION_EXPRESSION)]
  //    => list, (xxx) => { return ... }, 128 /* KEYED_FRAGMENT */
  // ["xxx"] => "xxx"
  // [{{ xxx }}] => _toDisplayString(_ctx.xxx), 1 /* TEXT *
  genNodeList(node.arguments, context)
  push(`)`)
}

// 遍历node.properties，处理所有属性(静态|动态)，添加到context.code中
function genObjectExpression(node: ObjectExpression, context: CodegenContext) {
  const { push, indent, deindent, newline } = context
  const { properties } = node
  // 没有props，添加 {} ，表示没有props
  if (!properties.length) {
    push(`{}`, node)
    return
  }
  // props数量超过1个，就用换行缩进格式
  // props属性不超过1个 => { key: 'xxx' }
  // props属性超过1个 =>
  //    {
  //      key: 'xxx',
  //      name: 'name'
  //    }
  const multilines =
    properties.length > 1 ||
    ((!__BROWSER__ || __DEV__) &&
      properties.some(p => p.value.type !== NodeTypes.SIMPLE_EXPRESSION))
  // 不换行缩进就加个空格做间隔
  push(multilines ? `{` : `{ `)
  multilines && indent()
  for (let i = 0; i < properties.length; i++) {
    // properties[i] => type为NodeTypes.JS_PROPERTY的对象
    // key => type为NodeTypes.SIMPLE_EXPRESSION的对象
    // value => type为NodeTypes.SIMPLE_EXPRESSION的对象
    const { key, value } = properties[i]
    // key
    // 将属性名添加到代码中，常规静态属性在这里会包裹引号，数字 $ _开头的静态属性以及动态属性不会包裹引号
    genExpressionAsPropertyKey(key, context)
    push(`: `)
    // value
    genNode(value, context)
    if (i < properties.length - 1) {
      // will only reach this if it's multilines
      // 多个属性，换行缩进
      push(`,`)
      newline()
    }
  }
  multilines && deindent()
  push(multilines ? `}` : ` }`)
}

// 指令
// <div v-a="aaa" v-b="bbb"></div>
// =>
// _withDirectives(_createVNode("div", null, null, 512 /* NEED_PATCH */), [
//   [_directive_a, _ctx.aaa],
//   [_directive_b, _ctx.bbb]
// ])
function genArrayExpression(node: ArrayExpression, context: CodegenContext) {
  genNodeListAsArray(node.elements, context)
}

// v-for的每一项对象
function genFunctionExpression(
  node: FunctionExpression,
  context: CodegenContext
) {
  const { push, indent, deindent, scopeId, mode } = context
  const { params, returns, body, newline, isSlot } = node
  // slot functions also need to push scopeId before rendering its content
  const genScopeId =
    !__BROWSER__ && isSlot && scopeId != null && mode !== 'function'

  if (genScopeId) { // withId(
    push(`_withId(`)
  } else if (isSlot) { // _withCtx(
    push(`_${helperNameMap[WITH_CTX]}(`)
  }

  // 解析参数
  // (value, key, index) in list => (value, key, index) =>
  push(`(`, node)
  if (isArray(params)) {
    genNodeList(params, context)
  } else if (params) {
    genNode(params, context)
  }
  push(`) => `)

  if (newline || body) {
    push(`{`)
    indent()
  }
  if (returns) { // v-for的每一项对象childBlock slot标签的children
    if (newline) {
      push(`return `)
    }
    if (isArray(returns)) { // slot标签的children
      genNodeListAsArray(returns, context)
    } else { // v-for的每一项对象childBlock
      genNode(returns, context)
    }
  } else if (body) { // ssr
    genNode(body, context)
  }
  if (newline || body) {
    deindent()
    push(`}`)
  }
  if (genScopeId || isSlot) {
    push(`)`)
  }
}

// v-if v-else-if(v-else-if和v-else会解析为node.alternate依次连接)
function genConditionalExpression(
  node: ConditionalExpression,
  context: CodegenContext
) {
  // test => branch.condition，也就是v-if或v-else=if的属性值value对象
  // consequent => type为 NodeTypes.VNODE_CALL 的对象，v-if对应的
  // alternate => NodeTypes.JS_CONDITIONAL_EXPRESSION(v-else-if) | NodeTypes.VNODE_CALL(v-else) | NodeTypes.JS_CALL_EXPRESSION(最后一个v-if或v-else-if的注释对象)
  const { test, consequent, alternate, newline: needNewline } = node
  const { push, indent, deindent, newline } = context
  // 添加v-if v-else-if的条件
  // v-if="num === 1" => (num === 1)
  // v-if="1" => (1)
  if (test.type === NodeTypes.SIMPLE_EXPRESSION) { // v-if="num === 1"
    const needsParens = !isSimpleIdentifier(test.content)
    needsParens && push(`(`)
    genExpression(test, context)
    needsParens && push(`)`)
  } else { // v-if="1"
    push(`(`)
    genNode(test, context)
    push(`)`)
  }
  needNewline && indent()
  context.indentLevel++
  needNewline || push(` `)
  push(`? `)
  // 添加v-if的完整代码
  genNode(consequent, context)
  context.indentLevel--
  needNewline && newline()
  needNewline || push(` `)
  push(`: `)
  // alternate => NodeTypes.JS_CONDITIONAL_EXPRESSION(v-else-if) | NodeTypes.VNODE_CALL(v-else) | NodeTypes.JS_CALL_EXPRESSION(最后一个v-if或v-else-if的注释对象)
  // 有v-else-if
  const isNested = alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
  // v-else-if不用在这里增加缩进，是因为v-else-if会继续走到genConditionalExpression里面，在这里会增加缩进
  // v-else | 最后一个v-if或v-else-if的注释对象 就必须在这里增加缩进
  if (!isNested) {
    context.indentLevel++
  }
  // 下一个v-else-if | v-else | v-if或v-else-if的注释对象
  genNode(alternate, context)
  if (!isNested) {
    context.indentLevel--
  }
  needNewline && deindent(true /* without newline */)
}

// v-once
// <div v-once></div>
// =>
// _cache[1] || (
//   _setBlockTracking(-1),
//   _cache[1] = _createVNode("div"),
//   _setBlockTracking(1),
//   _cache[1]
// )
function genCacheExpression(node: CacheExpression, context: CodegenContext) {
  const { push, helper, indent, deindent, newline } = context
  push(`_cache[${node.index}] || (`)
  if (node.isVNode) {
    indent()
    push(`${helper(SET_BLOCK_TRACKING)}(-1),`)
    newline()
  }
  push(`_cache[${node.index}] = `)
  genNode(node.value, context)
  if (node.isVNode) {
    push(`,`)
    newline()
    push(`${helper(SET_BLOCK_TRACKING)}(1),`)
    newline()
    push(`_cache[${node.index}]`)
    deindent()
  }
  push(`)`)
}

// _push的参数，永远只有一个，这里对其做字符串的拼接
// 通过`${}`拼接，对$和\前面多加一个\，做转义
function genTemplateLiteral(node: TemplateLiteral, context: CodegenContext) {
  const { push, indent, deindent } = context
  push('`')
  const l = node.elements.length
  // 超过3个，代码就做换行缩进
  const multilines = l > 3
  for (let i = 0; i < l; i++) {
    const e = node.elements[i]
    if (isString(e)) {
      // $和\前多加一个\，做转义
      push(e.replace(/(`|\$|\\)/g, '\\$1'))
    } else {
      // 通过${}拼接
      push('${')
      if (multilines) indent()
      genNode(e, context)
      if (multilines) deindent()
      push('}')
    }
  }
  push('`')
}

// v-if v-else-if
function genIfStatement(node: IfStatement, context: CodegenContext) {
  const { push, indent, deindent } = context
  const { test, consequent, alternate } = node
  push(`if (`)
  genNode(test, context)
  push(`) {`)
  indent()
  // consequent => NodeTypes.JS_BLOCK_STATEMENT
  genNode(consequent, context)
  deindent()
  push(`}`)
  if (alternate) {
    push(` else `)
    if (alternate.type === NodeTypes.JS_IF_STATEMENT) { // v-else-if
      // alternate => NodeTypes.JS_IF_STATEMENT
      genIfStatement(alternate, context)
    } else { // v-else
      push(`{`)
      indent()
      // alternate => NodeTypes.JS_BLOCK_STATEMENT
      genNode(alternate, context)
      deindent()
      push(`}`)
    }
  }
}

function genAssignmentExpression(
  node: AssignmentExpression,
  context: CodegenContext
) {
  genNode(node.left, context)
  context.push(` = `)
  genNode(node.right, context)
}

function genSequenceExpression(
  node: SequenceExpression,
  context: CodegenContext
) {
  context.push(`(`)
  genNodeList(node.expressions, context)
  context.push(`)`)
}

// v-slot失败备用分支，经过客户端编译后重新走一遍genNode
function genReturnStatement(
  { returns }: ReturnStatement,
  context: CodegenContext
) {
  context.push(`return `)
  if (isArray(returns)) {
    genNodeListAsArray(returns, context)
  } else {
    genNode(returns, context)
  }
}
