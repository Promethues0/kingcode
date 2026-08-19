/**
 * 知识库查询 —— indicators / high-risk / faq 三份数据的只读检索。
 *
 * 查不到就说查不到；no_authoritative_answer 清单是防编造的一部分：
 * 命中它的问题必须回答「公开材料无权威口径」而不是给一个像样的数。
 */

/**
 * @param {object} data - { indicators, highRisk, faq } 三份已解析 JSON。
 */
export function makeKb(data) {
  const indicators = data.indicators?.indicators ?? data.indicators?.items ?? []
  const highRiskItems = data.highRisk?.items ?? []
  const faqEntries = data.faq?.entries ?? []

  /**
   * 指标名归一化：去掉括号注记、「的」字与空白后再比。
   * 各处写法不一（「通信过程中重要数据的机密性」vs「通信过程中重要数据机密性」），
   * 逐字匹配会让真实查询大量落空。
   */
  const normName = s => String(s ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[的\s]/g, '')
    .toLowerCase()

  /** 按名称（含模糊）/条款号/id 找指标；level 限定时同时返回该级要求。 */
  function findIndicator({ query, level }) {
    const q = String(query ?? '').trim()
    if (q === '') return { matches: [] }
    const norm = q.toLowerCase()
    const nq = normName(q)
    const matches = indicators.filter(ind => {
      if (ind.id === q || ind.indicator === q) return true
      const ni = normName(ind.indicator)
      if (nq.length > 0 && (ni.includes(nq) || nq.includes(ni))) return true
      // 条款号匹配：任一级的 clause 等于查询串
      return Object.values(ind.levels ?? {}).some(l => l?.clause === q || l?.clause?.toLowerCase() === norm)
    })
    return {
      matches: matches.map(ind => ({
        ...ind,
        atLevel: level !== undefined && level !== null
          ? {
              level: String(level),
              modal: ind.levels?.[String(level)]?.modal ?? null,
              clause: ind.levels?.[String(level)]?.clause ?? null,
              weight: ind.weight?.[String(level)] ?? null,
            }
          : null,
      })),
    }
  }

  function listIndicators({ layer, level }) {
    let list = indicators
    if (layer) list = list.filter(i => i.layer === layer)
    if (level !== undefined && level !== null) {
      list = list.filter(i => (i.levels?.[String(level)]?.modal ?? null) !== null)
    }
    return list
  }

  function getHighRisk(code) {
    if (code === undefined || code === null || code === '') return null
    return highRiskItems.find(i => String(i.code) === String(code)) ?? null
  }

  function listHighRisk() {
    return {
      items: highRiskItems,
      noMitigationCodes: data.highRisk?.no_mitigation_codes ?? [],
      keyMgmtHazards: data.highRisk?.key_mgmt_hazards ?? null,
      blacklists: data.highRisk?.blacklists ?? {},
    }
  }

  /** 朴素关键词检索 FAQ；同时报告 no_authoritative_answer 命中。 */
  function searchFaq(query) {
    const q = String(query ?? '').trim()
    if (q === '') return { matches: [], noAnswerHits: [] }
    const terms = q.split(/\s+/).filter(t => t.length > 0)
    const scored = faqEntries
      .map(e => {
        const hay = `${e.question}\n${e.answer_md}\n${e.section ?? ''}`
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0)
        return { entry: e, score }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    const noAnswer = (data.faq?.no_authoritative_answer ?? [])
      .filter(item => terms.some(t => String(item).includes(t)))
    return { matches: scored.map(x => x.entry), noAnswerHits: noAnswer }
  }

  return {
    findIndicator,
    listIndicators,
    getHighRisk,
    listHighRisk,
    searchFaq,
    redLines: () => data.faq?.red_lines ?? [],
    standardsVersions: () => data.faq?.standards_versions ?? [],
    noAnswerList: () => data.faq?.no_authoritative_answer ?? [],
  }
}
