/**
 * 库存台账：对一个库存项 item（{ sku, qty, reserved? }）做入库、出库、预留。
 * 每个操作都返回新的 item 对象，不修改入参；item 上的其余字段原样带过去。
 */

export function addStock(item, amount) {
  if (item === null || typeof item !== 'object') {
    throw new TypeError('item 必须是对象')
  }
  if (typeof item.sku !== 'string' || item.sku.trim() === '') {
    throw new TypeError('item.sku 必须是非空字符串')
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError('amount 必须是正整数')
  }
  if (!Number.isInteger(item.qty) || item.qty < 0) {
    throw new RangeError('item.qty 必须是非负整数')
  }
  return { ...item, qty: item.qty + amount }
}

export function removeStock(item, amount) {
  if (item === null || typeof item !== 'object') {
    throw new TypeError('item 必须是对象')
  }
  if (typeof item.sku !== 'string' || item.sku.trim() === '') {
    throw new TypeError('item.sku 必须是非空字符串')
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError('amount 必须是正整数')
  }
  if (!Number.isInteger(item.qty) || item.qty < 0) {
    throw new RangeError('item.qty 必须是非负整数')
  }
  if (amount > item.qty) {
    throw new RangeError(`库存不足：${item.sku} 仅剩 ${item.qty}`)
  }
  return { ...item, qty: item.qty - amount }
}

export function reserveStock(item, amount) {
  if (item === null || typeof item !== 'object') {
    throw new TypeError('item 必须是对象')
  }
  if (typeof item.sku !== 'string' || item.sku.trim() === '') {
    throw new TypeError('item.sku 必须是非空字符串')
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError('amount 必须是正整数')
  }
  if (!Number.isInteger(item.qty) || item.qty < 0) {
    throw new RangeError('item.qty 必须是非负整数')
  }
  const reserved = item.reserved ?? 0
  if (reserved + amount > item.qty) {
    throw new RangeError(`可预留不足：${item.sku} 可用 ${item.qty - reserved}`)
  }
  return { ...item, reserved: reserved + amount }
}
