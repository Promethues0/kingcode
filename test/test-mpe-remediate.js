/**
 * 密改引擎金样例：diff 判定表七行 / 台账五状态机 / 优先级排序。
 * 口径对 S3 原文；全部字面常量。跑法：node test/test-mpe-remediate.js
 */

import { comparability, diffPacks } from '../presets/mpe-assess/lib/diff.js'
import { createLedger, addTask, transition, applyDiff, report, STATES } from '../presets/mpe-assess/lib/ledger.js'
import { prioritize, suggestMeasures } from '../presets/mpe-assess/lib/remediate.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)

/** 造证据包：host/collection 可比，findings 由用例给。 */
const mkPack = ({ findings = [], highRisk = [], startedAt, hostname = 'app-01', isRoot = false, probe = true, version = '1.0.0' }) => ({
  schema: 'mpe-evidence/1.0',
  collector: { name: 'mpe-collect', version },
  collection: { started_at: startedAt, probe_enabled: probe },
  domains: { host: { hostname, system: 'Linux', arch: 'x86_64', is_root: isRoot } },
  findings,
  high_risk: highRisk,
  audit: { summary: { commands_executed: 80, paths_read: 400, paths_denied: 5 } },
})
const F = (layer, indicator, title, strength, detail = '', risk) => ({
  id: 'E?', layer, indicator, clause: 'x', title, strength, detail, ...(risk ? { risk } : {}),
})

// ── 可比性 ──────────────────────────────────────────────────────────────────
{
  const b = mkPack({ startedAt: '2026-08-01T10:00:00+08:00' })
  const a = mkPack({ startedAt: '2026-08-09T21:00:00+08:00', hostname: 'app-02' })
  const c = comparability(b, a)
  check(!c.comparable, '不同主机 → 不可比')
  const d = diffPacks(b, a)
  eq(d.rows.length, 0, '不可比时不产出逐条结论（不硬凑）')
}
{
  const b = mkPack({ startedAt: '2026-08-09T21:00:00+08:00' })
  const a = mkPack({ startedAt: '2026-08-01T10:00:00+08:00' })
  check(!comparability(b, a).comparable, '复采早于基线 → 不可比（时序）')
  const a2 = mkPack({ startedAt: '2026-08-10T10:00:00+08:00', probe: false })
  check(!comparability(b, a2).comparable, '探测口径不一致 → 不可比')
  const a3 = mkPack({ startedAt: '2026-08-10T10:00:00+08:00', isRoot: true })
  check(!comparability(b, a3).comparable, '运行身份不一致 → 不可比')
}

