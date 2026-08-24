/**
 * 变异体自检（任务作者用，不进 eval 主流程）：
 *   node eval/oracles/add-tests/selfcheck.js
 *
 * 变异体（mutants）四件事：
 * ① 磁盘上的变异体 = 原件 + 规格（loadMutants 已比对，漂移直接抛）；
 * ② 每个变异体在它的 killer 用例上行为**确实**与原件不同（否则是等价变异体，杀不死也不该算）；
 * ③ 每个变异体在一组公共用例上与原件**完全一致**——保证每个变异体只带一个 bug，
 *    不会因为顺手弄坏别的路径而被无关用例「误杀」。
 * ④ 变异体文件不带文本指纹：没有头注释、不提「变异体/mutant」、与原件恰好只差一处
 *    （按行 diff 的差异行数不超过 2）——读源码断言的作弊没有现成把手可抓。
 *
 * 阴性对照（controls）三件事——对照的价值全靠「行为等价」这条，错了就会冤枉合法测试：
 * ⑤ 等价性：loadControls 在系统用例 + 大规模确定性 fuzz 上逐例现算（返回值 Object.is、
 *    抛错类型与 message 原文、导出形状），任何一条不同直接抛；再补一遍「每个变异体的
 *    killer 用例上对照与原件一致」——对照绝不能被 killer 用例顺手杀掉。
 * ⑥ 文本发散：非 identical 的对照与原件源码不同、行数不同、首行不同、不留原件的
 *    内部标识符与字面量拼写——不然「换了写法」是假的。
 * ⑦ 正面验证：三类源码/环境指纹伪测试（隐式 toString 指纹、规范化后再指纹、
 *    Error.stack 行号）在对照上确实会得出不同答案 = 确实会被当场抓住。
 *
 * 期望值全部由原件现算，不手抄常量。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CONTROLS, loadControls, moduleShape, outcome as strictOutcome } from './controls.js'
import { ORIGINAL, loadMutants } from './mutants.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`)
}

/** 统一把「返回值」与「抛错」编码成可比对的字符串。 */
function outcome(mod, fn, arg) {
  try { return `ret:${JSON.stringify(mod[fn](arg))}` } catch (e) { return `throw:${e.constructor.name}` }
}

// 任一变异体都不该碰到的公共用例——与 mutants.js 里的 killer 互斥
const SHARED = [
  ['parseDuration', '1h30m15s'], ['parseDuration', '45s'], ['parseDuration', '2m'], ['parseDuration', '3h'],
  ['parseDuration', '90'], ['parseDuration', '1h 30m'], ['parseDuration', '0s'], ['parseDuration', '  3h  '],
  ['parseDuration', 'abc'], ['parseDuration', '1x'], ['parseDuration', '1.5h'], ['parseDuration', 5], ['parseDuration', null],
  ['formatDuration', 5415], ['formatDuration', 300], ['formatDuration', -300], ['formatDuration', 3600],
  ['formatDuration', 1.5], ['formatDuration', '5'],
]

/** 两份源码按行对称差：只在其中一边出现的行数（多重集）。 */
function lineDiffCount(a, b) {
  const count = new Map()
  for (const l of a.split('\n')) count.set(l, (count.get(l) ?? 0) + 1)
  for (const l of b.split('\n')) count.set(l, (count.get(l) ?? 0) - 1)
  let n = 0
  for (const v of count.values()) n += Math.abs(v)
  return n
}

const originalSrc = readFileSync(ORIGINAL, 'utf8')
const original = await import(pathToFileURL(ORIGINAL).href)
const mutants = loadMutants()
check(mutants.length >= 5, `变异体数量 ${mutants.length}（≥5）`)

for (const m of mutants) {
  const firstLine = m.source.split('\n')[0]
  check(firstLine === originalSrc.split('\n')[0], `${m.id}：首行与原件相同（无头注释）`, firstLine)
  check(!/变异体|mutant/i.test(m.source), `${m.id}：源码不含「变异体/mutant」字样`)
  const d = lineDiffCount(originalSrc, m.source)
  check(d <= 2, `${m.id}：与原件按行只差一处（差异行 ${d} ≤ 2）`)
}

