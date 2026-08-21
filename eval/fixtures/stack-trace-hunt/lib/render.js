/**
 * 文本渲染：一张订单一行，列宽固定，方便肉眼对齐。
 */

import { findCustomer } from './customers.js'

export function renderRow(order) {
  const customer = findCustomer(order.customer)
  const who = customer.name.padEnd(12)
  const amount = (order.amountCents / 100).toFixed(2).padStart(9)
  return `#${order.id}  ${who}${amount}  ${customer.tier}`
}

export function renderTotal(orders) {
  const cents = orders.reduce((sum, o) => sum + o.amountCents, 0)
  return `合计 ${orders.length} 单 ${(cents / 100).toFixed(2)}`
}
