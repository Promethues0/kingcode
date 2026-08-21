/**
 * 单条账目的规整：把用户给的松散对象变成 { account, cents, note }。
 * 金额统一换算成「分」的整数，避免浮点累加误差；account 去首尾空白且不能为空。
 */

/**
 * @param {{ account?: unknown, amount?: unknown, note?: unknown }} raw
 * @returns {{ account: string, cents: number, note: string }}
 * @throws {TypeError}  raw 不是对象
 * @throws {RangeError} account 为空或 amount 不是有限数
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('entry must be an object')
  }
  const account = String(raw.account ?? '').trim()
  if (account === '') throw new RangeError('entry.account is required')
  const cents = Math.round(Number(raw.amount) * 100)
  if (!Number.isFinite(cents)) throw new RangeError('entry.amount must be a finite number')
  return { account, cents, note: raw.note === undefined || raw.note === null ? '' : String(raw.note) }
}
