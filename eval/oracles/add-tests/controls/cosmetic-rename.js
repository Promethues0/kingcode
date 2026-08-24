// 与夹具原件行为逐用例一致，只换了写法：不带原件那份规格头注释、内部标识符全改名、
// 数字字面量不再用下划线分隔、循环与拼接结构重排、行号全部错位。
// 抛错类型与 message 逐字保持一致，导出集合、函数名与形参个数保持一致。

const SEC = { s: 1, m: 60, h: 3600, d: 86400 }
const BIG_TO_SMALL = ['d', 'h', 'm', 's']
const NEXT_TOKEN = /(\d+)\s*([dhms])\s*/y

function applySign(isNeg, amount) {
  if (!isNeg) return amount
  return amount === 0 ? amount : -amount
}

function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('时长必须是字符串')
  let body = text.trim()
  let isNeg = false
  if (body.startsWith('-')) {
    isNeg = true
    body = body.slice(1).trimStart()
  }
  if (body.length === 0) throw new RangeError('时长不能为空')
  if (/^\d+$/.test(body)) return applySign(isNeg, Number(body))

  const used = new Set()
  const chunks = []
  let cursor = 0
  NEXT_TOKEN.lastIndex = 0
  while (true) {
    const hit = NEXT_TOKEN.exec(body)
    if (hit === null) break
    const unit = hit[2]
    if (used.has(unit)) throw new RangeError(`单位 ${unit} 重复出现：${JSON.stringify(text)}`)
    used.add(unit)
    chunks.push([Number(hit[1]), unit])
    cursor = NEXT_TOKEN.lastIndex
  }
  if (cursor !== body.length) throw new RangeError(`无法解析的时长：${JSON.stringify(text)}`)

  let sum = 0
  for (const [count, unit] of chunks) sum += count * SEC[unit]
  return applySign(isNeg, sum)
}

function formatDuration(seconds) {
  if (!Number.isInteger(seconds)) throw new TypeError('秒数必须是整数')
  if (seconds === 0) return '0s'
  let remain = Math.abs(seconds)
  let out = seconds < 0 ? '-' : ''
  for (const unit of BIG_TO_SMALL) {
    const size = SEC[unit]
    const count = Math.floor(remain / size)
    if (count === 0) continue
    out += `${count}${unit}`
    remain -= count * size
  }
  return out
}

export { parseDuration, formatDuration }
