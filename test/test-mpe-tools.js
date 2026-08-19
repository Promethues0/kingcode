/**
 * mpe-tools 插件无头测试：假 ctx 收 register，直接驱动 execute。
 * 依赖 data/ 生成物（KB 转换完成后才能全绿）与 fixtures/mpe-evidence-sample.json。
 * 跑法：node test/test-mpe-tools.js
 */

import { fileURLToPath } from 'node:url'
import * as plugin from '../presets/mpe-assess/mpe-tools.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}

const tools = new Map()
plugin.apply({
  effect: fn => fn(),
  tools: { register: def => { tools.set(def.name, def) } },
})

check(tools.size === 6, '注册 6 个工具', `实得 ${tools.size}: ${[...tools.keys()].join(',')}`)
for (const name of ['mpe_kb_indicator', 'mpe_kb_high_risk', 'mpe_kb_faq', 'mpe_evidence_load', 'mpe_judge', 'mpe_score']) {
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

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
