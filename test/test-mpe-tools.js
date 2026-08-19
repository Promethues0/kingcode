/**
 * mpe-tools 插件无头测试：假 ctx 收 register，直接驱动 execute。
 * 依赖 data/ 生成物（KB 转换完成后才能全绿）与 fixtures/mpe-evidence-sample.json。
 * 跑法：node test/test-mpe-tools.js
 */

import { fileURLToPath } from 'node:url'
import * as plugin from '../presets/mpe-assess/mpe-tools.js'
import * as remediatePlugin from '../presets/mpe-assess/mpe-remediate-tools.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}

const tools = new Map()
const fakeCtx = {
  effect: fn => fn(),
  tools: { register: def => { tools.set(def.name, def) } },
}
plugin.apply(fakeCtx)
remediatePlugin.apply(fakeCtx)

check(tools.size === 10, '注册 10 个工具', `实得 ${tools.size}: ${[...tools.keys()].join(',')}`)
for (const name of ['mpe_kb_indicator', 'mpe_kb_high_risk', 'mpe_kb_faq', 'mpe_evidence_load', 'mpe_judge', 'mpe_score',
                    'mpe_diff', 'mpe_ledger', 'mpe_remediate', 'mpe_kb_plan']) {
  check(tools.has(name), `含 ${name}`)
}

const FIXTURE = fileURLToPath(new URL('./fixtures/mpe-evidence-sample.json', import.meta.url))

// ── mpe_evidence_load ───────────────────────────────────────────────────────
{
  const r = await tools.get('mpe_evidence_load').execute({ path: FIXTURE })
  check(r.kind === 'detail', 'load：识别为明细包')
  check(r.problems.length === 0, 'load：样例包无校验问题', JSON.stringify(r.problems))
  check(r.coverage.findingsTotal === 5, 'load：5 条证据', `实得 ${r.coverage.findingsTotal}`)
  check(r.coverage.judgeable === 3 && r.coverage.needConfirm === 1 && r.coverage.untested === 1,
    'load：可判3/待确认1/未测评1', JSON.stringify(r.coverage.byStrength))
  check(r.coverage.highRiskCount === 1, 'load：高风险 1 条')
}

// ── mpe_judge ───────────────────────────────────────────────────────────────
{
  const r = await tools.get('mpe_judge').execute({ path: FIXTURE })
  check(r.untested.length === 1 && r.untested[0].id === 'E0003', 'judge：no_permission 进未测评')
  check(r.confirms.length === 1 && r.confirms[0].id === 'E0004', 'judge：indirect 进待确认')
  const e2 = r.judgments.find(j => j.id === 'E0002')
  check(e2?.draft.a === false, 'judge：TLS1.0 黑名单命中 → A=false')
  const e5 = r.judgments.find(j => j.id === 'E0005')
  check(e5?.draft.a === false, 'judge：SHA-1/RSA1024 命中 → A=false')
  const e1 = r.judgments.find(j => j.id === 'E0001')
  check(e1?.draft.a === null, 'judge：合规算法不误判（aes256-ctr 留 null）', JSON.stringify(e1?.rationale))
  check(r.highRisk.hits.length === 1 && r.highRisk.hits[0].code === '5.2', 'judge：高风险 5.2 确定命中')
  check(r.highRisk.hits[0].mitigable === false, 'judge：5.2 关联 KB 得 mitigable=false（死条款）')
}

// ── mpe_kb_indicator ────────────────────────────────────────────────────────
{
  const r = await tools.get('mpe_kb_indicator').execute({ query: '真实性', level: 3 })
  check(Array.isArray(r.matches), 'kb_indicator：返回 matches 数组')
  const r2 = await tools.get('mpe_kb_indicator').execute({ query: '身份鉴别', level: 3 })
  check(r2.matches.length > 0, 'kb_indicator：模糊「身份鉴别」有命中', `实得 ${r2.matches.length}`)
  const withLevel = r2.matches.find(m => m.atLevel?.modal)
  check(withLevel !== undefined, 'kb_indicator：三级要求带助动词', JSON.stringify(withLevel?.atLevel))
}

// ── mpe_kb_high_risk ────────────────────────────────────────────────────────
{
  const all = await tools.get('mpe_kb_high_risk').execute({})
  check(all.items.length === 16, 'kb_high_risk：16 项', `实得 ${all.items.length}`)
  check(all.noMitigationCodes.length === 8, 'kb_high_risk：8 条死条款', JSON.stringify(all.noMitigationCodes))
  const one = await tools.get('mpe_kb_high_risk').execute({ code: '9.3' })
  check(one.item !== null && one.item.mitigable === false, 'kb_high_risk：9.3 无缓解')
}

