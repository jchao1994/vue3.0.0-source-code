import {
  App,
  Component,
  ComponentInternalInstance,
  VNode,
  VNodeArrayChildren,
  createVNode,
  Text,
  Comment,
  Static,
  Fragment,
  ssrUtils,
  Slots,
  createApp,
  ssrContextKey,
  warn,
  DirectiveBinding,
  VNodeProps,
  mergeProps
} from 'vue'
import {
  ShapeFlags,
  isString,
  isPromise,
  isArray,
  isFunction,
  isVoidTag,
  escapeHtml,
  NO,
  generateCodeFrame,
  escapeHtmlComment
} from '@vue/shared'
import { compile } from '@vue/compiler-ssr'
import { ssrRenderAttrs } from './helpers/ssrRenderAttrs'
import { SSRSlots } from './helpers/ssrRenderSlot'
import { CompilerError } from '@vue/compiler-dom'
import { ssrRenderTeleport } from './helpers/ssrRenderTeleport'

const {
  isVNode,
  createComponentInstance,
  setCurrentRenderingInstance,
  setupComponent,
  renderComponentRoot,
  normalizeVNode,
  normalizeSuspenseChildren
} = ssrUtils

// Each component has a buffer array.
// A buffer array can contain one of the following:
// - plain string
// - A resolved buffer (recursive arrays of strings that can be unrolled
//   synchronously)
// - An async buffer (a Promise that resolves to a resolved buffer)
export type SSRBuffer = SSRBufferItem[]
export type SSRBufferItem =
  | string
  | ResolvedSSRBuffer
  | Promise<ResolvedSSRBuffer>
export type ResolvedSSRBuffer = (string | ResolvedSSRBuffer)[]

export type PushFn = (item: SSRBufferItem) => void

export type Props = Record<string, unknown>

export type SSRContext = {
  [key: string]: any
  teleports?: Record<string, string>
  __teleportBuffers?: Record<string, SSRBuffer>
}

// 返回一个带getBuffer和push的对象
export function createBuffer() {
  let appendable = false
  let hasAsync = false
  const buffer: SSRBuffer = []
  return {
    getBuffer(): ResolvedSSRBuffer | Promise<ResolvedSSRBuffer> {
      // If the current component's buffer contains any Promise from async children,
      // then it must return a Promise too. Otherwise this is a component that
      // contains only sync children so we can avoid the async book-keeping overhead.
      return hasAsync ? Promise.all(buffer) : (buffer as ResolvedSSRBuffer)
    },
    push(item: SSRBufferItem) {
      const isStringItem = isString(item)
      if (appendable && isStringItem) { // 上一个和当前这个都是string，直接在上一个的后面拼接字符串
        buffer[buffer.length - 1] += item as string
      } else { // 其他情况，无法拼接字符串，push到buffer中
        buffer.push(item)
      }
      appendable = isStringItem
      // 不是string，也不是array，就是promise
      // 只要buffer中有一个为promise，就标记hasAsync为true，getBuffer时就会Promise.all处理
      // 当前层级一般都为string，嵌套组件会将子组件的buffer数组直接推入父组件的buffer数组中，最后会统一处理成整个html
      if (!isStringItem && !isArray(item)) {
        // promise
        hasAsync = true
      }
    }
  }
}

// 将buffer数组转为整个html返回
function unrollBuffer(buffer: ResolvedSSRBuffer): string {
  let ret = ''
  for (let i = 0; i < buffer.length; i++) {
    const item = buffer[i]
    if (isString(item)) {
      ret += item
    } else {
      ret += unrollBuffer(item)
    }
  }
  return ret
}

