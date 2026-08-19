/**
 * 密评四级量化打分引擎 —— 口径全部出自 KB3-量化评估规则（GB/T 39786 配套）。
 *
 * 这里只有算术，没有判断：D/A/K 的取值由人或模型给（judge.js 只做确定性预判），
 * 本引擎负责把取值变成可复核的分数。所有中间结果保留在 trace 里——
 * 安小龙时代模型手算加权平均是幻觉重灾区，可复核的计算过程就是解药。
 *
 * 硬口径（勿改，改前先对 KB3 原文）：
 * - 测评对象分只有 {0, 0.25, 0.5, 1}：D=× 直接 0；D√A×K√ 与 D√A√K× 均 0.5；
 *   D√A×K× 为 0.25。无 0.75 档。
 * - 管理侧测评单元不按对象量化：直接取 {0, 0.5, 1}。
 * - 舍入：单元/层面 4 位小数，总分（×100 后）2 位——四舍五入。
 * - 不适用：分子分母双剔除；整层不适用则该层面权重也剔除。
 * - 未测评（no_permission / out_of_scope）：**既不按 0 计入，也不当不适用剔除**，
 *   出 S_min（未测评全按 0）/ S_max（全按 1）/ 已测评部分得分 / 未测评占比 四数。
 *   注意这是自评估口径，非规则原文（KB3 原文只覆盖已测评情形）。
 * - 高风险一票否决：任一未缓解高风险 → 结论必为不符合，与分数无关。
 * - 结论阈值：原文未给数值。threshold 为 null 时「基本符合」边界无法判定，
 *   引擎如实输出 indeterminate 而不是偷偷用 60。
 */

/** 四舍五入到 digits 位小数（避开二进制浮点在 .5 边界上的漂移）。 */
export function round(value, digits) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/**
 * 测评对象分。
 * @param {boolean} d - D：是否部署/存在密码措施。
 * @param {boolean} a - A：算法/技术是否合规。
 * @param {boolean} k - K：密钥管理是否安全。
 * @returns {0|0.25|0.5|1}
 */
export function objectScore(d, a, k) {
  if (!d) return 0
  if (a && k) return 1
  if (!a && !k) return 0.25
  return 0.5
}

/** 管理侧单元分：只许 0 / 0.5 / 1。 */
export function mgmtScore(value) {
  if (value !== 0 && value !== 0.5 && value !== 1) {
    throw new Error(`管理侧单元分只能取 0/0.5/1，得到 ${value}`)
  }
  return value
}

/**
 * 测评单元分：对象分算术平均，round4。
 * @param {number[]} objectScores - 各测评对象分。
 */
export function unitScore(objectScores) {
  if (objectScores.length === 0) throw new Error('测评单元没有任何对象分')
  const sum = objectScores.reduce((s, v) => s + v, 0)
  return round(sum / objectScores.length, 4)
}

/**
 * 一条指标的求值输入。
 * @typedef {object} IndicatorResult
 * @property {string} indicator - 指标名。
 * @property {string} layer - 标准层面名（逐字）。
 * @property {number|null} weight - 指标权重（1/0.7/0.4），null=本级无要求。
 * @property {'applicable'|'not_applicable'|'untested'} status
 *   applicable=正常计入；not_applicable=双剔除；untested=未测评（出区间）。
 * @property {{d:boolean,a:boolean,k:boolean}[]} [objects] - 技术侧对象取值。
 * @property {number} [mgmt] - 管理侧单元分（0/0.5/1），与 objects 二选一。
 * @property {string} [naReason] - not_applicable 时的论证理由（进 trace）。
 */

/** 求一条指标的单元分；untested 返回 null。 */
function resolveUnitScore(item) {
  if (item.status !== 'applicable') return null
  if (item.objects !== undefined && item.objects.length > 0) {
    return unitScore(item.objects.map(o => objectScore(o.d, o.a, o.k)))
  }
  if (item.mgmt !== undefined) return mgmtScore(item.mgmt)
  throw new Error(`指标「${item.indicator}」是 applicable 但既无 objects 也无 mgmt`)
}

/**
 * 层面分（含未测评区间）。
 * @param {IndicatorResult[]} items - 同一层面的全部适用级指标。
 * @returns {{score:number|null, min:number, max:number, testedScore:number|null,
 *   untestedWeightRatio:number, rows:object[]}}
 *   score 仅当无未测评时非 null（即确定值）；min/max 恒有。
 */
export function layerScore(items) {
  const rows = []
  let num = 0            // 加权分子（已测评）
  let den = 0            // 加权分母（已测评 + 未测评；不适用剔除）
  let untestedWeight = 0

  for (const item of items) {
    if (item.weight === null || item.weight === undefined) {
      rows.push({ indicator: item.indicator, skipped: '本级无要求（权重 —）' })
      continue
    }
    if (item.status === 'not_applicable') {
      rows.push({ indicator: item.indicator, skipped: `不适用（双剔除）：${item.naReason ?? '未给理由'}` })
      continue
    }
    const score = resolveUnitScore(item)
    if (score === null) {
      untestedWeight += item.weight
      den += item.weight
      rows.push({ indicator: item.indicator, weight: item.weight, unitScore: null, untested: true })
      continue
    }
    num += item.weight * score
    den += item.weight
    rows.push({ indicator: item.indicator, weight: item.weight, unitScore: score })
  }

  if (den === 0) {
    // 整层没有可计指标（全不适用/全无要求）→ 层面不参与总分
    return { score: null, min: 0, max: 0, testedScore: null, untestedWeightRatio: 0, rows, layerNotApplicable: true }
  }

  const min = round(num / den, 4)                       // 未测评按 0
  const max = round((num + untestedWeight) / den, 4)    // 未测评按 1
  const testedDen = den - untestedWeight
  const testedScore = testedDen > 0 ? round(num / testedDen, 4) : null
  return {
    score: untestedWeight === 0 ? min : null,
    min,
    max,
    testedScore,
    untestedWeightRatio: round(untestedWeight / den, 4),
    rows,
    layerNotApplicable: false,
  }
}

