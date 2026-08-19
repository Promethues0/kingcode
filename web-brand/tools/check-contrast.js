#!/usr/bin/env node
/**
 * KingCode 配色守卫：WCAG 对比度 + 红绿色弱可辨性。
 *
 * 调色板直接从 ../client.js 的 `const P = {...}` 块抽取，不重抄一份——
 * 改色只会在一个地方发生，这里永远跟着走。
 *
 * 用法：node web-brand/tools/check-contrast.js（不达标退出码 1）
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 从 client.js 里取出唯一的调色板常量块。 */
function loadPalette() {
  const src = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
  const start = src.indexOf('const P = {')
  if (start < 0) throw new Error('check-contrast: client.js 里找不到 `const P = {` 调色板块')
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('check-contrast: 调色板块括号不配平')
  return new Function(`return ${src.slice(src.indexOf('{', start), end)}`)()
}

const hex = h => { const s = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) }
const lum = ([r, g, b]) => {
  const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Machado 1.0 色觉缺陷模拟矩阵
const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]
const simulate = (h, m) => { const c = hex(h); return m.map(row => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]) }

const toLab = ([r, g, b]) => {
  const f = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [R, G, B] = [f(r), f(g), f(b)]
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  let Y = R * 0.2126 + G * 0.7152 + B * 0.0722
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const k = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  ;[X, Y, Z] = [k(X), k(Y), k(Z)]
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}
const deltaE = (a, b) => {
  const [l1, a1, b1] = toLab(a)
  const [l2, a2, b2] = toLab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

const P = loadPalette()
let failed = 0
const check = (ok, line) => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${line}`) }

console.log('— WCAG 对比度 —')
const pairs = [
  ['亮·正文 ink / surface', P.ink, P.surface, 4.5],
  ['亮·正文 ink / paper', P.ink, P.paper, 4.5],
  ['亮·次级 ink3 / surface', P.ink3, P.surface, 4.5],
  ['亮·三级 muted / paper', P.muted, P.paper, 4.5],
  ['亮·说明 faint / surface', P.faint, P.surface, 3],
  ['亮·纸色字 @ accent 钮', P.surface, P.accent, 4.5],
  ['亮·纸色字 @ ink 主钮', P.surface, P.ink, 4.5],
  // danger 按正文标准（错误信息必须能读）；good/warn 是图标与徽标用色，按 ≥3。
  // 三者同时要过下面的色弱 ΔE≥16——那条比对比度更容易被忽略。
  ['亮·danger / surface', P.danger, P.surface, 4.5],
  ['亮·good / surface', P.good, P.surface, 3],
  ['亮·warn / surface', P.warn, P.surface, 3],
  ['暗·正文 dText / dBase', P.dText, P.dBase, 4.5],
  ['暗·正文 dText / dL3', P.dText, P.dL3, 4.5],
  ['暗·次级 dText2 / dBase', P.dText2, P.dBase, 4.5],
  ['暗·三级 dText3 / dL3', P.dText3, P.dL3, 4.5],
  ['暗·深字 @ dText 主钮', P.dBase, P.dText, 4.5],
  ['暗·accent / dBase', P.dAccent, P.dBase, 4.5],
  ['暗·danger / dBase', P.dDanger, P.dBase, 4.5],
  ['暗·good / dBase', P.dGood, P.dBase, 4.5],
  ['暗·warn / dBase', P.dWarn, P.dBase, 4.5],
]
for (const [label, fg, bg, min] of pairs) {
  const v = contrast(fg, bg)
  check(v >= min, `${v.toFixed(2).padStart(5)} (需 ${min})  ${label}`)
}

// 语义色两两必须在色觉缺陷下仍可分辨；success↔error 是代价最高的一对。
//
// 这里**没有豁免**：整套配色（含亮色）都是本项目选的，就都按同一标准硬校验。
// 早先有过一条「继承自已定板只报 WARN」的豁免，配色换成字节蓝后它就过期了，
// 却仍在把一条 ΔE=2.1 的真失败伪装成提示——豁免比缺陷更危险，已删除。
console.log('\n— 红绿色弱可辨性（Machado 1.0，ΔE 需 ≥ 16）—')
const semantic = [
  ['亮', { danger: P.danger, good: P.good, accent: P.accent, warn: P.warn }],
  ['暗', { danger: P.dDanger, good: P.dGood, accent: P.dAccent, warn: P.dWarn }],
]
for (const [mode, s] of semantic) {
  for (const [x, y] of [['good', 'danger'], ['danger', 'accent'], ['good', 'accent'], ['danger', 'warn']]) {
    for (const [cvd, m] of [['强红弱', PROTAN], ['强绿弱', DEUTAN]]) {
      const v = deltaE(simulate(s[x], m), simulate(s[y], m))
      check(v >= 16, `${v.toFixed(1).padStart(5)} (需 16)  ${mode}·${cvd} ${x}↔${y}`)
    }
  }
}

console.log(`\n${failed === 0 ? '全部达标' : `未达标 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
