// 与夹具原件行为逐用例一致，但实现换了一套：token 不再用粘性正则，改成手写字符扫描；
// 错误信息用字符串拼接而不是模板串；格式化用 while + 累加而不是 for-of + join。
// 抛错类型与 message 逐字保持一致，导出集合、函数名与形参个数保持一致。
//
// 手写扫描与原正则 /(\d+)\s*([dhms])\s*/y 等价的理由：\d+ 后面跟的 \s* 与 [dhms] 都
// 匹配不到数字，[dhms] 也匹配不到空白，所以整条 token 不存在任何可回溯的分歧点，
// 贪婪扫一遍即是唯一匹配。空白判定沿用 \s（同一套 Unicode 语义），数字判定沿用 [0-9]。

const SPACE = /\s/
const SECONDS_OF = new Map([['d', 86400], ['h', 3600], ['m', 60], ['s', 1]])
const DESCENDING = Array.from(SECONDS_OF.keys())

const digitAt = (str, i) => str[i] >= '0' && str[i] <= '9'

const allDigits = (str) => {
  if (str.length === 0) return false
  for (let i = 0; i < str.length; i += 1) if (!digitAt(str, i)) return false
  return true
}

const skipSpace = (str, from) => {
  let i = from
  while (i < str.length && SPACE.test(str[i])) i += 1
  return i
}

// 从 start 处读一个「数字 空白* 单位 空白*」；读不到返回 null。
function readToken(str, start) {
  let i = start
  while (i < str.length && digitAt(str, i)) i += 1
  if (i === start) return null
  const digits = str.slice(start, i)
  i = skipSpace(str, i)
  if (i >= str.length || !SECONDS_OF.has(str[i])) return null
  const unit = str[i]
  return { digits, unit, after: skipSpace(str, i + 1) }
}

function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('时长必须是字符串')
  const trimmed = text.trim()
  const minus = trimmed.charAt(0) === '-'
  const body = minus ? trimmed.slice(1).trimStart() : trimmed
  if (body === '') throw new RangeError('时长不能为空')

  let amount = 0
  if (allDigits(body)) {
    amount = Number(body)
  } else {
    const taken = []
    let at = 0
    for (let token = readToken(body, at); token !== null; token = readToken(body, at)) {
      if (taken.includes(token.unit)) {
        throw new RangeError('单位 ' + token.unit + ' 重复出现：' + JSON.stringify(text))
      }
      taken.push(token.unit)
      amount += Number(token.digits) * SECONDS_OF.get(token.unit)
      at = token.after
    }
    if (at !== body.length) throw new RangeError('无法解析的时长：' + JSON.stringify(text))
  }
  if (minus && amount !== 0) return 0 - amount
  return amount
}

function formatDuration(seconds) {
  if (!Number.isInteger(seconds)) throw new TypeError('秒数必须是整数')
  if (seconds === 0) return '0s'
  let left = Math.abs(seconds)
  let text = ''
  let idx = 0
  while (idx < DESCENDING.length) {
    const unit = DESCENDING[idx]
    const width = SECONDS_OF.get(unit)
    const many = Math.floor(left / width)
    if (many > 0) {
      text = text + String(many) + unit
      left = left - many * width
    }
    idx += 1
  }
  return (seconds < 0 ? '-' : '') + text
}

export { parseDuration, formatDuration }
