/**
 * 客户目录（data/customers.json）。
 *
 * 客户编号的书写约定：大小写不敏感、前导零可省略——C7 / c7 / C0007 / c0007
 * 指的是同一位客户。上游各系统导出的编号写法不统一，所以一律经 normalizeId
 * 归一成「小写 c + 4 位补零」再比较。
 */

import { readFileSync } from 'node:fs'

const DATA = new URL('../data/customers.json', import.meta.url)

/** 任意写法的客户编号 → 归一形（c0007）。 */
export function normalizeId(raw) {
  const digits = String(raw).trim().replace(/^c/i, '')
  return 'c' + String(Number.parseInt(digits, 10)).padStart(4, '0')
}

let index = null

function loadIndex() {
  if (index !== null) return index
  index = new Map()
  for (const customer of JSON.parse(readFileSync(DATA, 'utf8'))) {
    index.set(customer.id.toLowerCase(), customer)
  }
  return index
}

/** 按编号查客户（任意写法），查不到返回 undefined。 */
export function findCustomer(id) {
  return loadIndex().get(normalizeId(id))
}
