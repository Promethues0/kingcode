/**
 * 密码机批：数据不变量 + 引擎金样例 + 工具无头。
 * 跑法：node test/test-hsm.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeCode, diagnose, findApi, findDefects, assertRepro } from '../presets/hsm-dev/lib/hsm.js'
import * as plugin from '../presets/hsm-dev/hsm-tools.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
const load = name => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../presets/hsm-dev/data/${name}`, import.meta.url)), 'utf8'))

// ── 错误码规范化（引擎金样例，不依赖数据）──────────────────────────────────
eq(normalizeCode('0x01050019').hex, '0x01050019', 'normalize：带 0x 前缀')
eq(normalizeCode('01050019').hex, '0x01050019', 'normalize：不带前缀')
eq(normalizeCode('0X01050019').hex, '0x01050019', 'normalize：大写 0X')
eq(normalizeCode(0x01050019).hex, '0x01050019', 'normalize：数字入参')
eq(normalizeCode('2').hex, '0x00000002', 'normalize：短码补零')
check((() => { try { normalizeCode('') } catch { return true } return false })(), 'normalize：空值报错')
check((() => { try { normalizeCode('不是码') } catch { return true } return false })(), 'normalize：非法写法报错')

// ── 数据不变量 ──────────────────────────────────────────────────────────────
{
  const api = load('hsm-api.json')
  const fns = (api.groups ?? []).flatMap(g => g.functions ?? [])
  // KB1 头部声称 229 个声明，但速查表只逐条列出 203 个——转换器如实记两个数，
  // 没有为凑数发明 26 条。测试守的是这个诚实性，不是那个宣称值。
  check(fns.length === api.counts.total, '枚举条目数与 counts.total 自洽', `${fns.length} vs ${api.counts.total}`)
  check(api.counts.source_claimed_total === 229, 'counts 记录源文宣称的 229')
  check(api.counts.total + api.counts.unenumerated_in_source === 229, '枚举数 + 未逐条列出数 = 宣称数',
    `${api.counts.total}+${api.counts.unenumerated_in_source}`)
  const badStatus = fns.filter(f => f.status !== null && !['sample', 'declared', 'stub'].includes(f.status))
  check(badStatus.length === 0, '状态枚举合法（sample/declared/stub/null）', badStatus.slice(0, 3).map(f => `${f.name}:${f.status}`).join(';'))
  const stubs = fns.filter(f => f.status === 'stub')
  check(stubs.length === 18, `KB1 速查表标 🔴 的空桩 18 个`, `实得 ${stubs.length}`)
  check(stubs.some(f => /PQC_Sign/i.test(f.name)), 'PQC_Sign 标为空桩（README 首条举例）')
  check((api.preflight ?? []).length === 5, '开篇五件事', `实得 ${(api.preflight ?? []).length}`)
  const dupes = fns.map(f => f.name).filter((n, i, a) => a.indexOf(n) !== i)
  check(dupes.length === 0, '函数名不重复（重复声明只收一条）', dupes.slice(0, 3).join(';'))
}
{
  const ec = load('hsm-errcode.json')
  check((ec.segments ?? []).length >= 6, '错误码段位 ≥6 段', `实得 ${(ec.segments ?? []).length}`)
  check((ec.codes ?? []).length >= 30, '错误码条目 ≥30', `实得 ${(ec.codes ?? []).length}`)
  check((ec.java_doc_conflicts ?? []).length === 9, 'Java 文档冲突码 9 个', `实得 ${(ec.java_doc_conflicts ?? []).length}`)
  check(ec.print_rule === '%x', '打印规则 %x')
  const badHex = (ec.codes ?? []).filter(c => !/^0x[0-9A-Fa-f]{1,8}$/.test(String(c.code_hex)))
  check(badHex.length === 0, '错误码格式合法', badHex.slice(0, 3).map(c => c.code_hex).join(';'))
}
{
  const st = load('hsm-struct.json')
  check((st.sections ?? []).length >= 5, '结构体知识小节 ≥5', `实得 ${(st.sections ?? []).length}`)
  const sm2 = (st.sections ?? []).find(s => /32\s*字节|右对齐|后半段/.test(`${s.title}${s.body_summary}`))
  check(sm2 !== undefined, '含 SM2 32 字节右对齐小节（最高频故障）')
}
{
  const df = load('hsm-defects.json')
  check((df.defects ?? []).length >= 5, '实测缺陷 ≥5 条', `实得 ${(df.defects ?? []).length}`)
  const noRepro = (df.defects ?? []).filter(d => !d.repro || String(d.repro).trim() === '')
  check(noRepro.length === 0, '**每条缺陷都带复现命令**（KB6 硬规则）', noRepro.map(d => d.id).join(';'))
  check(typeof df.citation_rule === 'string' && df.citation_rule.length > 0, '带引用规则声明')
  check((df.artifacts ?? []).length >= 4, '被校验实物 ≥4 项')
}
for (const name of ['hsm-api.json', 'hsm-errcode.json', 'hsm-struct.json', 'hsm-defects.json']) {
  check(typeof load(name)._meta?.source === 'string', `${name} 带 _meta.source`)
}

// ── 分诊金样例（源文点名的易混对）────────────────────────────────────────────
{
  const ec = load('hsm-errcode.json')
  const a = diagnose('0x01050019', ec)
  const b = diagnose('0x01000019', ec)
  check(a.prefix !== b.prefix, '易混对落在不同段位（0x0105 vs 0x0100）', `${a.prefix} vs ${b.prefix}`)
  check(a.segment !== null, '0x01050019 命中段位', JSON.stringify(a.segment?.domain))
  check(a.confusable.some(c => normalizeCode(c.code_hex).value === 0x01000019)
    || b.confusable.some(c => normalizeCode(c.code_hex).value === 0x01050019),
    '互为易混码被报出')
  const unknown = diagnose('0x01049999', ec)
  check(unknown.code === undefined || unknown.code === null, '未收录码不编造条目')
  check(unknown.guidance.length > 0, '未收录码仍给段位方向')
}

// ── 工具无头 ────────────────────────────────────────────────────────────────
{
  const tools = new Map()
  plugin.apply({ effect: fn => fn(), tools: { register: def => tools.set(def.name, def) } })
  check(tools.size === 4, '注册 4 个工具', [...tools.keys()].join(','))
  for (const n of ['hsm_diagnose', 'hsm_kb_api', 'hsm_kb_struct', 'hsm_kb_defect']) {
    check(tools.has(n), `含 ${n}`)
  }

  const d = await tools.get('hsm_diagnose').execute({ code: '0x01050019' })
  check(d.hex === '0x01050019' && d.segment !== null, 'diagnose 工具：段位命中')

  const stubs = await tools.get('hsm_kb_api').execute({ status: 'stub' })
  check(stubs.matches.length === 18, 'kb_api：按 stub 筛选得 18 条（KB1 口径）')
  const overview = await tools.get('hsm_kb_api').execute({})
  check((overview.groups ?? []).length > 0 && (overview.preflight ?? []).length === 5, 'kb_api：空参返回概览与五件事')
  check((overview.stubsFromDefectList ?? []).length === 22,
    'kb_api：概览带 KB6 实测空桩全集 22 个（21 + 1 个仅 ARM64）', `实得 ${(overview.stubsFromDefectList ?? []).length}`)
  // 跨 KB 合并：KB6 独有的空桩即便 KB1 没标 🔴 也要在命中里点出来
  const kb6Only = (overview.stubsFromDefectList ?? []).filter(n => !stubs.matches.some(f => f.name === n))
  check(kb6Only.length > 0, 'KB6 确实含 KB1 未标的空桩（合并才不漏）', kb6Only.join(','))
  const probe = await tools.get('hsm_kb_api').execute({ query: kb6Only[0] })
  check(probe.stubHits.includes(kb6Only[0]) || probe.matches.length === 0,
    `KB6 独有空桩 ${kb6Only[0]} 被合并标出（或该函数不在 KB1 枚举内）`,
    `matches=${probe.matches.length} stubHits=${JSON.stringify(probe.stubHits)}`)

  const st = await tools.get('hsm_kb_struct').execute({ query: 'SM2' })
  check(st.sections.length > 0, 'kb_struct：SM2 有命中')

  const df = await tools.get('hsm_kb_defect').execute({ query: '空桩' })
  check(df.matches.length > 0, 'kb_defect：空桩有命中')
  check(df.matches.every(m => m.repro && m.repro.trim().length > 0), 'kb_defect：返回项全带复现命令')
  check(typeof df.citationRule === 'string', 'kb_defect：带引用规则')
}

// ── assertRepro 守卫 ────────────────────────────────────────────────────────
check((() => { try { assertRepro([{ id: 'X', repro: '' }]) } catch { return true } return false })(),
  'assertRepro：缺复现命令时拒绝引用')
check(assertRepro([{ id: 'Y', repro: 'cc -fsyntax-only t.c' }]) === true, 'assertRepro：合规通过')

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
