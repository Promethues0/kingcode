/**
 * 时长字符串 ⇄ 秒数。零依赖纯函数，无 I/O。
 *
 * parseDuration(text) → 秒数（整数）
 *   - 单位：d（天）h（时）m（分）s（秒），小写；可任选、可组合、顺序不限，
 *     但每个单位最多出现一次（"1h1h" 是错误）
 *   - 数字只接受非负整数（不支持小数、不支持千分位）
 *   - 数字与单位之间、单位与单位之间允许空白；首尾空白忽略
 *   - 裸数字（整串不带单位）按秒解释："90" → 90
 *   - 可带一个前导 "-" 表示负时长："-5m" → -300
 *   - 空串 / 只有空白 / 无法完整解析的输入抛 RangeError；入参不是字符串抛 TypeError
 *
 * formatDuration(seconds) → 规范写法的字符串
 *   - 按 d、h、m、s 从大到小拼接，值为 0 的单位省略：5415 → "1h30m15s"
 *   - 0 → "0s"；负数带前导 "-"：-300 → "-5m"
 *   - 入参必须是整数（Number.isInteger），否则抛 TypeError
 *
 * 对规范写法，formatDuration(parseDuration(x)) === x。
 */

const UNIT_SECONDS = { d: 86_400, h: 3_600, m: 60, s: 1 }
const UNITS_DESC = ['d', 'h', 'm', 's']
const TOKEN = /(\d+)\s*([dhms])\s*/y

/** 负时长取负；总量为 0 时不产生 -0。 */
const signed = (negative, total) => (negative && total !== 0 ? -total : total)

export function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('时长必须是字符串')
  let rest = text.trim()
  let negative = false
  if (rest.startsWith('-')) {
    negative = true
    rest = rest.slice(1).trimStart()
  }
  if (rest === '') throw new RangeError('时长不能为空')
  if (/^\d+$/.test(rest)) return signed(negative, Number(rest))

  const seen = new Set()
  let total = 0
  let pos = 0
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(rest); m !== null; m = TOKEN.exec(rest)) {
    const [, digits, unit] = m
    if (seen.has(unit)) throw new RangeError(`单位 ${unit} 重复出现：${JSON.stringify(text)}`)
    seen.add(unit)
    total += Number(digits) * UNIT_SECONDS[unit]
    pos = TOKEN.lastIndex
  }
  if (pos < rest.length - 1) throw new RangeError(`无法解析的时长：${JSON.stringify(text)}`)
  return signed(negative, total)
}

export function formatDuration(seconds) {
  if (!Number.isInteger(seconds)) throw new TypeError('秒数必须是整数')
  if (seconds === 0) return '0s'
  const sign = seconds < 0 ? '-' : ''
  let rest = Math.abs(seconds)
  const parts = []
  for (const unit of UNITS_DESC) {
    const n = Math.floor(rest / UNIT_SECONDS[unit])
    if (n > 0) {
      parts.push(`${n}${unit}`)
      rest -= n * UNIT_SECONDS[unit]
    }
  }
  return sign + parts.join('')
}
