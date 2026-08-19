/**
 * KB 结构化数据不变量 —— 转换产物必须过的硬门。
 * 关键常量以 KB 原文为准（层面权重、DAK 表、死条款、16 项、10 红线、5 无答案）。
 * 跑法：node test/test-mpe-data.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const load = name => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../presets/mpe-assess/data/${name}`, import.meta.url)), 'utf8'))

// ── scoring.json ────────────────────────────────────────────────────────────
{
  const s = load('scoring.json')
  const weights = s.layer_weights
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  check(sum === 100, '层面权重合计 100', `实得 ${sum}`)
  const expect = {
    物理和环境安全: 10, 网络和通信安全: 20, 设备和计算安全: 10, 应用和数据安全: 30,
    管理制度: 8, 人员管理: 8, 建设运行: 8, 应急处置: 6,
  }
  for (const [k, v] of Object.entries(expect)) {
    check(weights[k] === v, `层面权重 ${k}=${v}`, `实得 ${weights[k]}`)
  }
  const t = s.object_score_table
  check(t.D0 === 0 && t.D1A1K1 === 1 && t.D1A0K1 === 0.5 && t.D1A1K0 === 0.5 && t.D1A0K0 === 0.25,
    'D/A/K 赋分表逐值', JSON.stringify(t))
  check(s.threshold.value === null, '阈值必须是 null（原文未给数值，不许编 60）', JSON.stringify(s.threshold))
  check(typeof s.threshold.note === 'string' && s.threshold.note.length > 0, '阈值带来源说明')
  check(JSON.stringify(s.indicator_weight_values) === '[1,0.7,0.4]', '指标权重取值域')
  check(s.rounding.unit === 4 && s.rounding.layer === 4 && s.rounding.total === 2, '舍入位数 4/4/2')
  check(Array.isArray(s.compensation?.pairs) && s.compensation.pairs.length === 2, '弥补指标对恰 2 组')
}

// ── high-risk.json ──────────────────────────────────────────────────────────
{
  const h = load('high-risk.json')
  check(h.items.length === 16, '高风险 16 项', `实得 ${h.items.length}`)
  const dead = [...h.no_mitigation_codes].sort()
  const expectDead = ['10.1', '5.1', '5.2', '5.3', '7.1', '7.3', '9.3', '9.5'].sort()
  check(JSON.stringify(dead) === JSON.stringify(expectDead), '8 条无缓解死条款集合', JSON.stringify(dead))
  // 死条款在 items 里 mitigable 必须 false（7.3 仅四级也在集合内）
  for (const code of expectDead) {
    const item = h.items.find(i => String(i.code) === code)
    check(item !== undefined && item.mitigable === false, `死条款 ${code} 在 items 中且 mitigable=false`)
  }
  check(h.key_mgmt_hazards?.hazards?.length === 7, '密钥管理 7 类隐患', `实得 ${h.key_mgmt_hazards?.hazards?.length}`)
  check(h.key_mgmt_hazards?.trigger === '5.3c5', '隐患直通条款 5.3c5')
  const algos = (h.blacklists?.algorithms ?? []).map(a => typeof a === 'string' ? a : a.name)
  for (const name of ['MD5', 'DES', 'SHA-1', 'RSA']) {
    check(algos.includes(name), `算法黑名单含 ${name}`)
  }
  const protos = (h.blacklists?.protocols ?? []).map(p => typeof p === 'string' ? p : p.name)
  check(protos.some(p => /TLS\s*1\.0/i.test(p)) && protos.some(p => /SSL\s*3/i.test(p)), '协议黑名单含 TLS1.0/SSL3')
  // 每项结构完整性
  for (const item of h.items) {
    if (typeof item.code !== 'string' || !Array.isArray(item.applicable_levels) || typeof item.mitigable !== 'boolean') {
      check(false, `高风险 ${item.code ?? '?'} 结构不完整`)
    }
  }
}

// ── indicators.json ─────────────────────────────────────────────────────────
{
  const d = load('indicators.json')
  const list = d.indicators ?? d.items ?? []
  check(list.length >= 45 && list.length <= 75, `指标数量级合理（45-75）`, `实得 ${list.length}`)
  const layers = new Set(list.map(i => i.layer))
  for (const layer of ['物理和环境安全', '网络和通信安全', '设备和计算安全', '应用和数据安全']) {
    check(layers.has(layer), `含技术层面 ${layer}`)
  }
  const mgmt = list.filter(i => ['管理制度', '人员管理', '建设运行', '应急处置'].includes(i.layer))
  check(mgmt.length >= 15, '管理侧指标 ≥15', `实得 ${mgmt.length}`)
  // 助动词枚举与权重取值域
  const badModal = []
  const badWeight = []
  for (const ind of list) {
    for (const [lv, spec] of Object.entries(ind.levels ?? {})) {
      if (spec?.modal !== null && !['应', '宜', '可'].includes(spec?.modal)) badModal.push(`${ind.indicator}@${lv}:${spec?.modal}`)
      const w = ind.weight?.[lv]
      if (w !== null && w !== undefined && ![1, 0.7, 0.4].includes(w)) badWeight.push(`${ind.indicator}@${lv}:${w}`)
    }
  }
  check(badModal.length === 0, '助动词枚举合法', badModal.slice(0, 3).join(';'))
  check(badWeight.length === 0, '权重取值域合法', badWeight.slice(0, 3).join(';'))
  // 权重覆盖率：技术侧三级适用指标绝大多数应有权重
  const tech = list.filter(i => !['管理制度', '人员管理', '建设运行', '应急处置'].includes(i.layer))
  const l3applicable = tech.filter(i => (i.levels?.['3']?.modal ?? null) !== null)
  const withWeight = l3applicable.filter(i => (i.weight?.['3'] ?? null) !== null)
  check(withWeight.length / Math.max(l3applicable.length, 1) >= 0.7,
    '三级适用技术指标权重覆盖 ≥70%', `${withWeight.length}/${l3applicable.length}`)
  // 隐形指标存在
  check(list.some(i => i.indicator?.includes('密码产品')), '含「密码产品等级」隐形指标')
  check(list.some(i => i.indicator?.includes('密码服务')), '含「密码服务合规」隐形指标')
  check((d.key_lifecycle ?? []).length === 10, '密钥生存周期 10 环节', `实得 ${(d.key_lifecycle ?? []).length}`)
}

// ── faq.json ────────────────────────────────────────────────────────────────
{
  const f = load('faq.json')
  check(f.entries.length >= 40, `FAQ 条目 ≥40`, `实得 ${f.entries.length}`)
  check(f.red_lines.length === 10, '十条红线', `实得 ${f.red_lines.length}`)
  check(f.no_authoritative_answer.length === 5, '无权威口径 5 条', `实得 ${f.no_authoritative_answer.length}`)
  check((f.standards_versions ?? []).length >= 3, '标准版本对照 ≥3 行')
  const withRule = f.entries.filter(e => e.machine_rule !== null && e.machine_rule !== undefined)
  check(withRule.length >= 10, `machine_rule ≥10 条`, `实得 ${withRule.length}`)
  // 每条来源标注
  const noSource = f.entries.filter(e => !e.source)
  check(noSource.length === 0, '每条 FAQ 带来源', `缺 ${noSource.length} 条`)
}

// ── plan-template.json（KB5）───────────────────────────────────────────────
{
  const p = load('plan-template.json')
  check((p.lint_checklist ?? []).length === 15, '送审自检 15 条', `实得 ${(p.lint_checklist ?? []).length}`)
  check((p.eight_elements ?? []).length === 8, '八要素恰 8 项', `实得 ${(p.eight_elements ?? []).length}`)
  check((p.chapters ?? []).length >= 7, '章节树 ≥7 章', `实得 ${(p.chapters ?? []).length}`)
  const vd = p.compliance_table?.value_domain ?? []
  check(vd.includes('符合') && vd.includes('不适用') && !vd.includes('不符合'),
    '对照表取值域只有 符合/不适用（禁「不符合」）', JSON.stringify(vd))
  check((p.legacy_mapping ?? []).length >= 15, '0054→39786 映射 ≥15 行', `实得 ${(p.legacy_mapping ?? []).length}`)
}

// ── measures.json（KB6）────────────────────────────────────────────────────
{
  const m = load('measures.json')
  check((m.general_patterns ?? []).length === 6, '通用改造模式 6 行', `实得 ${(m.general_patterns ?? []).length}`)
  check((m.measures ?? []).length >= 20, '整改措施 ≥20 条', `实得 ${(m.measures ?? []).length}`)
  check((m.priority_rules?.order ?? []).length === 5, '优先级排序法 5 级', `实得 ${(m.priority_rules?.order ?? []).length}`)
  check((m.still_failing_cases ?? []).length === 6, '「改了仍不符合」6 种', `实得 ${(m.still_failing_cases ?? []).length}`)
  check((m.key_mgmt_measures ?? []).length === 7, '密钥管理 7 环节改造表', `实得 ${(m.key_mgmt_measures ?? []).length}`)
  const badLayer = (m.measures ?? []).filter(x => x.layer && !['物理和环境安全','网络和通信安全','设备和计算安全','应用和数据安全','管理制度','人员管理','建设运行','应急处置','密钥管理','通用要求'].includes(x.layer))
  check(badLayer.length === 0, '措施层面名逐字合法', badLayer.slice(0,2).map(x=>x.layer).join(';'))
}

// ── 全部文件带 _meta 溯源 ───────────────────────────────────────────────────
for (const name of ['indicators.json', 'high-risk.json', 'scoring.json', 'faq.json', 'plan-template.json', 'measures.json']) {
  const d = load(name)
  check(typeof d._meta?.source === 'string', `${name} 带 _meta.source`)
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
