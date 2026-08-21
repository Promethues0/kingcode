/**
 * 调用方 3：一行摘要。把 format 直接当回调传给 map / 当参数传给渲染器，
 * 不自己包一层箭头函数。
 */

import { fileURLToPath } from 'node:url'
import { format } from './format.js'
import { LINES } from './data.js'

/** 把一组数用给定的格式化器渲染成 ` | ` 分隔的一行。 */
export function renderRow(values, formatter) {
  return values.map(formatter).join(' | ')
}

export function summarize(values = LINES.map(l => l.price)) {
  return renderRow(values, format)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(summarize())
}
