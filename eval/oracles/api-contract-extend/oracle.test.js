/**
 * api-contract-extend 的隐藏判分（agent 看不到这个目录；prepare 只复制 fixtures/）。
 * 跑法：node oracle.test.js <agent 改过的副本目录> <夹具原件目录>
 *
 * 三段，全部零 LLM：
 * ① 旧契约差分：同一批输入，副本的 format(v) 必须与原件的 format(v) 逐字节一致
 *    （包括 NaN/字符串/null 这些走 Number() 的旁路，以及 -0.001 → '-0.00' 这类
 *    现网行为）。期望值不手抄，由原件实现当场算——「默认行为与原来一致」的字面
 *    定义就是这个差分。
 * ② 旧调用方：三个调用方文件被 assertFrozen 钉死，这里再从副本 import 它们
 *    （它们会 import 副本里的 format.js），输出必须等于原件下跑出的输出，并对金样例
 *    （test.js 里那批现网输出的原文）逐字比对——防的是导出名/模块形态被改。
 * ③ 新参数：format(v, { precision: p }) 对照独立参考实现 Intl.NumberFormat
 *    （与原件的 toFixed+正则是两条完全不同的路径）；参考实现先以 p=2 对原件自检，
 *    自检不过直接抛错（判分器自己的病 → harness-error，不算 agent 的）。
 *    输入刻意避开 x.5 这类两种舍入规则会分歧的值——新参数的契约只到「按位数取整」。
 *
 * 任一项 FAIL → 退出码 1。
 */