// ── mpe_kb_faq ──────────────────────────────────────────────────────────────
{
  const r = await tools.get('mpe_kb_faq').execute({ query: '整改期限' })
  check(r.noAnswerHits.length > 0 || r.matches.length > 0, 'kb_faq：整改期限命中无答案清单或FAQ', JSON.stringify(r.noAnswerHits))
}

// ── mpe_score（端到端：查权重→算分→veto）───────────────────────────────────
{
  const r = await tools.get('mpe_score').execute({
    level: 3,
    items: [
      { indicator: '通信过程中重要数据的机密性', layer: '网络和通信安全', status: 'applicable', objects: [{ d: true, a: false, k: true }] },
      { indicator: '重要数据存储机密性', layer: '应用和数据安全', status: 'untested' },
    ],
    highRisk: [{ code: '5.2', mitigated: false }],
  })
  check(r.conclusion.verdict === '不符合', 'score：未缓解 5.2 一票否决', r.conclusion.reason)
  check(r.anyUntested === true && r.totalMin < r.totalMax, 'score：未测评出上下界', `[${r.totalMin},${r.totalMax}]`)
}
{
  // 权重查不到时响亮报错而不是静默算错
  let threw = false
  try {
    await tools.get('mpe_score').execute({
      level: 3,
      items: [{ indicator: '不存在的指标名', layer: '网络和通信安全', status: 'applicable', objects: [{ d: true, a: true, k: true }] }],
    })
  } catch (error) {
    threw = /查不到/.test(error.message)
  }
  check(threw, 'score：未知指标权重响亮报错')
}

// ── 密改四工具端到端 ────────────────────────────────────────────────────────
{
  const r = await tools.get('mpe_kb_plan').execute({ section: 'lint' })
  check(r.checklist.length === 15, 'kb_plan：15 条自检')
  const r2 = await tools.get('mpe_remediate').execute({
    gaps: [
      { indicator: '高风险项', layer: '网络和通信安全', isHighRisk: true },
      { indicator: '制度修订', layer: '管理制度', kind: 'mgmt' },
    ],
    measureQuery: '明文存储',
  })
  check(r2.batches[0].items[0].indicator === '高风险项', 'remediate：高风险第一批')
  check(r2.measures !== undefined, 'remediate：措施查询有返回')
}
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'kc-ledger-'))
  const ledgerPath = join(dir, 'ledger.json')
  try {
    await tools.get('mpe_ledger').execute({ action: 'init', path: ledgerPath, meta: { system: 'T' } })
    await tools.get('mpe_ledger').execute({ action: 'add', path: ledgerPath, task: { id: 'T1', indicator: 'X', verifyPath: '复采可验' } })
    const upd = await tools.get('mpe_ledger').execute({ action: 'apply_diff', path: ledgerPath, outcomes: [
      { taskId: 'T1', verdict: 'effective_disappeared', evidenceNote: 'B/A 对比条目消失', paperworkDone: true },
    ] })
    check(upd.applied[0].state === '已闭环', 'ledger：init→add→apply_diff 端到端落盘', JSON.stringify(upd.applied))
    const rep = await tools.get('mpe_ledger').execute({ action: 'report', path: ledgerPath })
    check(rep.report.closureRate === 100, 'ledger：报表读回闭环率 100%')
    let dup = false
    try { await tools.get('mpe_ledger').execute({ action: 'init', path: ledgerPath }) } catch { dup = true }
    check(dup, 'ledger：重复 init 拒绝覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
{
  // mpe_diff 走真文件：用样例包自身做基线，复采用其改动副本
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'kc-diff-'))
  try {
    const base = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const after = structuredClone(base)
    after.collection.started_at = '2026-08-20T10:00:00+08:00'
    // TLS1.0 条目修复：detail 变化 + 高风险消除
    const e2 = after.findings.find(f => f.id === 'E0002')
    e2.detail = '10.10.1.5:443 探测：TLS1.2/1.3 可用；legacy 全部 rejected'
    delete e2.risk
    after.high_risk = []
    const bp = join(dir, 'baseline.json'); const ap = join(dir, 'after.json')
    writeFileSync(bp, JSON.stringify(base)); writeFileSync(ap, JSON.stringify(after))
    const d = await tools.get('mpe_diff').execute({ baselinePath: bp, afterPath: ap })
    check(d.comparability.comparable === true, 'diff：同机同口径可比')
    check(d.highRisk.cleared.length === 1 && d.highRisk.cleared[0].code === '5.2', 'diff：高风险 5.2 已消除')
    const row = d.rows.find(r => r.title === '业务端口 TLS 探测')
    check(row?.verdict === 'changed_needs_review', 'diff：detail 变化判待审')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
