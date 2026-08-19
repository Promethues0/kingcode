/**
 * 整改台账引擎 —— 五状态机 + diff 结论回填 + 报表。口径出自 S3 阶段 1/4。
 *
 * 纯函数：台账是普通对象，持久化（读写文件）由工具层负责。
 *
 * 硬口径：
 * - 状态只有五个值，不要发明新状态：未开始/进行中/待取证/已闭环/不整改。
 * - 「不整改」必须记录理由与决策人——测评时一定会被问。
 * - diff 回填规则：生效+证据齐→已闭环；生效但书面证据未交→待取证；
 *   没改动→退回进行中；涉及 no_permission/indirect/out_of_scope →
 *   **不许标已闭环**，停在待取证并写明补齐路径。
 * - 证据栏写法：基线/复采采集时间+具体条目，不要只写「已核对」。
 */

export const STATES = ['未开始', '进行中', '待取证', '已闭环', '不整改']

export const VERIFY_PATHS = ['复采可验', '复采可提示', '复采够不到']

/** 任务 11 字段（S3 阶段 1 的最小任务表）。 */
const TASK_FIELDS = [
  'id',           // 任务编号（与指标编号关联）
  'indicator',    // 对应指标（层面+指标名）
  'current',      // 现状（引用基线证据包具体条目+强度）
  'target',       // 目标态
  'remedy',       // 改造方案
  'systems',      // 涉及系统/设备
  'owner',        // 责任人
  'risk',         // 变更风险（高/中/低+回退方式）
  'verifyPath',   // 验证路径三选一
  'evidenceForm', // 证据形式
  'due',          // 计划完成
]

export function createLedger(meta = {}) {
  return { schema: 'kingcode-mpe-ledger/1', meta, tasks: [] }
}

/** 建任务：缺字段不拦（现场信息常分批到位），但记录哪些还空着。 */
export function addTask(ledger, fields) {
  if (!fields.id) throw new Error('任务必须有编号（id）')
  if (ledger.tasks.some(t => t.id === fields.id)) throw new Error(`任务编号 ${fields.id} 已存在`)
  if (fields.verifyPath !== undefined && !VERIFY_PATHS.includes(fields.verifyPath)) {
    throw new Error(`验证路径只能三选一（${VERIFY_PATHS.join('/')}），得到 ${fields.verifyPath}`)
  }
  const missing = TASK_FIELDS.filter(f => fields[f] === undefined || fields[f] === '')
  const now = fields._now ?? new Date().toISOString()
  const task = {
    ...Object.fromEntries(TASK_FIELDS.map(f => [f, fields[f] ?? null])),
    state: '未开始',
    batch: fields.batch ?? null,
    evidence: [],
    history: [{ at: now, state: '未开始', note: '建单' }],
    missingFields: missing,
  }
  ledger.tasks.push(task)
  return task
}

/** 状态迁移；「不整改」强制理由+决策人；「已闭环」强制证据非空。 */
export function transition(ledger, id, state, { note, decider, evidence, at } = {}) {
  if (!STATES.includes(state)) throw new Error(`状态只能取 ${STATES.join('/')}，得到 ${state}`)
  const task = ledger.tasks.find(t => t.id === id)
  if (!task) throw new Error(`无此任务：${id}`)
  if (state === '不整改') {
    if (!note || !decider) throw new Error('「不整改」必须记录理由（note）与决策人（decider）——测评时一定会被问')
  }
  if (evidence) task.evidence.push(evidence)
  if (state === '已闭环' && task.evidence.length === 0) {
    throw new Error('「已闭环」要求证据栏非空（基线/复采采集时间+具体条目，不要只写「已核对」）')
  }
  task.state = state
  task.history.push({ at: at ?? new Date().toISOString(), state, note: note ?? null, decider: decider ?? null })
  return task
}

/**
 * diff 结论回填（S3 阶段 4 的对应关系）。
 * @param {object} ledger
 * @param {{taskId: string, verdict: string, evidenceNote: string, paperworkDone?: boolean}[]} outcomes
 *   verdict 用 diff.js 的枚举；evidenceNote 形如
 *   「B 2026-08-01 10:12 / A 2026-08-09 21:40，网络和通信安全·该条目已消失」。
 */
export function applyDiff(ledger, outcomes, { at } = {}) {
  const applied = []
  for (const o of outcomes) {
    const task = ledger.tasks.find(t => t.id === o.taskId)
    if (!task) { applied.push({ taskId: o.taskId, error: '无此任务' }); continue }

    let next, note
    switch (o.verdict) {
      case 'effective_disappeared':
        if (o.paperworkDone === true) {
          next = '已闭环'; note = '改造已生效且书面证据齐'
        } else {
          next = '待取证'; note = '改造已生效，书面证据（变更单/证书/密钥记录）未交'
        }
        break
      case 'changed_needs_review':
        next = '待取证'; note = '内容已变化，待比对目标态确认后补证'
        break
      case 'no_change':
        next = '进行中'; note = 'diff 显示没改动，退回进行中'
        break
      case 'became_no_permission':
      case 'untested_no_permission':
        next = '待取证'; note = '涉及 no_permission——不许闭环；补齐路径：用同等权限账号重采'
        break
      case 'indirect_needs_confirm':
        next = '待取证'; note = '涉及 indirect——不许闭环；补齐路径：人工确认（配置原文/厂商说明/抓包）'
        break
      case 'untested_out_of_scope':
        next = '待取证'; note = '涉及 out_of_scope——不许闭环；补齐路径：填人工填报表单'
        break
      default:
        applied.push({ taskId: o.taskId, error: `不认识的 diff 结论 ${o.verdict}` }); continue
    }
    if (o.evidenceNote) task.evidence.push(o.evidenceNote)
    if (next === '已闭环' && task.evidence.length === 0) {
      next = '待取证'; note += '（证据栏为空，降为待取证）'
    }
    task.state = next
    task.history.push({ at: at ?? new Date().toISOString(), state: next, note })
    applied.push({ taskId: o.taskId, state: next, note })
  }
  return applied
}

/** 报表：闭环率、按批次进度、阻塞项（卡在谁那里、卡了多久）。 */
export function report(ledger, { now } = {}) {
  const nowMs = Date.parse(now ?? new Date().toISOString())
  const total = ledger.tasks.length
  const closed = ledger.tasks.filter(t => t.state === '已闭环').length
  const waived = ledger.tasks.filter(t => t.state === '不整改').length

  const byBatch = {}
  for (const t of ledger.tasks) {
    const key = t.batch ?? '未分批'
    const b = (byBatch[key] ??= { total: 0, closed: 0, states: {} })
    b.total += 1
    if (t.state === '已闭环') b.closed += 1
    b.states[t.state] = (b.states[t.state] ?? 0) + 1
  }

  // 阻塞项单独喊出来，不淹没在表里：非终态任务按停留时长排序
  const blockers = ledger.tasks
    .filter(t => t.state === '进行中' || t.state === '待取证')
    .map(t => {
      const last = t.history[t.history.length - 1]
      const stuckDays = Number.isFinite(Date.parse(last?.at))
        ? Math.floor((nowMs - Date.parse(last.at)) / 86400000)
        : null
      return { id: t.id, indicator: t.indicator, state: t.state, owner: t.owner, stuckDays, lastNote: last?.note ?? null }
    })
    .sort((x, y) => (y.stuckDays ?? 0) - (x.stuckDays ?? 0))

  return {
    total,
    closed,
    waived,
    closureRate: total > 0 ? Math.round((closed / total) * 10000) / 100 : null,
    byBatch,
    blockers,
  }
}