// 先将vnode拼接字符串，推入buffer数组，最后将buffer数组拼接成整个html
// 每个组件会有自己的buffer数组，子组件的buffer数组会存放在父组件的buffer素组中，形成嵌套，最后统一处理成整个html
// suspense会直接忽略fallback，直接content
// teleport做特殊处理，将每个teleport对应的target-html存放在context.__teleportBuffers中，没有拼接到最后的html中
// 这里的context是vnode.appContext.provides[ssrContextKey]，也就是整个app的context
// 也就是，这里返回整个不带teleport的html，以及context.__teleportBuffers上存储了teleport对应的target-html
// Vue3.x与Vue2.x的用法有点不同
// Vue2.x
//    renderer.renderToString(app, (err, html) => { res.end(html) })
//    renderer.renderToString(app).then(html => res.end(html))
// Vue3.x，不支持传入回调
//    renderer.renderToString(app).then(html => res.end(html))
export async function renderToString(
  input: App | VNode, // 最终都是app对象，带use mixin component directive mount unmount provide方法
  context: SSRContext = {}
): Promise<string> {
  // input已经是vnode了，将其转化为app对象
  if (isVNode(input)) {
    // raw vnode, wrap with app (for context)
    return renderToString(createApp({ render: () => input }), context)
  }

  // rendering an app
  // input._component 组件选项
  // input._props createApp传入的第二个参数rootProps
  // 创建vnode，同app.mount
  const vnode = createVNode(input._component, input._props)
  // vnode绑定appContext，同app.mount
  vnode.appContext = input._context
  // provide the ssr context to the tree
  // 添加SSR context到input和其vnode上
  // input._context.provides[ssrContextKey] = context
  // vnode.appContext.provides[ssrContextKey] = context
  input.provide(ssrContextKey, context)
  // 拿到根vnode的subTree对应的buffer数组
  // vnode.appContext.provides[ssrContextKey].__teleportBuffers中也存放了每个teleport对应的target-buffer
  // 也就是context.__teleportBuffers中也存放了每个teleport对应的target-buffer
  const buffer = await renderComponentVNode(vnode)

  // context.teleports存放teleport相关的html
  // target-html
  await resolveTeleports(context)

  // 将buffer数组转为整个html返回
  return unrollBuffer(buffer)
}

export function renderComponent(
  comp: Component,
  props: Props | null = null,
  children: Slots | SSRSlots | null = null,
  parentComponent: ComponentInternalInstance | null = null
): ResolvedSSRBuffer | Promise<ResolvedSSRBuffer> {
  return renderComponentVNode(
    createVNode(comp, props, children),
    parentComponent
  )
}

// 返回组件的subTree(也就是组件vue文件template的内容)的buffer数组
// 或是 promise ，这里是针对defineAsyncComponent异步组件
function renderComponentVNode(
  vnode: VNode, // 初始vnode
  parentComponent: ComponentInternalInstance | null = null
): ResolvedSSRBuffer | Promise<ResolvedSSRBuffer> {
  // 创建组件实例
  const instance = createComponentInstance(vnode, parentComponent, null)
  // 执行setup，根据setupResult生成instance.render函数(setupResult为函数，即为render函数，否则通过模板编译生成render函数)
  // 一般情况，这里的res为undefined
  // 只有 renderToString过程中 且 当前组件是defineAsyncComponent异步组件 时，这里的res为promise
  // 异步组件加载完毕之后，会将返回的render函数放在instance.render上，然后走到这里
  const res = setupComponent(instance, true /* isSSR */)
  if (isPromise(res)) { // 异步组件加载会返回一个promise，这里promise内部完成异步加载组件，然后把setup的返回值render函数放到instance.render上，然后走这里的逻辑
    return res
      .catch(err => {
        warn(`[@vue/server-renderer]: Uncaught error in async setup:\n`, err)
      })
      .then(() => renderComponentSubTree(instance))
  } else {
    return renderComponentSubTree(instance)
  }
}

// 处理好instance.render后，就走到这里的逻辑
// 客户端渲染生成render函数之后，就立马setupRenderEffect创建instance.update，也就是render effect了
// 返回组件的subTree(也就是组件vue文件template的内容)的buffer数组
function renderComponentSubTree(
  instance: ComponentInternalInstance
): ResolvedSSRBuffer | Promise<ResolvedSSRBuffer> {
  // 组件选项
  const comp = instance.type as Component
  const { getBuffer, push } = createBuffer()
  if (isFunction(comp)) { // 函数组件，无状态组件
    // renderComponentRoot(instance)会执行instance.render函数渲染subTree，得到subTree对应的vnode
    renderVNode(push, renderComponentRoot(instance), instance)
  } else { // 状态组件，常规vue文件
    // 没有render函数和ssrRender函数，进行模板编译，生成ssrRender函数
    if (!instance.render && !comp.ssrRender && isString(comp.template)) {
      comp.ssrRender = ssrCompile(comp.template, instance)
    }

    if (comp.ssrRender) { // 模板编译 | 通过组件选项传入render函数
      // optimized
      // set current rendering instance for asset resolution
      setCurrentRenderingInstance(instance)
      comp.ssrRender(instance.proxy, push, instance)
      setCurrentRenderingInstance(null)
    } else if (instance.render) { // setup返回render函数
      renderVNode(push, renderComponentRoot(instance), instance)
    } else { // 其他情况，报错
      warn(
        `Component ${
          comp.name ? `${comp.name} ` : ``
        } is missing template or render function.`
      )
      push(`<!---->`)
    }
  }
  return getBuffer()
}

type SSRRenderFunction = (
  context: any,
  push: (item: any) => void,
  parentInstance: ComponentInternalInstance
) => void
const compileCache: Record<string, SSRRenderFunction> = Object.create(null)

