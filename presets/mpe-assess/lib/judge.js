/**
 * findings → D/A/K 确定性预判引擎。
 *
 * 只做**规则能确定**的部分：算法/协议黑名单、TLCP 探测六态、证据强度四态映射。
 * 判不动的一律输出「待确认清单（要谁确认什么）」而不是结论——
 * 「把没权限看写成结论」被密评技能包定义为整套体系最严重的事故模式。
 *
 * 判读怀疑主义（S4 原文，预判永远不会推翻它）：
 * - 存在 ≠ 在用（D-1）：装了国密库推不出业务在用 → D 不能仅凭 direct 置 true
 * - 产品存在推不出 K√（K-3）：K 默认 null 留给人判
 */

/** TLCP 探测六态 → 证据可用性（证据包规范第七节）。 */
const TLCP_VERDICTS = {
  supported: { usable: 'direct', meaning: '目标支持 TLCP（收到 0x0101 ServerHello）' },
  not_supported_alert: { usable: 'direct', meaning: '目标明确不支持 TLCP（Alert 拒绝），可支撑「未使用国密协议」' },
  not_supported_other_version: { usable: 'direct', meaning: '目标以其他版本响应，未走 TLCP' },
  not_a_tls_service: { usable: 'indirect', meaning: '端口不是 TLS 服务，需人工确认业务协议' },
  unreachable: { usable: 'indirect', meaning: '探测不可达，不能据此下任何结论' },
  inconclusive: { usable: 'indirect', meaning: '未探明——是「没探到」不是「不支持」，写成不支持即编造结论' },
}

/** 在文本中找黑名单算法/协议命中（大小写不敏感，词边界防止 SHA-1 误匹配 SHA-256 等）。 */
export function blacklistHits(text, blacklists) {
  const hits = []
  const haystack = String(text ?? '')
  for (const algo of blacklists.algorithms ?? []) {
    const name = typeof algo === 'string' ? algo : algo.name
    if (name === 'RSA' && typeof algo === 'object' && algo.max_insecure_bits) {
      // RSA 位数：匹配 "RSA" 邻近的位数
      const m = haystack.match(/RSA[^0-9]{0,20}(\d{3,5})\s*(?:bit|位)?/i)
      if (m && Number(m[1]) <= algo.max_insecure_bits) {
        hits.push({ kind: 'algorithm', name: `RSA-${m[1]}`, rule: `RSA ≤ ${algo.max_insecure_bits} 位` })
      }
      continue
    }
    const re = new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')
    if (re.test(haystack)) hits.push({ kind: 'algorithm', name, rule: '弱算法黑名单' })
  }
  for (const proto of blacklists.protocols ?? []) {
    const name = typeof proto === 'string' ? proto : proto.name
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i')
    if (re.test(haystack)) hits.push({ kind: 'protocol', name, rule: '弃用协议黑名单' })
  }
  return hits
}

/**
 * 逐 finding 预判。
 * @param {object[]} findings - 证据包 findings[]。
 * @param {object} highRiskData - high-risk.json（用其 blacklists 与 items）。
 * @returns {{judgments:object[], confirms:object[], untested:object[]}}
 */
export function prejudge(findings, highRiskData) {
  const judgments = []
  const confirms = []
  const untested = []

  for (const f of findings) {
    const base = { id: f.id, layer: f.layer, indicator: f.indicator, clause: f.clause, title: f.title, strength: f.strength }

    // 四态铁律：未测评的两态永远进未测评清单，绝不产出 D/A/K
    if (f.strength === 'no_permission' || f.strength === 'out_of_scope') {
      untested.push({ ...base, note: '未测评：既不按 0 计分也不按不适用剔除，只能出上下界区间' })
      continue
    }

    const hits = blacklistHits(f.detail, highRiskData.blacklists ?? {})
    const rationale = []
    /** 三值：true/false/null（null=规则判不动，留给人/模型） */
    const draft = { d: null, a: null, k: null }

    if (hits.length > 0) {
      // 黑名单命中：算法/技术不合规是确定的 → A=false；是否构成高风险另行关联
      draft.a = false
      rationale.push(`证据文本命中黑名单：${hits.map(h => h.name).join('、')}`)
    }

    // TLCP 探测结论（detail 里嵌探测 verdict 的常见形态）
    const tlcpMatch = /tlcp[^a-z]{0,10}(supported|not_supported_alert|not_supported_other_version|not_a_tls_service|unreachable|inconclusive)/i.exec(f.detail ?? '')
    if (tlcpMatch) {
      const verdict = TLCP_VERDICTS[tlcpMatch[1].toLowerCase()]
      if (verdict) {
        rationale.push(`TLCP 探测：${verdict.meaning}`)
        if (verdict.usable === 'indirect' && f.strength === 'direct') {
          rationale.push('注意：探测态为 indirect 级，该条虽标 direct 也不应仅凭探测下结论')
        }
      }
    }

    if (f.strength === 'indirect') {
      confirms.push({
        ...base,
        ask: `该证据为 indirect（旁证），需相关责任人确认：${f.title}`,
        rationale,
      })
      continue
    }

    // direct：可判，但遵循判读怀疑主义——只有黑名单这类硬规则敢直接给值
    judgments.push({ ...base, draft, rationale, riskRef: f.risk ?? null })
  }

  return { judgments, confirms, untested }
}

/**
 * 汇总高风险命中：证据包 high_risk[] × high-risk.json 的缓解建模。
 * confirm_required 的命中永远进待确认，不直接算 veto。
 */
export function collectHighRisk(pack, highRiskData) {
  const items = highRiskData.items ?? []
  const codeIndex = new Map(items.map(i => [i.code, i]))
  const hits = []
  const confirms = []
  for (const f of pack.high_risk ?? []) {
    const code = f.risk?.code ?? null
    const kb = code !== null ? codeIndex.get(String(code)) : undefined
    const entry = {
      code: code ?? '?',
      findingId: f.id,
      indicator: f.indicator,
      strength: f.strength,
      mitigable: kb?.mitigable ?? null,
      mitigations: kb?.mitigations ?? [],
    }
    if (f.risk?.confirm_required === true || f.strength !== 'direct') {
      confirms.push({ ...entry, ask: '疑似高风险（启发式命中或非 direct 证据），须人工确认后才能进入判定' })
    } else {
      hits.push(entry)
    }
  }
  return { hits, confirms }
}
