import { ComponentInternalInstance, ssrContextKey } from 'vue'
import {
  SSRContext,
  createBuffer,
  PushFn,
  SSRBufferItem
} from '../renderToString'


// target可用
//    父buffer中就是<!--teleport start--><!--teleport end-->
//    appContext.provides[ssrContextKey].__teleportBuffers[target]就是teleport自身的buffer数组
// target不可用
//    父buffer中就是<!--teleport start-->teleport自身的buffer数组<!--teleport end-->
//    appContext.provides[ssrContextKey].__teleportBuffers[target]就是<!---->
export function ssrRenderTeleport(
  parentPush: PushFn,
  contentRenderFn: (push: PushFn) => void,
  target: string,
  disabled: boolean,
  parentComponent: ComponentInternalInstance
) {
  // teleport占位符推入父buffer数组
  parentPush('<!--teleport start-->')

  let teleportContent: SSRBufferItem

  if (disabled) { // target不可用
    // renderVNodeChildren，推入父buffer数组中
    contentRenderFn(parentPush)
    teleportContent = `<!---->`
  } else { // target可用
    // 创建当前teleport对应的buffer数组
    // renderVNodeChildren，推入自己的buffer数组中
    const { getBuffer, push } = createBuffer()
    contentRenderFn(push)
    // 推入结束占位符到父buffer数组中
    push(`<!---->`) // teleport end anchor
    // teleportContent指向的是teleport的children的buffer数组
    teleportContent = getBuffer()
  }

  // appContext都是继承的父组件的，所以appContext指向的一定是根vnode，也就是整个app的context
  const context = parentComponent.appContext.provides[
    ssrContextKey as any
  ] as SSRContext
  const teleportBuffers =
    context.__teleportBuffers || (context.__teleportBuffers = {})
    // target可用，teleportContent指向的是teleport的children的buffer数组
    // target不可用，teleportContent就是<!---->
  if (teleportBuffers[target]) {
    teleportBuffers[target].push(teleportContent)
  } else {
    teleportBuffers[target] = [teleportContent]
  }

  // 结束占位符推入父buffer数组中
  parentPush('<!--teleport end-->')
}