function ssrCompile(
  template: string,
  instance: ComponentInternalInstance
): SSRRenderFunction {
  // 缓存模板编译结果，也就是ssrRender函数
  const cached = compileCache[template]
  if (cached) {
    return cached
  }

  const { code } = compile(template, {
    isCustomElement: instance.appContext.config.isCustomElement || NO,
    isNativeTag: instance.appContext.config.isNativeTag || NO,
    onError(err: CompilerError) {
      if (__DEV__) {
        const message = `[@vue/server-renderer] Template compilation error: ${
          err.message
        }`
        const codeFrame =
          err.loc &&
          generateCodeFrame(
            template as string,
            err.loc.start.offset,
            err.loc.end.offset
          )
        warn(codeFrame ? `${message}\n${codeFrame}` : message)
      } else {
        throw err
      }
    }
  })
  return (compileCache[template] = Function('require', code)(require))
}

// 将vnode拼接成字符串推入buffer数组
function renderVNode(
  push: PushFn,
  vnode: VNode, // subTree对应的vnode
  parentComponent: ComponentInternalInstance
) {
  const { type, shapeFlag, children } = vnode
  switch (type) {
    case Text: // 文本vnode，处理完文本children后推入buffer数组中
      // " & ' < > 转换成html格式
      push(escapeHtml(children as string))
      break
    case Comment: // 注释vnode，统一用<!---->包裹，推入到buffer数组中
      push(
        // 去除注释节点的首尾占位符，如 <!----!> <!---->，然后用统一的<!---->包裹
        children ? `<!--${escapeHtmlComment(children as string)}-->` : `<!---->`
      )
      break
    case Static: // 静态vnode，直接将children推入buffer数组中
      push(children as string)
      break
    case Fragment: // fragment，直接将 起始占位符 children 结束占位符 推入buffer数组中
      push(`<!--[-->`) // open // 起始占位符
      renderVNodeChildren(push, children as VNodeArrayChildren, parentComponent)
      push(`<!--]-->`) // close // 结束占位符
      break
    default:
      if (shapeFlag & ShapeFlags.ELEMENT) { // 原生dom
        // 将起始标签 props 作用域id children 结束标签推入buffer数组中
        renderElementVNode(push, vnode, parentComponent)
      } else if (shapeFlag & ShapeFlags.COMPONENT) { // 组件
        // 返回组件的subTree(也就是组件vue文件template的内容)的buffer数组
        // 或是 promise ，这里是针对defineAsyncComponent异步组件
        push(renderComponentVNode(vnode, parentComponent))
      } else if (shapeFlag & ShapeFlags.TELEPORT) { // teleport
        // target可用
        //    父buffer中就是<!--teleport start--><!--teleport end-->
        //    appContext.provides[ssrContextKey].__teleportBuffers[target]就是teleport自身的buffer数组
        // target不可用
        //    父buffer中就是<!--teleport start-->teleport自身的buffer数组<!--teleport end-->
        //    appContext.provides[ssrContextKey].__teleportBuffers[target]就是<!---->
        renderTeleportVNode(push, vnode, parentComponent)
      } else if (shapeFlag & ShapeFlags.SUSPENSE) { // suspense
        // 直接render suspense.content，忽略fallback，因为服务端无需展示fallback
        renderVNode(
          push,
          normalizeSuspenseChildren(vnode).content, // content
          parentComponent
        )
      } else {
        warn(
          '[@vue/server-renderer] Invalid VNode type:',
          type,
          `(${typeof type})`
        )
      }
  }
}

// 遍历children，执行renderVNode，push到buffer数组中
export function renderVNodeChildren(
  push: PushFn,
  children: VNodeArrayChildren,
  parentComponent: ComponentInternalInstance
) {
  for (let i = 0; i < children.length; i++) {
    renderVNode(push, normalizeVNode(children[i]), parentComponent)
  }
}

