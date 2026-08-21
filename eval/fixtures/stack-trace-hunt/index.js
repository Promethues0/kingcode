/**
 * 对账单入口：逐张订单打印一行「单号 客户 金额 等级」，末尾打合计。
 * 跑法：node index.js [orders.json]（缺省读 data/orders.json）。
 */

import { readFileSync } from 'node:fs'
import { renderRow, renderTotal } from './lib/render.js'

const source = process.argv[2] ?? new URL('./data/orders.json', import.meta.url)
const orders = JSON.parse(readFileSync(source, 'utf8'))

for (const order of orders) console.log(renderRow(order))
console.log(renderTotal(orders))
