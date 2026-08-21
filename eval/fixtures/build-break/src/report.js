/**
 * 把库存数据渲染成纯文本日报：表头 + 每行一条 + 合计；低库存行尾标 " !"。
 */

import { formatMoney, padRight } from './format.js'

export function renderReport(items, { lowStockThreshold = 5 } = {}) {
  const lines = [padRight('SKU', 8) + padRight('Name', 10) + padRight('Qty', 6) + 'Price']
  let totalCents = 0
  for (const item of items) {
    totalCents += item.qty * item.priceCents
    const flag = item.qty <= lowStockThreshold ? ' !' : ''
    lines.push(padRight(item.sku, 8) + padRight(item.name, 10) + padRight(item.qty, 6) + formatMoney(item.priceCents) + flag)
  }
  lines.push(`Total ${formatMoney(totalCents)}`)
  return lines.join('\n')
}