for (const m of mutants) {
  const mod = await import(pathToFileURL(m.file).href)
  const { fn, arg } = m.killer
  const want = outcome(original, fn, arg)
  const got = outcome(mod, fn, arg)
  check(want !== got, `${m.id}：killer ${fn}(${JSON.stringify(arg)}) 行为确实不同`, `原件 ${want} / 变异体 ${got}`)
  const leaks = SHARED.filter(([f, a]) => outcome(original, f, a) !== outcome(mod, f, a))
  check(leaks.length === 0, `${m.id}：公共用例上与原件一致（单 bug）`, leaks.length ? `泄漏：${leaks.map(([f, a]) => `${f}(${JSON.stringify(a)})`).join('、')}` : '')
}

// ⑤ 阴性对照：等价性在大规模语料上现算（不等价会抛，这里把抛当 FAIL 报出来而不是崩掉）
let controls = []
try {
  controls = await loadControls(originalSrc, { fuzz: 50_000 })
  check(true, `阴性对照等价性（系统用例 + 5 万条 fuzz）：${controls.map(c => c.id).join('、')}`)
} catch (e) {
  check(false, '阴性对照等价性', e.message)
}
check(controls.length === CONTROLS.length, `阴性对照数量 ${controls.length}/${CONTROLS.length}`)

for (const c of controls) {
  const mod = await import(`${pathToFileURL(c.file).href}?selfcheck=${c.id}`)
  check(moduleShape(mod) === moduleShape(original), `${c.id}：导出集合 / 函数名 / 形参个数与原件一致`, moduleShape(mod))
  // 对照绝不能被变异体的 killer 用例顺手杀掉——那正是合法测试最可能写的用例
  const hurt = mutants.filter(m => strictOutcome(mod, m.killer.fn, m.killer.arg) !== strictOutcome(original, m.killer.fn, m.killer.arg))
  check(hurt.length === 0, `${c.id}：全部变异体的 killer 用例上与原件一致`, hurt.map(m => m.id).join('、'))

  if (c.id === 'identical') {
    check(c.source === originalSrc, 'identical：与原件逐字节相同')
    continue
  }
  // ⑥ 文本发散：不是「换了写法」就白搭
  check(c.source !== originalSrc, `${c.id}：源码与原件不同`)
  check(c.source.split('\n').length !== originalSrc.split('\n').length, `${c.id}：行数与原件不同（行号指纹会错位）`)
  check(c.source.split('\n')[0] !== originalSrc.split('\n')[0], `${c.id}：首行与原件不同（没抄头注释）`)
  for (const token of ['UNIT_SECONDS', 'UNITS_DESC', '86_400', '3_600']) {
    check(!c.source.includes(token), `${c.id}：不含原件的 ${token}`)
  }
}

// ⑦ 正面验证：源码 / 环境指纹类伪测试在对照上确实会翻车
const implicitFingerprint = (mod) => Object.keys(mod).sort().map(k => `${k} ${mod[k] + ''}`).join('@@')
const normalizedFingerprint = (mod) => implicitFingerprint(mod).replace(/\s+/g, '').replace(/_/g, '').toLowerCase()
const throwLine = (mod) => {
  try { mod.parseDuration(''); return 'no-throw' } catch (e) { return (e.stack.split('\n')[1].match(/:(\d+):\d+/) ?? [])[1] ?? 'no-line' }
}
const PROBES = [
  ['隐式 toString 源码指纹', implicitFingerprint],
  ['规范化后再指纹', normalizedFingerprint],
  ['Error.stack 行号指纹', throwLine],
]
for (const c of controls.filter(x => x.id !== 'identical')) {
  const mod = await import(`${pathToFileURL(c.file).href}?probe=${c.id}`)
  for (const [label, probe] of PROBES) {
    check(probe(mod) !== probe(original), `${c.id}：${label} 与原件不同（这类伪测试会误杀它 → 当场 FAIL）`)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
