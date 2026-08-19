/**
 * 密评引擎金样例 —— 口径逐条对 KB3 原文，全部字面常量，不依赖 data/ 生成物。
 * 跑法：node test/test-mpe-lib.js
 */

import { round, objectScore, mgmtScore, unitScore, layerScore, totalScore, conclude, assessHighRisk, compensate } from '../presets/mpe-assess/lib/score.js'
import { blacklistHits, prejudge, collectHighRisk } from '../presets/mpe-assess/lib/judge.js'
import { parseEvidence, coverage, checkSummaryMd } from '../presets/mpe-assess/lib/evidence.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)

// ── 舍入 ────────────────────────────────────────────────────────────────────
eq(round(0.12345, 4), 0.1235, 'round4 半进位')
eq(round(2 / 3, 4), 0.6667, 'round4 循环小数')
eq(round(0.615, 2), 0.62, 'round2 浮点边界（0.615 二进制略小仍应进位）')

// ── D/A/K 赋分表（KB3 3.1 逐值）────────────────────────────────────────────
eq(objectScore(true, true, true), 1, 'D√A√K√ = 1')
eq(objectScore(true, false, true), 0.5, 'D√A×K√ = 0.5')
eq(objectScore(true, true, false), 0.5, 'D√A√K× = 0.5')
eq(objectScore(true, false, false), 0.25, 'D√A×K× = 0.25')
eq(objectScore(false, true, true), 0, 'D× 直接 0（A/K 不再计）')
check((() => { try { mgmtScore(0.25) } catch { return true } return false })(), '管理侧拒绝 0.25 档')

// ── 单元分 ──────────────────────────────────────────────────────────────────
eq(unitScore([1, 0.5, 0.25]), 0.5833, '单元分=对象算术平均 round4')

// ── 层面分：双剔除与未测评区间 ──────────────────────────────────────────────
{
  const items = [
    { indicator: 'A', weight: 1, status: 'applicable', objects: [{ d: true, a: true, k: true }] },       // 1
    { indicator: 'B', weight: 0.7, status: 'not_applicable', naReason: '场景不存在' },                    // 双剔除
    { indicator: 'C', weight: 0.4, status: 'applicable', objects: [{ d: true, a: false, k: false }] },    // 0.25
  ]
  const ls = layerScore(items)
  // (1×1 + 0.4×0.25) / (1+0.4) = 1.1/1.4 = 0.785714... → 0.7857
  eq(ls.score, 0.7857, '层面分：不适用双剔除后加权 round4')
  eq(ls.untestedWeightRatio, 0, '无未测评时占比 0')
}
{
  const items = [
    { indicator: 'A', weight: 1, status: 'applicable', objects: [{ d: true, a: true, k: true }] },  // 1
    { indicator: 'B', weight: 1, status: 'untested' },                                              // 未测评
  ]
  const ls = layerScore(items)
  eq(ls.score, null, '有未测评时确定分为 null')
  eq(ls.min, 0.5, 'S_min：未测评按 0 → 1/2')
  eq(ls.max, 1, 'S_max：未测评按 1 → 2/2')
  eq(ls.testedScore, 1, '已测评部分得分')
  eq(ls.untestedWeightRatio, 0.5, '未测评权重占比')
}

// ── 总分与结论 ──────────────────────────────────────────────────────────────
const SCORING = {
  layer_weights: {
    物理和环境安全: 10, 网络和通信安全: 20, 设备和计算安全: 10, 应用和数据安全: 30,
    管理制度: 8, 人员管理: 8, 建设运行: 8, 应急处置: 6,
  },
  threshold: { value: null, note: '原文未给数值' },
}
{
  // 只评两个层面，其余整层剔除权重（KB3：整层不适用剔层面权重）
  const byLayer = {
    网络和通信安全: [{ indicator: 'N1', weight: 1, status: 'applicable', objects: [{ d: true, a: true, k: true }] }],
    应用和数据安全: [{ indicator: 'A1', weight: 1, status: 'applicable', objects: [{ d: true, a: false, k: true }] }],
  }
  const r = totalScore(byLayer, SCORING, [])
  // (20×1 + 30×0.5) / (20+30) ×100 = 35/50×100 = 70
  eq(r.total, 70, '总分：整层不适用剔权重后 ×100 round2')
  eq(r.conclusion.verdict, 'indeterminate', '阈值 null 时不编数，如实 indeterminate')
}
{
  const withThreshold = { ...SCORING, threshold: { value: 60, note: '测试用' } }
  const byLayer = {
    网络和通信安全: [{ indicator: 'N1', weight: 1, status: 'applicable', objects: [{ d: true, a: true, k: true }] }],
    应用和数据安全: [{ indicator: 'A1', weight: 1, status: 'applicable', objects: [{ d: true, a: false, k: true }] }],
  }
  eq(totalScore(byLayer, withThreshold, []).conclusion.verdict, '基本符合', '有阈值且达标 → 基本符合')
  const veto = totalScore(byLayer, withThreshold, [{ code: '9.3', mitigated: false }])
  eq(veto.conclusion.verdict, '不符合', '未缓解高风险一票否决（99 分也不符合）')
  const mitigated = totalScore(byLayer, withThreshold, [{ code: '6.1', mitigated: true }])
  eq(mitigated.conclusion.verdict, '基本符合', '已缓解的高风险不触发 veto')
}
{
  const allPerfect = {
    网络和通信安全: [{ indicator: 'N1', weight: 1, status: 'applicable', objects: [{ d: true, a: true, k: true }] }],
  }
  eq(totalScore(allPerfect, SCORING, []).conclusion.verdict, '符合', 'S=100 → 符合（无需阈值）')
}

