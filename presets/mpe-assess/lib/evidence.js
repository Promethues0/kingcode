/**
 * mpe-evidence/1.0 证据包读取器 —— 契约以《证据包规范.md》为准。
 *
 * 安小龙时代只能让用户把 ≤8000 字的摘要贴进对话（明细 json 禁止贴入）；
 * dsh 里工具直接读整份明细 json，摘要的截断检查、分批采集那套上下文管控
 * 全部消解。但**证据强度四态铁律不变**：direct 可判 / indirect 只提示 /
 * no_permission 与 out_of_scope 一律「未测评」。
 */

const SCHEMA_PREFIX = 'mpe-evidence/'
const SUPPORTED_MAJOR = 1

export const STRENGTHS = ['direct', 'indirect', 'no_permission', 'out_of_scope']

/** 标准四技术层面 + 管理四方面（逐字，与采集器 LAYER_* 常量一致）。 */
export const LAYERS = [
  '物理和环境安全', '网络和通信安全', '设备和计算安全', '应用和数据安全',
  '管理制度', '人员管理', '建设运行', '应急处置', '密钥管理', '通用要求',
]

/**
 * 解析并校验证据包明细 json。
 * @param {string} text - 明细 .json 文件内容。
 * @returns {{pack:object, problems:string[]}} problems 非空不代表不可用——
 *   规范允许降级项，但 major 版本不识别是硬错误（直接 throw）。
 */
export function parseEvidence(text) {
  let pack
  try {
    pack = JSON.parse(text)
  } catch (error) {
    throw new Error(`明细文件不是合法 JSON：${error.message}`)
  }

  const schema = String(pack.schema ?? '')
  if (!schema.startsWith(SCHEMA_PREFIX)) {
    throw new Error(`schema 字段不是 mpe-evidence 系（得到 ${JSON.stringify(pack.schema)}）`)
  }
  const major = Number.parseInt(schema.slice(SCHEMA_PREFIX.length), 10)
  if (major !== SUPPORTED_MAJOR) {
    // 规范原文：major 不认识必须停，不许猜
    throw new Error(`证据包 schema 主版本 ${major} 不受支持（当前只认 ${SUPPORTED_MAJOR}），按规范必须停止处理`)
  }

  const problems = []
  for (const key of ['collector', 'standard', 'collection', 'findings', 'manual_required', 'audit']) {
    if (pack[key] === undefined) problems.push(`缺少顶层字段 ${key}`)
  }

  const findings = Array.isArray(pack.findings) ? pack.findings : []
  findings.forEach((f, i) => {
    if (!STRENGTHS.includes(f.strength)) {
      problems.push(`findings[${i}](${f.id ?? '?'}) 的 strength=${JSON.stringify(f.strength)} 不在四态枚举内`)
    }
    for (const field of ['layer', 'indicator', 'clause', 'title']) {
      if (typeof f[field] !== 'string' || f[field] === '') {
        problems.push(`findings[${i}](${f.id ?? '?'}) 缺字段 ${field}`)
      }
    }
  })

  // 审计红线：对被测系统的写操作与对第三方的外联都必须为 0
  const auditSummary = pack.audit?.summary
  if (auditSummary) {
    if ((auditSummary.write_operations_on_target_system ?? 0) !== 0) {
      problems.push(`审计红线：write_operations_on_target_system=${auditSummary.write_operations_on_target_system}（必须为 0）`)
    }
    if ((auditSummary.outbound_connections_to_third_parties ?? 0) !== 0) {
      problems.push(`审计红线：outbound_connections_to_third_parties=${auditSummary.outbound_connections_to_third_parties}（必须为 0）`)
    }
  }

  return { pack, problems }
}

/**
 * 覆盖度统计（S1 阶段5 的「六组必写数字」在 dsh 里变成一次调用）。
 */
export function coverage(pack) {
  const findings = pack.findings ?? []
  const byStrength = Object.fromEntries(STRENGTHS.map(s => [s, 0]))
  const byLayer = {}
  for (const f of findings) {
    if (byStrength[f.strength] !== undefined) byStrength[f.strength] += 1
    byLayer[f.layer] = (byLayer[f.layer] ?? 0) + 1
  }
  const probeEnabled = pack.collection?.probe_enabled ?? false
  return {
    findingsTotal: findings.length,
    byStrength,
    byLayer,
    highRiskCount: (pack.high_risk ?? []).length,
    manualRequiredCount: (pack.manual_required ?? []).length,
    dryRun: pack.collection?.dry_run ?? null,
    probeEnabled,
    // 判定基础：direct 才可判，indirect 要人工确认，其余是未测评
    judgeable: byStrength.direct,
    needConfirm: byStrength.indirect,
    untested: byStrength.no_permission + byStrength.out_of_scope,
    hostSummary: pack.domains?.host
      ? {
          hostname: pack.domains.host.hostname ?? null,
          os: pack.domains.host.os_pretty_name ?? pack.domains.host.system ?? null,
          isRoot: pack.domains.host.is_root ?? null,
        }
      : null,
  }
}

/**
 * 摘要 .md 完整性检查（用户只有摘要没有明细时的降级路径）。
 * 三个不可砍章节 + 末尾哨兵；缺明细时判定能力受限的事实要如实告知。
 */
export function checkSummaryMd(text) {
  const problems = []
  const mustHaveSections = ['0.', '1.', '10.']
  for (const sec of mustHaveSections) {
    // 匹配 "## 0." 或 "# 0." 或行首 "0."
    const re = new RegExp(`^#{0,3}\\s*${sec.replace('.', '\\.')}`, 'm')
    if (!re.test(text)) problems.push(`缺少不可砍章节 ${sec}（采集元信息/高风险预警/够不到清单 三节永不可砍）`)
  }
  if (text.length > 8000) problems.push(`摘要 ${text.length} 字符超过规范硬上限 8000`)
  const truncated = /已截断\s*\d+\s*条/.test(text)
  // 末尾免责/口径行是完整性哨兵：文件被半截粘贴时它会消失
  const sentinel = /免责|口径|本摘要由/.test(text.slice(-500))
  if (!sentinel && !truncated) {
    problems.push('末尾未见免责/口径哨兵行——摘要可能被截断粘贴，建议改用明细 json')
  }
  return { problems, truncated, chars: text.length }
}
