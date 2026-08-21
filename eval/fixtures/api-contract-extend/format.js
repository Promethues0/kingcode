/**
 * 金额/数量的展示格式：千分位逗号 + 固定两位小数。
 * 非有限数（NaN、Infinity、转不成数字的输入）一律显示为「—」。
 *
 *   format(1234.5)   → '1,234.50'
 *   format(-0.5)     → '-0.50'
 *   format('abc')    → '—'
 */

export function format(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const [int, frac] = Math.abs(n).toFixed(2).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (n < 0 ? '-' : '') + grouped + '.' + frac
}