/**
 * 整体得分与结论。
 * @param {Record<string, IndicatorResult[]>} byLayer - 层面名→该层指标结果。
 * @param {object} scoring - scoring.json（layer_weights / threshold / ...）。
 * @param {{code:string, mitigated:boolean}[]} highRiskHits - 高风险命中及缓解状态。
 * @returns 完整计分对象（含 trace，可复核）。
 */
export function totalScore(byLayer, scoring, highRiskHits = []) {
  const layerWeights = scoring.layer_weights
  const layers = {}
  let num = 0, den = 0
  let minNum = 0, maxNum = 0
  let anyUntested = false

  for (const [layerName, weight] of Object.entries(layerWeights)) {
    const items = byLayer[layerName]
    if (items === undefined || items.length === 0) {
      layers[layerName] = { skipped: '本次未评估该层面（按整层不适用剔除权重）' }
      continue
    }
    const ls = layerScore(items)
    layers[layerName] = ls
    if (ls.layerNotApplicable) continue
    den += weight
    minNum += weight * ls.min
    maxNum += weight * ls.max
    if (ls.score !== null) {
      num += weight * ls.score
    } else {
      anyUntested = true
    }
  }

  if (den === 0) {
    return { total: null, note: '没有任何可计层面', layers, highRisk: assessHighRisk(highRiskHits) }
  }

  const totalMin = round((minNum / den) * 100, 2)
  const totalMax = round((maxNum / den) * 100, 2)
  const total = anyUntested ? null : totalMin   // 无未测评时 min=max=确定值
  const highRisk = assessHighRisk(highRiskHits)
  const conclusion = conclude({ total, totalMin, totalMax, scoring, highRisk })

  return { total, totalMin, totalMax, anyUntested, layers, highRisk, conclusion }
}

/** 高风险闸门：任一未缓解命中 → veto。 */
export function assessHighRisk(hits) {
  const unmitigated = hits.filter(h => !h.mitigated)
  return {
    hits,
    unmitigated: unmitigated.map(h => h.code),
    veto: unmitigated.length > 0,
  }
}

/**
 * 结论判定。三条规则出自 KB3：S=100→符合；S≥阈值且无未缓解高风险→基本符合；
 * 其余→不符合。阈值为 null 时不许编数：能判「符合」「不符合(有高风险/S=100不成立时的下界判断)」
 * 之外的情形一律 indeterminate。
 */
export function conclude({ total, totalMin, totalMax, scoring, highRisk }) {
  if (highRisk.veto) {
    return {
      verdict: '不符合',
      reason: `存在未缓解的高风险项（${highRisk.unmitigated.join('、')}），一票否决，与分数无关`,
    }
  }
  const threshold = scoring.threshold?.value ?? null
  if (total === 100) return { verdict: '符合', reason: '全部适用指标满分且无高风险' }
  if (total !== null) {
    if (threshold === null) {
      return {
        verdict: 'indeterminate',
        reason: `得分 ${total}，无高风险；但结论阈值原文未给数值（${scoring.threshold?.note ?? ''}），无法判定是否达到「基本符合」线`,
      }
    }
    return total >= threshold
      ? { verdict: '基本符合', reason: `得分 ${total} ≥ 阈值 ${threshold} 且无未缓解高风险` }
      : { verdict: '不符合', reason: `得分 ${total} < 阈值 ${threshold}` }
  }
  // 有未测评：只能给区间性结论
  if (threshold !== null && totalMin >= threshold) {
    return { verdict: '基本符合(下界已达标)', reason: `未测评全按 0 的下界 ${totalMin} 已 ≥ 阈值 ${threshold}` }
  }
  if (threshold !== null && totalMax < threshold) {
    return { verdict: '不符合(上界未达标)', reason: `未测评全按 1 的上界 ${totalMax} 仍 < 阈值 ${threshold}` }
  }
  return {
    verdict: 'indeterminate',
    reason: `存在未测评项，得分区间 [${totalMin}, ${totalMax}]${threshold === null ? '，且结论阈值原文未给数值' : `横跨阈值 ${threshold}`}——区间宽度就是还该补多少证据的度量`,
  }
}

/**
 * 弥补公式：MAX(0.5×PA, PB)，round4。仅限 scoring.compensation.pairs 里的指标对。
 * @param {number} pa - 主指标单元分。
 * @param {number} pb - 弥补指标单元分。
 */
export function compensate(pa, pb) {
  return round(Math.max(0.5 * pa, pb), 4)
}
