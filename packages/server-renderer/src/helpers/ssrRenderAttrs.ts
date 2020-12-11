import { escapeHtml, stringifyStyle } from '@vue/shared'
import {
  normalizeClass,
  normalizeStyle,
  propsToAttrMap,
  isString,
  isOn,
  isSSRSafeAttrName,
  isBooleanAttr,
  makeMap
} from '@vue/shared'

const shouldIgnoreProp = makeMap(`key,ref,innerHTML,textContent`)

// 处理props，拼接成字符串
export function ssrRenderAttrs(
  props: Record<string, unknown>, // 处理过dirs的props
  tag?: string
): string {
  let ret = ''
  for (const key in props) {
    // 跳过特殊的key
    // key ref innerHTML textContent onXXX事件 textarea的value
    if (
      shouldIgnoreProp(key) ||
      isOn(key) ||
      (tag === 'textarea' && key === 'value')
    ) {
      continue
    }
    const value = props[key]
    if (key === 'class') { // 将class统一处理成字符串，用于拼接
      ret += ` class="${ssrRenderClass(value)}"`
    } else if (key === 'style') { // 将style统一处理成字符串，用于拼接
      ret += ` style="${ssrRenderStyle(value)}"`
    } else { // 处理动态attr，用于拼接
      ret += ssrRenderDynamicAttr(key, value, tag)
    }
  }
  return ret
}

// render an attr with dynamic (unknown) key.
// 处理动态attr
export function ssrRenderDynamicAttr(
  key: string,
  value: unknown,
  tag?: string
): string {
  // value的类型只支持string number boolean
  if (!isRenderableValue(value)) {
    return ``
  }
  const attrKey =
    tag && tag.indexOf('-') > 0 // 标签带-
      ? key // preserve raw name on custom elements
      : propsToAttrMap[key] || key.toLowerCase()
  if (isBooleanAttr(attrKey)) { // 只接受boolean的key
    return value === false ? `` : ` ${attrKey}`
  } else if (isSSRSafeAttrName(attrKey)) { // 安全的属性名
    return value === '' ? ` ${attrKey}` : ` ${attrKey}="${escapeHtml(value)}"`
  } else {
    console.warn(
      `[@vue/server-renderer] Skipped rendering unsafe attribute name: ${attrKey}`
    )
    return ``
  }
}

// Render a v-bind attr with static key. The key is pre-processed at compile
// time and we only need to check and escape value.
export function ssrRenderAttr(key: string, value: unknown): string {
  if (!isRenderableValue(value)) {
    return ``
  }
  return ` ${key}="${escapeHtml(value)}"`
}

// value的类型只支持string number boolean
function isRenderableValue(value: unknown): boolean {
  if (value == null) {
    return false
  }
  const type = typeof value
  return type === 'string' || type === 'number' || type === 'boolean'
}

// 将class统一处理成字符串，用于拼接
export function ssrRenderClass(raw: unknown): string {
  return escapeHtml(normalizeClass(raw))
}

// 将style统一处理成字符串，用于拼接
export function ssrRenderStyle(raw: unknown): string {
  if (!raw) {
    return ''
  }
  if (isString(raw)) {
    return escapeHtml(raw)
  }
  // 将style统一处理成object
  const styles = normalizeStyle(raw)
  // 将对象格式的style处理成字符串，用于拼接
  return escapeHtml(stringifyStyle(styles))
}
