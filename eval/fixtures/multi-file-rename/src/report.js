/**
 * 汇总报表：把一批原始账目按账户合计。
 */

import { normalizeEntry } from './entry.js'

/**
 * 按账户名字典序返回 { 账户: 合计分 }。
 * 每条先过 normalizeEntry，所以不合法的条目会在这里直接抛错，而不是被静默跳过。
 */
export function summarize(raws) {
  const totals = new Map()
  for (const raw of raws) {
    const entry = normalizeEntry(raw)
    totals.set(entry.account, (totals.get(entry.account) ?? 0) + entry.cents)
  }
  return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)))
}
