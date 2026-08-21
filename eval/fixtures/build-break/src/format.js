/**
 * 展示层的格式化小工具：金额（分 → ¥x.xx）与定宽右补空格。
 */

export function formatCurrency(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function padRight(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}