// 原生dom的html拼接，将起始标签 props 作用域id children 结束标签推入buffer数组中
function renderElementVNode(
  push: PushFn,
  vnode: VNode,
  parentComponent: ComponentInternalInstance
) {
  const tag = vnode.type as string
  let { props, children, shapeFlag, scopeId, dirs } = vnode
  let openTag = `<${tag}`

  // 将自定义指令合并到props中
  if (dirs) {
    props = applySSRDirectives(vnode, props, dirs)
  }

  // 处理props，拼接成字符串
  if (props) {
    openTag += ssrRenderAttrs(props, tag)
  }

  // 处理作用域id
  if (scopeId) {
    openTag += ` ${scopeId}`
    const treeOwnerId = parentComponent && parentComponent.type.__scopeId
    // vnode's own scopeId and the current rendering component's scopeId is
    // different - this is a slot content node.
    // 自己的scopeId与treeOwnerId不同，说明自己是一个插槽
    // 后面拼接上${treeOwnerId}-s，标记是插槽
    if (treeOwnerId && treeOwnerId !== scopeId) {
      openTag += ` ${treeOwnerId}-s`
    }
  }

  // 拼接>后形成完成的起始标签，推入buffer数组中
  push(openTag + `>`)
  // tag不是单标签元素，拼接children和结束标签，推入buffer数组中
  if (!isVoidTag(tag)) {
    let hasChildrenOverride = false
    // 将innerHTML textContent textarea的value推入buffer数组
    // 一旦有以上三种中的一种，会覆盖其他children
    if (props) {
      if (props.innerHTML) {
        hasChildrenOverride = true
        push(props.innerHTML)
      } else if (props.textContent) {
        hasChildrenOverride = true
        push(escapeHtml(props.textContent))
      } else if (tag === 'textarea' && props.value) {
        hasChildrenOverride = true
        push(escapeHtml(props.value))
      }
    }
    // 没有以上三种，处理其他children
    if (!hasChildrenOverride) {
      if (shapeFlag & ShapeFlags.TEXT_CHILDREN) { // 文本children
        push(escapeHtml(children as string))
      } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) { // 数组children
        // 遍历children，执行renderVNode，push到buffer数组中
        renderVNodeChildren(
          push,
          children as VNodeArrayChildren,
          parentComponent
        )
      }
    }
    // 结束标签推入buffer数组中
    push(`</${tag}>`)
  }
}

// 将自定义指令合并到props中
function applySSRDirectives(
  vnode: VNode,
  rawProps: VNodeProps | null, // props
  dirs: DirectiveBinding[] // dirs
): VNodeProps {
  const toMerge: VNodeProps[] = []
  for (let i = 0; i < dirs.length; i++) {
    // 这里的binding包括哪些属性???
    const binding = dirs[i]
    const {
      dir: { getSSRProps }
    } = binding
    if (getSSRProps) {
      const props = getSSRProps(binding, vnode)
      if (props) toMerge.push(props)
    }
  }
  return mergeProps(rawProps || {}, ...toMerge)
}

// target可用
//    父buffer中就是<!--teleport start--><!--teleport end-->
//    appContext.provides[ssrContextKey].__teleportBuffers[target]就是teleport自身的buffer数组
// target不可用
//    父buffer中就是<!--teleport start-->teleport自身的buffer数组<!--teleport end-->
//    appContext.provides[ssrContextKey].__teleportBuffers[target]就是<!---->
function renderTeleportVNode(
  push: PushFn,
  vnode: VNode,
  parentComponent: ComponentInternalInstance
) {
  // 目标容器
  const target = vnode.props && vnode.props.to
  // 目标容器是否不可用
  const disabled = vnode.props && vnode.props.disabled
  // 服务端渲染renderToString中teleport必须要有to属性指向目标容器，否则就忽略teleport
  // 而客户端渲染会自动降级到使用父vnode对应的el作为容器
  if (!target) {
    warn(`[@vue/server-renderer] Teleport is missing target prop.`)
    return []
  }
  // to属性必须是string selector
  if (!isString(target)) {
    warn(
      `[@vue/server-renderer] Teleport target must be a query selector string.`
    )
    return []
  }
  // target可用
  //    父buffer中就是<!--teleport start--><!--teleport end-->
  //    appContext.provides[ssrContextKey].__teleportBuffers[target]就是teleport自身的buffer数组
  // target不可用
  //    父buffer中就是<!--teleport start-->teleport自身的buffer数组<!--teleport end-->
  //    appContext.provides[ssrContextKey].__teleportBuffers[target]就是<!---->
  ssrRenderTeleport(
    push,
    push => {
      renderVNodeChildren(
        push,
        vnode.children as VNodeArrayChildren,
        parentComponent
      )
    },
    target,
    disabled || disabled === '',
    parentComponent
  )
}

// context.teleports存放teleport相关的html
// target-html
async function resolveTeleports(context: SSRContext) {
  // 处理teleport的buffer数组
  if (context.__teleportBuffers) {
    context.teleports = context.teleports || {}
    for (const key in context.__teleportBuffers) {
      // note: it's OK to await sequentially here because the Promises were
      // created eagerly in parallel.
      // 将buffer数组转为整个html返回
      context.teleports[key] = unrollBuffer(
        await Promise.all(context.__teleportBuffers[key])
      )
    }
  }
}
