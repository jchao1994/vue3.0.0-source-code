/* eslint-disable no-restricted-globals */

let decoder: HTMLDivElement

// 通过先innerHTML再textContent的方式取文本内容
export function decodeHtmlBrowser(raw: string): string {
  ;(decoder || (decoder = document.createElement('div'))).innerHTML = raw
  return decoder.textContent as string
}