// ── 弥补公式 ────────────────────────────────────────────────────────────────
eq(compensate(1, 0.25), 0.5, 'MAX(0.5×1, 0.25) = 0.5')
eq(compensate(0.5, 0.5), 0.5, 'MAX(0.25, 0.5) = 0.5')

// ── 黑名单命中 ──────────────────────────────────────────────────────────────
const BLACKLISTS = {
  algorithms: ['MD5', 'DES', 'SHA-1', { name: 'RSA', max_insecure_bits: 2047 }],
  protocols: ['SSH1.0', 'SSL2.0', 'SSL3.0', 'TLS1.0'],
}
{
  const hits = blacklistHits('证书签名算法 SHA-1 with RSA 1024 bit', BLACKLISTS)
  check(hits.some(h => h.name === 'SHA-1'), 'SHA-1 命中')
  check(hits.some(h => h.name.startsWith('RSA-1024')), 'RSA 1024 位命中')
  eq(blacklistHits('TLS_ECDHE 与 SHA-256 均安全', BLACKLISTS).length, 0, 'SHA-256 不误伤 SHA-1 规则')
  check(blacklistHits('检测到 TLS1.0 已启用', BLACKLISTS).some(h => h.name === 'TLS1.0'), 'TLS1.0 协议命中')
  eq(blacklistHits('3DES-EDE 加密', BLACKLISTS).length, 0, '3DES 不误伤 DES 词边界')
}

// ── 预判：强度四态路由 ──────────────────────────────────────────────────────
{
  const findings = [
    { id: 'E1', layer: '设备和计算安全', indicator: '远程管理通道安全', clause: '8.3c', title: 'SSH 算法', strength: 'direct', detail: '仅启用 aes256-ctr 等' },
    { id: 'E2', layer: '应用和数据安全', indicator: '重要数据传输机密性', clause: '8.4c', title: 'TLS 配置', strength: 'indirect', detail: '业务端口探测 unreachable' },
    { id: 'E3', layer: '应用和数据安全', indicator: '重要数据存储机密性', clause: '8.4e', title: '数据库加密', strength: 'no_permission', detail: '无库账号' },
    { id: 'E4', layer: '网络和通信安全', indicator: '通信数据完整性', clause: '8.2c', title: '弱协议', strength: 'direct', detail: '检测到 SSL3.0 与 MD5 摘要' },
  ]
  const r = prejudge(findings, { blacklists: BLACKLISTS })
  eq(r.judgments.length, 2, 'direct 两条进判定')
  eq(r.confirms.length, 1, 'indirect 一条进待确认')
  eq(r.untested.length, 1, 'no_permission 一条进未测评')
  const e4 = r.judgments.find(j => j.id === 'E4')
  eq(e4.draft.a, false, '黑名单命中 → A=false')
  const e1 = r.judgments.find(j => j.id === 'E1')
  eq(e1.draft.d, null, '判读怀疑主义：无规则命中时 D 留 null 不臆断')
}

// ── 高风险汇总：confirm_required 不直接 veto ────────────────────────────────
{
  const pack = { high_risk: [
    { id: 'E9', indicator: 'X', strength: 'direct', risk: { code: '5.2', confirm_required: false } },
    { id: 'E10', indicator: 'Y', strength: 'direct', risk: { code: '5.1', confirm_required: true } },
  ] }
  const hrData = { items: [{ code: '5.2', mitigable: false }, { code: '5.1', mitigable: false }] }
  const r = collectHighRisk(pack, hrData)
  eq(r.hits.length, 1, '确定命中 1 条')
  eq(r.confirms.length, 1, 'confirm_required 进待确认不直接 veto')
}

// ── 证据包解析 ──────────────────────────────────────────────────────────────
{
  const minimal = JSON.stringify({
    schema: 'mpe-evidence/1.0',
    collector: {}, standard: {}, collection: { dry_run: false, probe_enabled: true },
    findings: [
      { id: 'E1', layer: '设备和计算安全', indicator: 'I', clause: '8.3c', title: 'T', strength: 'direct', detail: '' },
      { id: 'E2', layer: '设备和计算安全', indicator: 'I2', clause: '8.3d', title: 'T2', strength: 'bogus', detail: '' },
    ],
    manual_required: [], high_risk: [],
    audit: { summary: { write_operations_on_target_system: 0, outbound_connections_to_third_parties: 1 } },
  })
  const { pack, problems } = parseEvidence(minimal)
  check(problems.some(p => p.includes('bogus')), '非法 strength 被报出')
  check(problems.some(p => p.includes('outbound')), '外联审计红线被报出')
  const cov = coverage(pack)
  eq(cov.findingsTotal, 2, '覆盖度：总数')
  eq(cov.judgeable, 1, '覆盖度：direct 计数（bogus 不计）')
  check((() => { try { parseEvidence(JSON.stringify({ schema: 'mpe-evidence/2.0' })) } catch { return true } return false })(),
    'major=2 按规范必须停止处理')
}

// ── 摘要完整性 ──────────────────────────────────────────────────────────────
{
  const good = '# 0. 采集元信息\n...\n# 1. 高风险直判预警\n...\n# 10. 本工具够不到的指标\n...\n本摘要由采集器生成，免责与口径说明。'
  eq(checkSummaryMd(good).problems.length, 0, '合规摘要无问题')
  const cut = '# 0. 采集元信息\n只有一半'
  check(checkSummaryMd(cut).problems.length >= 2, '缺章节+缺哨兵都被报出')
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