import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const [, , cwdArg, originArg] = process.argv
if (!cwdArg || !originArg) {
  console.error('用法：node oracle.test.js <cwd> <originDir>')
  process.exit(2)
}
const cwd = resolve(cwdArg)
const origin = resolve(originArg)

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) =>
  check(got === want, label, got === want ? '' : `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)

/** 调用并把「返回值 / 抛错」归一成可比较的字符串。 */
const outcome = (fn, ...args) => {
  try { return { kind: 'return', value: fn(...args) } } catch (e) { return { kind: 'throw', value: e instanceof Error ? e.constructor.name : String(e) } }
}
const same = (a, b) => a.kind === b.kind && a.value === b.value
/** 输入的可读标签：JSON.stringify 会把 -0 打成 0、undefined 打成空，这里补齐。 */
const tag = (v) => Object.is(v, -0) ? '-0' : (JSON.stringify(v) ?? String(v))
const show = (o) => o.kind === 'return' ? JSON.stringify(o.value) : `抛出 ${o.value}`

const load = async (dir, file) => import(pathToFileURL(join(dir, file)).href)

// 副本的 format.js 必须仍以具名导出 format 暴露（调用方就是这么 import 的）
let mine
try {
  mine = await load(cwd, 'format.js')
} catch (e) {
  console.log(`FAIL 副本的 format.js 无法加载：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
check(typeof mine.format === 'function', '副本仍具名导出 format 函数', typeof mine.format)
if (typeof mine.format !== 'function') process.exit(1)
const { format } = mine
const { format: orig } = await load(origin, 'format.js')

// ---- ① 旧契约差分 ----
const LEGACY_INPUTS = [
  0, -0, 1, -1, 0.5, -0.5, 1234.5, -9876543.21, 3.14159, 2.345, 0.1 + 0.2, 1e6, 1e15,
  123456789.987, -0.001, 0.004, 0.005, 99.995, 1899, 4.5, 249.9, -129.99,
  '42', ' 12 ', '1,000', '', 'n/a', 'abc', null, undefined, true, false, NaN, Infinity, -Infinity,
  [], [7], {},
]
for (const v of LEGACY_INPUTS) {
  const want = outcome(orig, v)
  const got = outcome(format, v)
  check(same(got, want), `默认行为 format(${tag(v)})`, same(got, want) ? '' : `原件 ${show(want)}，副本 ${show(got)}`)
}

// ---- ② 旧调用方 ----
const callers = {}
for (const file of ['report.js', 'csv-export.js', 'summary.js']) {
  try {
    callers[file] = { mine: await load(cwd, file), orig: await load(origin, file) }
  } catch (e) {
    check(false, `调用方 ${file} 在副本里可加载`, e instanceof Error ? e.message : String(e))
  }
}
const EXTRA_LINES = [
  { sku: 'Z-1', name: 'Big', qty: 2, price: 1234567.891 },
  { sku: 'Z-2', name: 'Tiny', qty: 5, price: 0.004 },
  { sku: 'Z-3', name: 'Neg', qty: 3, price: -0.5 },
  { sku: 'Z-4', name: 'Str', qty: 1, price: '1,000' },
]
if (callers['report.js']) {
  const { mine: m, orig: o } = callers['report.js']
  eq(m.renderReport(), o.renderReport(), 'report.js：默认数据输出与原件一致')
  eq(m.renderReport(EXTRA_LINES), o.renderReport(EXTRA_LINES), 'report.js：额外数据输出与原件一致')
  eq(m.renderReport(), [
    'Keyboard        249.90        749.70',
    'Monitor       1,899.00      1,899.00',
    'Cable             4.50         54.00',
    'Refund         -129.99       -129.99',
    'Unknown              —             —',
    '------------------------------------',
    'TOTAL                       2,572.71',
  ].join('\n'), 'report.js：金样例原文')
}
if (callers['csv-export.js']) {
  const { mine: m, orig: o } = callers['csv-export.js']
  eq(m.toCsv(), o.toCsv(), 'csv-export.js：默认数据输出与原件一致')
  eq(m.toCsv(EXTRA_LINES), o.toCsv(EXTRA_LINES), 'csv-export.js：额外数据输出与原件一致')
  eq(m.toCsv(), [
    'sku,qty,price,amount',
    'A-100,3,"249.90","749.70"',
    'B-220,1,"1,899.00","1,899.00"',
    'C-007,12,"4.50","54.00"',
    'R-001,1,"-129.99","-129.99"',
    'X-000,2,"—","—"',
  ].join('\n'), 'csv-export.js：金样例原文')
}
if (callers['summary.js']) {
  const { mine: m, orig: o } = callers['summary.js']
  eq(m.summarize(), o.summarize(), 'summary.js：默认数据输出与原件一致')
  // map(format) 会把下标当第二个参数传进去——下标 0/1/2/3… 不得被当成 options 解释
  const many = [1, 2.5, 1000, 0.004, -0.5, '1,000', 7, 8, 9, 10, 11, 12]
  eq(m.summarize(many), o.summarize(many), 'summary.js：map(format) 传入下标时输出与原件一致')
  eq(m.summarize([1, 2.5, 1000]), '1.00 | 2.50 | 1,000.00', 'summary.js：金样例原文')
  eq(m.renderRow([0.5, 1234.5], format), o.renderRow([0.5, 1234.5], orig), 'summary.js：format 作为参数传给渲染器')
}

// ---- ③ 新参数 precision ----
/** 独立参考实现：Intl 千分位 + 固定小数位。与原件的 toFixed+正则路径无关。 */
const ref = (value, p) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: p, maximumFractionDigits: p, useGrouping: true }).format(n)
}
// 避开 x.5 类半值（toFixed 与 Intl 舍入规则可能分歧），避开会舍成 -0 的负数
const PRECISION_INPUTS = [0, 1, 42, 0.1, 1234.5678, -1234.5678, 999.999, 7.125, 1e6, 123456789.987, '2500', '1234.5678']
// 参考实现自检：p=2 必须与原件逐字一致，否则是判分器自己的病
for (const v of PRECISION_INPUTS) {
  if (ref(v, 2) !== orig(v)) throw new Error(`判分器参考实现与原件在 p=2 不一致：${JSON.stringify(v)} 参考 ${ref(v, 2)} 原件 ${orig(v)}`)
}
// 参考实现的几个字面校验（金样例，防 Intl 环境差异）
for (const [v, p, want] of [[1234.5678, 0, '1,235'], [1234.5678, 3, '1,234.568'], [999.999, 0, '1,000'], [0.1, 4, '0.1000']]) {
  if (ref(v, p) !== want) throw new Error(`判分器参考实现字面自检失败：ref(${v}, ${p}) = ${ref(v, p)}，期望 ${want}`)
}

for (const p of [0, 1, 3, 4]) {
  for (const v of PRECISION_INPUTS) {
    const want = ref(v, p)
    const got = outcome(format, v, { precision: p })
    check(got.kind === 'return' && got.value === want, `precision=${p}：format(${tag(v)})`, got.kind === 'return' && got.value === want ? '' : `期望 ${JSON.stringify(want)} 实得 ${show(got)}`)
  }
  // 非有限数在任何位数下照旧显示破折号
  for (const v of [NaN, Infinity, 'n/a']) {
    const got = outcome(format, v, { precision: p })
    check(got.kind === 'return' && got.value === '—', `precision=${p}：非有限数 ${String(v)} 仍为破折号`, show(got))
  }
}
// 显式传 2 / 传空对象 / 传 undefined 三种写法都等于默认行为
for (const v of [1234.5678, -0.001, 0, '42', 'n/a']) {
  const want = outcome(orig, v)
  for (const [label, opts] of [['{ precision: 2 }', { precision: 2 }], ['{}', {}], ['undefined', undefined]]) {
    const got = outcome(format, v, opts)
    check(same(got, want), `options=${label} 等于默认行为：format(${tag(v)})`, same(got, want) ? '' : `原件 ${show(want)}，副本 ${show(got)}`)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
