/**
 * 库存清单的装载与筛选。数据先写死在这里，后续换成读 CSV。
 */

const SEED = [
  { sku: 'A-100', name: 'Keyboard', qty: 12, priceCents: 25900 },
  { sku: 'B-220', name: 'Mouse', qty: 0, priceCents: 8900 },
  { sku: 'C-310', name: 'Monitor', qty: 3, priceCents: 129900 },
  { sku: 'D-415', name: 'Cable', qty: 48, priceCents: 1500 },
]

export function loadInventory() {
  return SEED.map(item => ({ ...item }))
}

/** 库存量不高于阈值的条目（含等于）。 */
export function lowStock(items, threshold = 5) {
  return items.filter(item => item.qty <= threshold
}
