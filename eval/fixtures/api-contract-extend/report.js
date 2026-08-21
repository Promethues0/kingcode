/**
 * 调用方 1：对齐的文本报表。靠 format() 返回值的字符宽度做右对齐，
 * 宽度变一个字符，整张表就会错位。
 */

import { fileURLToPath } from 'node:url'
import { format } from './format.js'
import { LINES } from './data.js'

export function renderReport(lines = LINES) {
  const rows = lines.map(l => l.name.padEnd(10) + format(l.price).padStart(12) + format(l.qty * l.price).padStart(14))
  const total = lines.reduce((sum, l) => sum + (Number.isFinite(l.price) ? l.qty * l.price : 0), 0)
  rows.push('-'.repeat(36))
  rows.push('TOTAL'.padEnd(10) + ''.padStart(12) + format(total).padStart(14))
  return rows.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(renderReport())
}
