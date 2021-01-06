import { ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import { ErrorCodes, createCompilerError, defaultOnError } from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot
} from './ast'

type OptionalOptions = 'isNativeTag' | 'isBuiltInComponent'
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  inVPre: boolean // v-pre, do not process directives and interpolations
}

// 解析模板字符串，返回ast语法树
export function baseParse(
  content: string, // 模板字符串
  options: ParserOptions = {}
): RootNode {
  // parser上下文
  const context = createParserContext(content, options)
  // { column: 1, line: 1, offset: 0 }
  const start = getCursor(context)
  // 创建ast语法树根对象
  return createRoot(
    // 解析children，内部会递归遍历整个子标签
    // 返回nodes作为父element对象的children
    parseChildren(context, TextModes.DATA, []),
    // 这里已经执行完parseChildren，所以这里返回的loc对象指向的是整个模板字符串content从开头到结束
    getSelection(context, start)
  )
}

// 创建parser上下文
function createParserContext(
  content: string,
  options: ParserOptions
): ParserContext {
  return {
    options: extend({}, defaultParserOptions, options),
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content, // 原始模板字符串，解析过程不变化
    source: content, // 模板字符串，解析过程实时变化
    inPre: false,
    inVPre: false
  }
}

// 解析children，内部会递归遍历整个子标签
// 返回nodes作为父element对象的children
function parseChildren(
  context: ParserContext,
  mode: TextModes, // TextModes.DATA
  ancestors: ElementNode[] // []
): TemplateChildNode[] {
  const parent = last(ancestors)
  // namespace
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  // 一直遍历到结束标签
  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // 走这个逻辑的都是有解析出node的
    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) { // 以 {{ 开头，Mustache语法 {{ xxx }}
        // '{{'
        // Mustache语法解析 {{ xxx }}
        // 返回对象{ type, content, loc }
        // content存储 去除首尾空格后的内容字符串和位置对象loc
        // loc存储 没有去除首尾空格的位置对象
        node = parseInterpolation(context, mode)
      } else if (mode === TextModes.DATA && s[0] === '<') { // 以 < 开头
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') { // 以 <! 开头
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          // <
          if (startsWith(s, '<!--')) { // 以 <!-- 开头  注释
            // 返回对象{ type, content, loc }
            // html嵌套注释是多个 <!-- 对应一个 -->，也就是说结束标志 --> 永远只有一个
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) { // 以 <!DOCTYPE 开头  <!DOCTYPE html>
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) { // 以 <![CDATA[ 开头，这是什么???
            if (ns !== Namespaces.HTML) {
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else { // 其他情况，报错
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') { // 以 </ 开头  结束标签
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) { // </
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') { // </>  结束空标签，会报错，并解析移除
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) { // </[a-z]  字母开头的标签名(包括小写原生标签和大写组件标签)
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            // 解析结束标签</div>
            // 虽然返回标签解析后的对象，但是不需要，ast语法树中不需要将起始标签和结束标签分开来
            parseTag(context, TagType.End, parent)
            continue
          } else { // 其他情况，报错
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) { // 以<[a-z] 开头  起始标签(包括小写字母原生标签和大写字母组件标签)
          // 只有起始标签会走到这里
          // 整个标签解析完成，从 起始标签 到 children 再到 结束标签
          // 返回标签解析完成后的对象element
          node = parseElement(context, ancestors)
        } else if (s[1] === '?') { // 以 <? 开头，报错
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else { // 其他情况，报错
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }
    // 没有node，说明mode不是TextModes.DATA和TextModes.RCDATA
    // 当作文本节点处理，返回解析文本节点完成的对象
    // { type: NodeTypes.TEXT, content, loc }
    if (!node) {
      node = parseText(context, mode)
    }

    // 连续的文本节点做合并处理
    // 其他情况正常推入nodes
    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace management for more efficient output
  // (same as v2 whitespace: 'condense')
  let removedWhitespace = false
  // 移除 空格node 注释node
  // 移除node中多余的空格
  if (mode !== TextModes.RAWTEXT) {
    if (!context.inPre) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node.type === NodeTypes.TEXT) { // 文本node
          if (!/[^\t\r\n\f ]/.test(node.content)) { // 文本node只有 \t\r\n\f空格
            const prev = nodes[i - 1] // 前一个node
            const next = nodes[i + 1] // 下一个node
            // If:
            // - the whitespace is the first or last node, or:
            // - the whitespace is adjacent to a comment, or:
            // - the whitespace is between two elements AND contains newline
            // Then the whitespace is ignored.
            // 首尾node的空格 相邻注释节点的空格 在两个element节点之间且当前node包含换行符的空格
            // 以上三种空格会进行忽略
            if (
              !prev || // 最后一个node
              !next || // 第一个node
              prev.type === NodeTypes.COMMENT || // 前一个node是注释节点
              next.type === NodeTypes.COMMENT || // 后一个node是注释节点
              (prev.type === NodeTypes.ELEMENT && // 前一个node是element
                next.type === NodeTypes.ELEMENT && // 后一个node是element
                /[\r\n]/.test(node.content)) // 当前node有换行符
            ) {
              // 标记移除空格
              removedWhitespace = true
              // nodes中移除当前node
              nodes[i] = null as any
            } else {
              // Otherwise, condensed consecutive whitespace inside the text
              // down to a single space
              // 文本中的连续空格压缩成一个空格
              node.content = ' '
            }
          } else { // 文本node有除 \t\r\n\f空格 以外的内容
            // 将文本内容中连续的 \t\r\n\f空格 转为单个空格
            node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
          }
        } else if (!__DEV__ && node.type === NodeTypes.COMMENT) {
          // remove comment nodes in prod
          // 生产环境下移除注释节点
          removedWhitespace = true
          nodes[i] = null as any
        }
      }
    } else if (parent && context.options.isPreTag(parent.tag)) { // 父标签是pre标签，移除开头的换行符
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  // 返回nodes作为父element对象的children
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

// 连续的文本节点做合并处理
// 其他情况正常推入nodes
function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  // 连续的文本节点做合并处理
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }
  // 其他情况正常推入nodes
  nodes.push(node)
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

// context.source以 <!-- 开头  注释
// 返回对象{ type, content, loc }
// html嵌套注释是多个 <!-- 对应一个 -->，也就是说结束标志 --> 永远只有一个
function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  // 匹配 --> 或 --!> 的注释结尾标志
  // html注释，不管是不是嵌套注释，都只有一个结束标志
  const match = /--(\!)?>/.exec(context.source)
  if (!match) { // 没有注释结尾标志，也会正常解析，但会报错
    // 注释内容部分
    content = context.source.slice(4)
    // 移除context.source.length部分，更新offset line column source到context上
    advanceBy(context, context.source.length)
    // 报错
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else { // 有注释结尾标志
    // --> 或 --!> 的首个 - 的index小于等于3，也就是注释标志不全，如 <!--> <!--->
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    // --!>  match[1]指向匹配到的 !，虽然支持<!----!>，但是正确标志是<!---->
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    // 注释内容部分
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    // 嵌套的注释标志，如 <!--aaa<!--bbb-->
    // 注意，html嵌套注释是多个 <!-- 对应一个 -->，也就是说结束标志 --> 永远只有一个
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      // 移除嵌套<!--的前面部分，更新offset line column source到context上
      advanceBy(context, nestedIndex - prevIndex + 1)
      // 嵌套的<!--没有对应的结束标志，报错
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      // prevIndex指向当前<!--的 !
      prevIndex = nestedIndex + 1
    }
    // 移除最后一个嵌套的<!--xxx-->部分，更新offset line column source到context上
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  // 到这里context上的offset line column source移除了全部注释字符串

  return {
    type: NodeTypes.COMMENT,
    content, // 注释内容部分
    loc: getSelection(context, start)
  }
}

// <!DOCTYPE html> 会走这里
function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) { // 没有结束 > ，就处理到source结束
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else { // 有结束 > ，就处理到 >
    // <!DOCTYPE html> 的content是 DOCTYPE html
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content, // DOCTYPE html
    loc: getSelection(context, start)
  }
}

// 只有起始标签会走到这里
// 整个标签解析完成，从 起始标签 到 children 再到 结束标签
// 返回标签解析完成后的对象element
function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  // 处理起始标签
  // 在pre标签内
  const wasInPre = context.inPre
  // 在带有v-pre属性的标签内
  const wasInVPre = context.inVPre
  const parent = last(ancestors)
  // 解析开始<div id='xxx'>
  // 这里会解析标签上的属性，处理 v-xxx : @ #
  // 返回标签解析后的对象
  const element = parseTag(context, TagType.Start, parent)
  // 不在pre标签内，但自身是pre标签
  const isPreBoundary = context.inPre && !wasInPre
  // 不在带有v-pre属性的标签内，但自身标签带有v-pre属性
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 自闭合 或是 单标签(也相当于自闭合，只是可以省略标签末尾的 / )
  // 直接返回解析后的对象element，不需要处理children和结束标签
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  // 处理children
  // 将children的父标签对象，也就是当前element推入ancestors中
  ancestors.push(element)
  // 获取element的textMode
  const mode = context.options.getTextMode(element, parent)
  // 解析children，内部会递归遍历整个子标签
  // 返回nodes作为父element对象的children
  const children = parseChildren(context, mode, ancestors)
  // 处理完element的children之后，将element从ancestors中移除
  ancestors.pop()

  // 解析完成的children数组存放在element.children上
  element.children = children

  // End tag.
  // 处理结束标签
  if (startsWithEndTagOpen(context.source, element.tag)) { // 是对应的结束标签，解析结束标签
    // 虽然返回标签解析后的对象，但是不需要，ast语法树中不需要将起始标签和结束标签分开来
    parseTag(context, TagType.End, parent)
  } else { // 不是对应的结束标签，报错
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  // 更新element的loc，从起始标签的开头到结束标签的末尾
  element.loc = getSelection(context, element.loc.start)

  // pre标签结束之后，将context.inPre重置为false，不影响后续标签的解析
  if (isPreBoundary) {
    context.inPre = false
  }
  // 带v-pre属性的标签结束之后，将context.inVPre重置为false，不影响后续标签的解析
  if (isVPreBoundary) {
    context.inVPre = false
  }
  // 整个标签解析完成，从 起始标签 到 children 再到 结束标签
  // 返回标签解析完成后的对象element
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
// 解析开始和结束标签 <div id='xxx'> </div>
// 这里会解析标签上的属性，处理 v-xxx : @ #
// 返回标签解析后的对象
function parseTag(
  context: ParserContext,
  type: TagType, // TagType.Start | TagType.End
  parent: ElementNode | undefined
): ElementNode {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  const start = getCursor(context)
  // 匹配标签开头 <div </div
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  // 标签名
  const tag = match[1]
  // 获取命名空间
  const ns = context.options.getNamespace(tag, parent)

  // 解析处理标签开头 <div </div
  advanceBy(context, match[0].length)
  // 跳过空格
  advanceSpaces(context)

  // save current state in case we need to re-parse attributes with v-pre
  // 暂存处理完标签开头和空格的状态，v-pre中会用到
  const cursor = getCursor(context)
  const currentSource = context.source

  // Attributes.
  // 解析标签的属性，返回包含每一个解析完成的attr对象的props数组
  // 不带属性的起始标签和结束标签，这里的props为空数组[]
  let props = parseAttributes(context, type)

  // check <pre> tag
  // <pre> html原生标签
  // 保留空格和换行符 文本呈现为等宽字体
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // check v-pre
  // 父标签没有v-pre，但是自身标签有v-pre，标记context.inVPre为true
  // 影响Mustache语法和子标签的属性解析
  // context.inVPre标记为true后，重新解析属性
  // 将自身标签上的所有属性当作普通属性解析
  // 自身带v-pre的标签会先完整解析一遍属性，然后重置再完整解析一遍属性
  // 为什么不是第一遍解析到v-pre就中止，然后重置进行完整解析呢???
  if (
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    context.inVPre = true
    // reset context
    // 重置context上的column line offset source，需要重新解析属性
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    // context.inVPre标记为true后，重新解析属性
    // 将自身标签上的所有属性当作普通属性解析
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  // 是否自闭合标签
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 自闭合标签
    isSelfClosing = startsWith(context.source, '/>')
    // 结束标签结尾不应该是 /> ，报错
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 移除标签结尾 > />
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  // 下面的逻辑就是确定标签的tagType
  let tagType = ElementTypes.ELEMENT
  const options = context.options
  // 任何以"ion-"开头的元素都将被识别为自定义元素
  // app.config.isCustomElement = tag => tag.startsWith('ion-')
  // 指定一个方法，用来识别在 Vue 之外定义的自定义元素（例如，使用 Web Components API）
  // 如果组件符合此条件，则不需要本地或全局注册，并且 Vue 不会抛出关于 Unknown custom element 的警告
  // 不在v-pre内 且 不是自定义元素
  if (!context.inVPre && !options.isCustomElement(tag)) {
    // v-is
    const hasVIs = props.some(
      p => p.type === NodeTypes.DIRECTIVE && p.name === 'is'
    )
    if (options.isNativeTag && !hasVIs) { // 不带v-is，非原生标签(html svg)，就是ElementTypes.COMPONENT
      if (!options.isNativeTag(tag)) tagType = ElementTypes.COMPONENT
    } else if (
      hasVIs || // v-is
      isCoreComponent(tag) || // teleport suspense keep-alive base-transition
      (options.isBuiltInComponent && options.isBuiltInComponent(tag)) || // transition transition-group
      /^[A-Z]/.test(tag) || // 以大写字母开头的标签
      tag === 'component' // 组件
    ) { // 以上5种情况都认为是组件 ElementTypes.COMPONENT
      tagType = ElementTypes.COMPONENT
    }

    if (tag === 'slot') { // slot标签
      tagType = ElementTypes.SLOT
    } else if ( // 带 v-if v-else v-else-if v-for v-slot 的template标签
      tag === 'template' && // template标签
      props.some(p => {
        return (
          // v-if v-else v-else-if v-for v-slot
          p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      })
    ) {
      tagType = ElementTypes.TEMPLATE
    }
  }

  return {
    type: NodeTypes.ELEMENT, // type都是NodeTypes.ELEMENT，但是tagType有区别
    ns, // 命名空间
    tag, // 标签名
    tagType, // ElementTypes.ELEMENT ElementTypes.COMPONENT ElementTypes.SLOT ElementTypes.TEMPLATE
    props, // 解析过的属性数组
    isSelfClosing, // 自闭合标签
    children: [],
    loc: getSelection(context, start), // 整个标签的loc，从起始标签的 < 到 结束标签的 >
    codegenNode: undefined // to be created during transform phase
  }
}

// 解析标签的属性，返回包含每一个解析完成的attr对象的props数组
function parseAttributes(
  context: ParserContext,
  type: TagType // TagType.Start | TagType.End
): (AttributeNode | DirectiveNode)[] {
  const props = []
  // 属性名set，用来去重，重复定义报错
  const attributeNames = new Set<string>()
  // 带属性的起始标签在这里解析所有属性成attr对象，存储在props中
  // 结束标签直接跳过这个循环，返回空的props
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') && // 开头不是 >
    !startsWith(context.source, '/>') // 开头不是 />
  ) {
    // 开头是 / ，会报错，并解析移除，跳过空格，继续解析
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    // 结束标签不会有属性，也就不会走进这个循环，能走进循环的直接报错
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 解析单个属性
    // 内部包括对 v- : @ # 的处理，将其都处理成NodeTypes.DIRECTIVE
    // 普通属性处理成NodeTypes.ATTRIBUTE
    const attr = parseAttribute(context, attributeNames)
    // 起始标签，将解析完成的attr对象推入props中
    if (type === TagType.Start) {
      props.push(attr)
    }

    // 属性之间没有空格，报错
    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    // 移除空格
    advanceSpaces(context)
  }
  // 带属性的起始标签返回包含每一个解析完成的attr对象的props数组
  // 结束标签直接返回空的props
  return props
}

// 解析单个属性
// 内部包括对 v- : @ # 的处理，将其都处理成NodeTypes.DIRECTIVE
// 普通属性处理成NodeTypes.ATTRIBUTE
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string> // attributeNames
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  const start = getCursor(context)
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  // 属性名
  const name = match[0]

  // 重复定义报错
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  nameSet.add(name)

  // 属性名开头是 = ，报错
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  // 属性名中每有一个 " ' < ，都报错一次
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 解析移除属性名
  advanceBy(context, name.length)

  // Value
  let value:
    | {
        content: string
        isQuoted: boolean
        loc: SourceLocation
      }
    | undefined = undefined

  // 直接 = 或者 = 前面有多个空格，一般属性会走这个逻辑
  // 有些不需要传入值的属性，不走这个逻辑，因为没有 =，如 v-pre v-slot v-xxx
  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    // 移除 = 前面空格
    advanceSpaces(context)
    // 移除 =
    advanceBy(context, 1)
    // 再移除 = 后面的空格
    advanceSpaces(context)
    // 走到这里的context.source的开头已经是value了
    // 返回{ content, isQuoted, loc: getSelection(context, start)
    // content指向 去除引号的value字符串
    // isQuoted表示 是否被引号包裹，一般都是引号包裹的，也有例外，如 Boolean
    // loc 包括包裹的引号
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  // 这个是从属性名开始到value结束的loc
  const loc = getSelection(context, start)

  // 以 v- : @ #(具名插槽，如 #header #default) 开头的属性名
  // 父标签是带v-pre，这个就不做处理，直接跳过
  // 自身的v-pre会在这里处理
  if (!context.inVPre && /^(v-|:|@|#)/.test(name)) {
    // 匹配 v-aaa v-aaa:[bbb].ddd v-aaa:ccc.ddd @[bbb].ddd @ccc.ddd #ccc
    // match[1] => aaa
    // match[2] => [bbb] ccc
    // match[3] => .ddd
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
      name
    )!

    // v-aaa => aaa
    // : => bind
    // @ => on
    // # => slot
    const dirName =
      match[1] ||
      (startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot')

    let arg: ExpressionNode | undefined

    // 只有 v-aaa 这一种情况没有 match[2]
    if (match[2]) {
      // v-slot:default 或 #default
      const isSlot = dirName === 'slot'
      const startOffset = name.indexOf(match[2])
      // 这个loc是match[2]的位置对象
      const loc = getSelection(
        context,
        // 不影响原start和context，返回一个克隆的pos，这个pos移除了开头的 v-aaa v-aaa: : @ #
        getNewPosition(context, start, startOffset),
        // 不影响原start和context，返回一个克隆的pos，这个pos移除了.修饰符前面的所有字符串(slot则是整个name都移除了)
        // v-slot并没有.修饰符，但是Vue2.x支持这种用法，这里也做保留
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      let content = match[2]
      let isStatic = true

      if (content.startsWith('[')) { // match[2]是以[开头，说明是属性名是变量，标记非静态
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }

        // content移除头尾[]，取到中间变量字符串
        content = content.substr(1, content.length - 2)
      } else if (isSlot) { // slot
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        // v-slot并没有.修饰符，但是Vue2.x支持这种用法，这里也做保留
        content += match[3] || ''
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content, // 属性名，包括静态属性名(xxx)和变量属性名([xxx]，这里content已经去除了包裹的[])
        isStatic, // 标记是否为静态属性名
        isConstant: isStatic, // isConstant同isStatic
        loc // match[2]属性名的位置对象，变量属性名包括包裹的[]
      }
    }

    // value.loc去除包裹的引号
    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    // 以 v- : @ #(具名插槽，如 #header #default) 开头的属性名
    // 父标签是带v-pre，不会执行到这里
    // 自身的v-pre会在这里处理
    return {
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      exp: value && { // value对象，没有属性值的情况这里为undefined，如 #default v-xxx
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // true by `transformExpression` to make it eligible for hoisting.
        isConstant: false,
        loc: value.loc
      },
      arg, // 属性名对象，没有属性名的情况这里为undefined，如 v-xxx
      modifiers: match[3] ? match[3].substr(1).split('.') : [], // .修饰符数组，支持多个链式
      loc // 从属性名开始到value结束的loc
    }
  }

  // 父标签带v-pre 普通属性
  // 父标签带v-pre时当前标签的所有属性都当作普通属性
  return {
    type: NodeTypes.ATTRIBUTE,
    name, // 属性名
    value: value && { // 没有属性值的情况，这里为undefined，如 checked
      type: NodeTypes.TEXT,
      content: value.content, // 去除引号的value字符串
      loc: value.loc // 包括包裹的引号
    },
    loc // 从属性名开始到value结束的loc
  }
}

// 走到这里的context.source的开头已经是value了
// 返回{ content, isQuoted, loc: getSelection(context, start)
// content指向 去除引号的value字符串
// isQuoted表示 是否被引号包裹，一般都是引号包裹的，也有例外，如 Boolean
// loc 包括包裹的引号
function parseAttributeValue(
  context: ParserContext
):
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) { // value开头是引号，一般都是引号包裹的
    // Quoted value.
    // 移除开头引号
    advanceBy(context, 1)

    // 结尾引号
    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) { // 没有结尾引号，处理到context.source结束
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else { // 有结尾引号，处理引号中间的内容
      // value一般没有 &，所以content就是引号中间的字符串
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      // 移除结尾引号
      advanceBy(context, 1)
    }
  } else { // value开头不是引号，如 true false
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    // value以空格开头，直接返回undefined
    if (!match) {
      return undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    // value字符串每有一个 " ' < = ，就报错一次
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    // content指向value字符串
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  return { content, isQuoted, loc: getSelection(context, start) }
}

// Mustache语法解析 {{ xxx }}
// 返回对象{ type, content, loc }
// content存储 去除首尾空格后的内容字符串和位置对象loc
// loc存储 没有去除首尾空格的位置对象
function parseInterpolation(
  context: ParserContext,
  mode: TextModes // TextModes.DATA
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  const closeIndex = context.source.indexOf(close, open.length)
  // 找不到结束标志，报错
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  // 老的{ column, line, offset }
  const start = getCursor(context)
  // 移除open.length部分，更新offset line column source到context上
  advanceBy(context, open.length)
  // 新的{ column, line, offset }
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  // 内容部分长度
  const rawContentLength = closeIndex - open.length
  // 内容字符串
  const rawContent = context.source.slice(0, rawContentLength)
  // 带空格的内容字符串
  // 内部会移除rawContentLength部分，更新offset line column source到context上
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  // 去除首尾空格的内容字符串
  const content = preTrimContent.trim()
  // 首个非空格字符串的index
  const startOffset = preTrimContent.indexOf(content)
  // 获取解析完startOffset(也就是开头的空格)之后的新的offset line column更新到innerStart中
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  // 结尾首个空格的index
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  // 获取解析完endOffset(也就是 开头的空格加内容 )之后的新的offset line column更新到innerEnd中
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  // 移除close.length部分，更新offset line column source到context上
  advanceBy(context, close.length)

  // 这里context上的offset line column source已经是移除掉单个完整Mustache语法部分了，包括
  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      isConstant: false,
      // 去除首尾空格的内容字符串
      content,
      // { start: innerStart, end: innerEnd, source: context.originalSource.slice(start.offset, end.offset) }
      // loc.source不就是 去除首尾空格的内容字符串content 吗???
      // 这个loc存储的是 去除首尾空格的
      loc: getSelection(context, innerStart, innerEnd)
    },
    // 这个loc存储的是 没有去除首尾空格的
    loc: getSelection(context, start)
  }
}

// 找到文本内容，解析文本节点
// 返回解析文本节点完成的对象{ type: NodeTypes.TEXT, content, loc }
function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  // ['<', '{{']
  const endTokens = ['<', context.options.delimiters[0]]
  if (mode === TextModes.CDATA) {
    endTokens.push(']]>')
  }

  let endIndex = context.source.length
  // 依次找 < {{ ]]> 的index，也就是找文本的内容
  // endIndex是下一个 < {{ ]]> 的index，前面的内容就是当前文本内容
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  const start = getCursor(context)
  // 通过先innerHTML再textContent的方式取文本内容
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT,
    content, // 文本内容
    loc: getSelection(context, start) // 从 文本开始 到 文本结束 的loc
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
// 通过先innerHTML再textContent的方式取文本内容
// 内部会移除length部分，更新offset line column source到context上
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  const rawText = context.source.slice(0, length)
  // 移除length部分，更新offset line column source到context上
  advanceBy(context, length)
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    rawText.indexOf('&') === -1
  ) {
    return rawText
  } else { // TextModes.DATA 或 TextModes.RCDATA ，且有 &
    // DATA or RCDATA containing "&"". Entity decoding required.
    // 通过先innerHTML再textContent的方式取文本内容
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

// { start, end, source: context.originalSource.slice(start.offset, end.offset) }
function getSelection(
  context: ParserContext,
  start: Position, // innerStart
  end?: Position // innerEnd
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

// 移除numberOfCharacters部分，更新offset line column source到context上
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  // 获取解析完numberOfCharacters之后的新的offset line column更新到context中
  advancePositionWithMutation(context, source, numberOfCharacters)
  // source移除numberOfCharacters部分
  context.source = source.slice(numberOfCharacters)
}

// 跳过空格
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

// 不影响原start和context，返回一个克隆的pos
function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  // 不影响原start，返回一个克隆的pos
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

// 是否结束标签
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  const s = context.source

  switch (mode) {
    case TextModes.DATA:
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  return !s
}

// 是否是对应的结束标签
function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') && // 以 </ 开头
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() && // 标签名是tag
    /[\t\n\f />]/.test(source[2 + tag.length] || '>') // 标签名和>之间可以有\t\n\f空格，如 </div> </div   >
  )
}
