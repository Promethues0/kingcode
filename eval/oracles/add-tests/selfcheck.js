/**
 * 变异体自检（任务作者用，不进 eval 主流程）：
 *   node eval/oracles/add-tests/selfcheck.js
 *
 * 三件事：
 * ① 磁盘上的变异体 = 原件 + 规格（loadMutants 已比对，漂移直接抛）；
 * ② 每个变异体在它的 killer 用例上行为**确实**与原件不同（否则是等价变异体，杀不死也不该算）；
 * ③ 每个变异体在一组公共用例上与原件**完全一致**——保证每个变异体只带一个 bug，
 *    不会因为顺手弄坏别的路径而被无关用例「误杀」。
 * ④ 变异体文件不带文本指纹：没有头注释、不提「变异体/mutant」、与原件恰好只差一处
 *    （按行 diff 的差异行数不超过 2）——读源码断言的作弊没有现成把手可抓。
 * 期望值全部由原件现算，不手抄常量。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
