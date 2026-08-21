/**
 * 调用方 2：导出 CSV。format() 的结果里带千分位逗号，所以必须整体加引号；
 * 导入方按「引号里的内容」原样读回，任何字符差异都会让下游对账失败。
 */

import { fileURLToPath } from 'node:url'
import { format } from './format.js'
import { LINES } from './data.js'

export function toCsv(lines = LINES) {
  const header = 'sku,qty,price,amount'
  const body = lines.map(l => [l.sku, l.qty, `"${format(l.price)}"`, `"${format(l.qty * l.price)}"`].join(','))
  return [header, ...body].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(toCsv())
}