// ── diff 判定表七行 ─────────────────────────────────────────────────────────
{
  const b = mkPack({
    startedAt: '2026-08-01T10:12:00+08:00',
    findings: [
      F('网络和通信安全', '通信过程中重要数据机密性', 'TLS 弱协议', 'direct', 'TLS1.0 已启用'),   // → 消失
      F('设备和计算安全', '远程管理通道安全', 'SSH 算法', 'direct', '含 hmac-sha1'),               // → 内容变化
      F('设备和计算安全', '系统资源访问控制信息完整性', '证书签名算法', 'direct', 'SHA-1 证书'),   // → 不变
      F('应用和数据安全', '重要数据存储机密性', '数据库 TDE', 'direct', '未启用 TDE'),             // → no_permission
      F('应用和数据安全', '重要数据传输机密性', '内部调用协议', 'no_permission', ''),              // → direct（覆盖度）
      F('网络和通信安全', '通信实体身份鉴别', '接入认证', 'indirect', '旁证'),                     // → indirect
      F('物理和环境安全', '电磁泄漏发射防护', '机房', 'out_of_scope', ''),                         // → 不变
    ],
    highRisk: [F('网络和通信安全', '通信过程中重要数据机密性', 'TLS 弱协议', 'direct', 'TLS1.0', { code: '5.2' })],
  })
  const a = mkPack({
    startedAt: '2026-08-09T21:40:00+08:00',
    findings: [
      // TLS 弱协议条目消失
      F('设备和计算安全', '远程管理通道安全', 'SSH 算法', 'direct', '仅 hmac-sha2-256'),
      F('设备和计算安全', '系统资源访问控制信息完整性', '证书签名算法', 'direct', 'SHA-1 证书'),
      F('应用和数据安全', '重要数据存储机密性', '数据库 TDE', 'no_permission', ''),
      F('应用和数据安全', '重要数据传输机密性', '内部调用协议', 'direct', 'TLCP supported'),
      F('网络和通信安全', '通信实体身份鉴别', '接入认证', 'indirect', '旁证'),
      F('物理和环境安全', '电磁泄漏发射防护', '机房', 'out_of_scope', ''),
      F('设备和计算安全', '重要信息资源安全标记完整性', '新暴露面', 'direct', '新增弱配置', { code: '6.2' }),  // 新出现
    ],
    highRisk: [F('设备和计算安全', '重要信息资源安全标记完整性', '新暴露面', 'direct', '', { code: '6.2' })],
  })
  const d = diffPacks(b, a)
  const v = key => d.rows.find(r => r.title === key)?.verdict
  eq(v('TLS 弱协议'), 'effective_disappeared', '① direct→消失 = 生效候选')
  eq(v('SSH 算法'), 'changed_needs_review', '② direct→direct 内容变 = 待比对目标态')
  eq(v('证书签名算法'), 'no_change', '③ direct→direct 一致 = 没改动')
  eq(v('数据库 TDE'), 'became_no_permission', '④ direct→no_permission = 不算改好')
  eq(v('内部调用协议'), 'coverage_gained', '⑤ no_permission→direct = 覆盖度变化非成效')
  eq(v('接入认证'), 'indirect_needs_confirm', '⑥ indirect = 人工确认')
  eq(v('机房'), 'untested_out_of_scope', '⑦ out_of_scope = 永远未测评')
  eq(v('新暴露面'), 'new_entry', '⑧ 新出现条目单列')
  eq(d.highRisk.cleared.map(x => x.code), ['5.2'], '高风险差集：5.2 已消除')
  eq(d.highRisk.introduced.map(x => x.code), ['6.2'], '高风险差集：6.2 为引入的新问题')
  check(d.highRisk.alarm !== null && d.highRisk.alarm.includes('6.2'), '新增高风险触发事故级报警')
  // 本 fixture 基线/复采各 1 条 no_permission（互换非增加），不应误报回归
  check(d.untestedRegression === null, 'no_permission 计数相等不误报回归')
}
{
  // 真正的未测评回归：复采权限不如基线
  const b = mkPack({ startedAt: '2026-08-01T10:00:00+08:00', findings: [
    F('设备和计算安全', 'X', 'a', 'direct', 'v1'),
    F('设备和计算安全', 'Y', 'b', 'direct', 'v1'),
  ] })
  const a = mkPack({ startedAt: '2026-08-09T10:00:00+08:00', findings: [
    F('设备和计算安全', 'X', 'a', 'no_permission', ''),
    F('设备和计算安全', 'Y', 'b', 'no_permission', ''),
  ] })
  const d = diffPacks(b, a)
  check(d.untestedRegression !== null, 'no_permission 变多触发未测评回归提示')
  eq(d.rows.filter(r => r.verdict === 'became_no_permission').length, 2, '两条均判 became_no_permission')
}

