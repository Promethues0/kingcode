/**
 * 整改优先级排序 + 措施推荐 —— 口径出自 S3 阶段 2 与 KB6。
 *
 * 排序五级（禁「好改的先改」）：
 *   1 高风险判定项（一票否决，永远第一批）
 *   2 权重高层面的不符合项（按「改这条能提多少分」= 层面权重×指标权重×缺口）
 *   3 配置类快赢（算法套件/协议版本/证书替换）
 *   4 长周期项（决定总工期，越早启动越好——排位靠后≠晚启动，报表单独标注）
 *   5 管理类（可并行，别留到最后一周补）
 */

/**
 * @typedef {object} Gap
 * @property {string} indicator - 指标名。
 * @property {string} layer - 标准层面名。
 * @property {boolean} [isHighRisk] - 是否命中高风险判定项。
 * @property {number|null} [weight] - 指标权重（1/0.7/0.4）。
 * @property {number} [unitScore] - 当前单元分（0~1）；缺省按 0（完全不符合）。
 * @property {'config'|'long'|'mgmt'|'other'} [kind] - 任务性质：配置快赢/长周期/管理类。
 */

const MGMT_LAYERS = new Set(['管理制度', '人员管理', '建设运行', '应急处置'])

/** 提分效率：层面权重 × 指标权重 × 缺口。数据缺失时置 0 并在行内说明。 */
function gainOf(gap, layerWeights) {
  const lw = layerWeights[gap.layer] ?? 0
  const iw = gap.weight ?? 0
  const gapSize = 1 - (gap.unitScore ?? 0)
  return lw * iw * gapSize
}

/**
 * 排序并分批。
 * @param {Gap[]} gaps
 * @param {object} scoring - scoring.json（取 layer_weights）。
 * @returns {{batches: object[], flags: string[]}}
 */
export function prioritize(gaps, scoring) {
  const layerWeights = scoring.layer_weights ?? {}
  const rows = gaps.map(g => ({
    ...g,
    kind: g.kind ?? (MGMT_LAYERS.has(g.layer) ? 'mgmt' : 'other'),
    gain: gainOf(g, layerWeights),
  }))

  const tier = r => r.isHighRisk ? 1
    : r.kind === 'config' ? 3
    : r.kind === 'long' ? 4
    : r.kind === 'mgmt' ? 5
    : 2
  for (const r of rows) r.tier = tier(r)

  // 同级内按提分效率降序；全排序后切三批：第一批=高风险+快赢，其余按级
  rows.sort((x, y) => x.tier - y.tier || y.gain - x.gain)

  const batch1 = rows.filter(r => r.tier === 1 || r.tier === 3)
  const batch2 = rows.filter(r => r.tier === 2)
  const batch3 = rows.filter(r => r.tier === 4 || r.tier === 5)

  const flags = []
  const longItems = rows.filter(r => r.kind === 'long')
  if (longItems.length > 0) {
    flags.push(`长周期项 ${longItems.length} 条（${longItems.map(r => r.indicator).join('、')}）决定总工期——虽排第三批，**立项要提前到现在**`)
  }
  if (rows.some(r => r.kind === 'mgmt')) {
    flags.push('管理类可与技术改造并行，不要留到最后一周补——评审看得出来')
  }

  return {
    batches: [
      { name: '第一批：高风险 + 配置快赢', items: batch1 },
      { name: '第二批：高权重不符合项', items: batch2 },
      { name: '第三批：长周期 + 管理类（长周期立项须提前）', items: batch3 },
    ],
    flags,
  }
}

/**
 * 按指标/层面查整改措施（KB6 结构化数据）。
 * @param {string} query - 指标名或症状关键词。
 * @param {object} measuresData - measures.json。
 */
export function suggestMeasures(query, measuresData) {
  const q = String(query ?? '').trim()
  if (q === '') return { matches: [] }
  const norm = s => String(s ?? '').replace(/[的\s]/g, '')
  const nq = norm(q)
  const matches = (measuresData.measures ?? []).filter(m =>
    norm(m.symptom).includes(nq)
    || nq.length > 1 && (m.indicator_refs ?? []).some(r => norm(r).includes(nq) || nq.includes(norm(r)))
    || norm(m.layer) === nq)
  return {
    matches,
    keyMgmt: /密钥/.test(q) ? measuresData.key_mgmt_measures ?? [] : [],
    stillFailing: measuresData.still_failing_cases ?? [],
  }
}
