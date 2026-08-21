/**
 * 把任意标题变成 URL slug。
 * 约定见 test.js 的验收用例。
 */

export function slugify(text) {
  return String(text)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