// ── 台账 ────────────────────────────────────────────────────────────────────
{
  eq(STATES, ['未开始', '进行中', '待取证', '已闭环', '不整改'], '状态恰五值不发明新状态')
  const L = createLedger({ system: '测试系统' })
  addTask(L, { id: 'T1', indicator: '网络和通信安全·机密性', verifyPath: '复采可验', owner: '张三', _now: '2026-08-01T00:00:00Z' })
  addTask(L, { id: 'T2', indicator: '重要数据存储机密性', verifyPath: '复采够不到', owner: '李四', _now: '2026-08-01T00:00:00Z' })
  check((() => { try { addTask(L, { id: 'T1' }) } catch { return true } return false })(), '重复编号被拒')
  check((() => { try { addTask(L, { id: 'T3', verifyPath: '看一眼' }) } catch { return true } return false })(), '验证路径三选一之外被拒')
  check((() => { try { transition(L, 'T2', '不整改', {}) } catch { return true } return false })(), '不整改缺理由/决策人被拒')
  check((() => { try { transition(L, 'T1', '已闭环', {}) } catch { return true } return false })(), '闭环缺证据被拒')

  const applied = applyDiff(L, [
    { taskId: 'T1', verdict: 'effective_disappeared', evidenceNote: 'B 08-01 10:12 / A 08-09 21:40，该条目已消失', paperworkDone: true },
    { taskId: 'T2', verdict: 'untested_out_of_scope', evidenceNote: '两包均 out_of_scope' },
  ], { at: '2026-08-10T00:00:00Z' })
  eq(applied[0].state, '已闭环', '回填：生效+书面证据齐 → 已闭环')
  eq(applied[1].state, '待取证', '回填：out_of_scope 不许闭环，停在待取证')
  check(applied[1].note.includes('人工填报'), '回填注明补齐路径')

  const rep = report(L, { now: '2026-08-20T00:00:00Z' })
  eq(rep.closureRate, 50, '闭环率 1/2 = 50%')
  eq(rep.blockers.length, 1, '阻塞项单列')
  eq(rep.blockers[0].stuckDays, 10, '阻塞天数按最后一次状态变更算')
}
{
  // 生效但书面证据没交 → 待取证
  const L = createLedger()
  addTask(L, { id: 'T1', _now: '2026-08-01T00:00:00Z' })
  const applied = applyDiff(L, [{ taskId: 'T1', verdict: 'effective_disappeared', evidenceNote: 'x' }])
  eq(applied[0].state, '待取证', '回填：生效但 paperwork 未交 → 待取证')
}

// ── 优先级 ──────────────────────────────────────────────────────────────────
{
  const SCORING = { layer_weights: { 网络和通信安全: 20, 应用和数据安全: 30, 管理制度: 8, 设备和计算安全: 10 } }
  const { batches, flags } = prioritize([
    { indicator: '高风险项', layer: '网络和通信安全', isHighRisk: true, weight: 1, unitScore: 0 },
    { indicator: '存储加密', layer: '应用和数据安全', weight: 1, unitScore: 0, kind: 'long' },
    { indicator: '协议套件', layer: '网络和通信安全', weight: 0.7, unitScore: 0.25, kind: 'config' },
    { indicator: '制度修订', layer: '管理制度', weight: 1, unitScore: 0.5, kind: 'mgmt' },
    { indicator: '普通不符合A', layer: '应用和数据安全', weight: 1, unitScore: 0 },
    { indicator: '普通不符合B', layer: '设备和计算安全', weight: 0.4, unitScore: 0.5 },
  ], SCORING)
  eq(batches[0].items[0].indicator, '高风险项', '高风险永远第一批第一位')
  check(batches[0].items.some(i => i.indicator === '协议套件'), '配置快赢进第一批')
  eq(batches[1].items[0].indicator, '普通不符合A', '第二批按提分效率降序（30×1×1 最大）')
  check(batches[2].items.some(i => i.indicator === '存储加密') && batches[2].items.some(i => i.indicator === '制度修订'),
    '长周期与管理类在第三批')
  check(flags.some(f => f.includes('立项要提前')), '长周期项带「立项提前」旗标')
}
{
  const measures = {
    measures: [
      { id: 'M01', layer: '应用和数据安全', symptom: '重要数据明文存储', remedy: '字段级SM4+KMS', verification: '查库看密文', pitfalls: ['密钥与密文同存等于没加密'], indicator_refs: ['重要数据存储机密性'] },
    ],
    key_mgmt_measures: [{ stage: '存储', remedy: 'x', verification: 'y' }],
    still_failing_cases: [{ case: 'c', reason: 'r', correct_action: 'a' }],
  }
  check(suggestMeasures('存储机密性', measures).matches.length === 1, '按指标名查到措施')
  check(suggestMeasures('明文存储', measures).matches.length === 1, '按症状查到措施')
  check(suggestMeasures('密钥归档', measures).keyMgmt.length === 1, '密钥类查询带七环节表')
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
