/**
 * 密评评估工具插件 —— 六个 mpe_* 工具。
 *
 * 刻意零 @deepseek-ai import：本文件会随 preset 目录被复制到
 * ~/.dsh/.agent-presets/（那里没有 node_modules），ctx.tools.register()
 * 接受裸 JSON-Schema ToolDefinition，无需 defineTool。
 *
 * 设计准则（对安小龙教训的直接回应）：确定性工作——查表、算分、判定映射、
 * 覆盖度统计——全部在这里完成并返回规范 JSON；模型只负责方法论、追问与叙事。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeKb } from './lib/kb.js'
import { parseEvidence, coverage, checkSummaryMd } from './lib/evidence.js'
import { prejudge, collectHighRisk } from './lib/judge.js'
import { totalScore } from './lib/score.js'

export const name = 'kingcode-mpe-tools'
export const inject = ['tools']

const DATA_DIR = fileURLToPath(new URL('data/', import.meta.url))

let cache = null
/** 懒加载三份知识数据；缺文件时给出可行动的报错而不是栈。 */
function loadData() {
  if (cache) return cache
  const load = file => {
    try {
      return JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'))
    } catch (error) {
      throw new Error(`知识数据 ${file} 不可用（${error.message}）。请确认 preset 完整安装（data/ 目录随目录复制）。`)
    }
  }
  const indicators = load('indicators.json')
  const highRisk = load('high-risk.json')
  const scoring = load('scoring.json')
  const faq = load('faq.json')
  cache = { indicators, highRisk, scoring, faq, kb: makeKb({ indicators, highRisk, faq }) }
  return cache
}

/** 读取证据包文件（明细 json 或摘要 md）。 */
function loadEvidenceFile(path) {
  const abs = resolve(path)
  const text = readFileSync(abs, 'utf8')
  if (abs.endsWith('.md')) return { kind: 'summary', abs, text }
  return { kind: 'detail', abs, text }
}

const asText = value => [{ type: 'text', text: value }]
const jsonSchema = { type: 'object', additionalProperties: true }

/**
 * @param {object} ctx - dsh 插件上下文。
 */
export function apply(ctx) {
  const register = def => ctx.effect(() => ctx.tools.register(def))

  register({
    name: 'mpe_kb_indicator',
    description: '查询 GB/T 39786 密评指标：按指标名（可模糊）、条款号或 id 检索，返回各级助动词（应/宜/可）、条款号、量化权重、高风险关联与取证要点。传 level 时附带该级的明确要求。判定任何指标前先查这里，不要凭记忆背标准。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '指标名、条款号（如 8.2a）或指标 id' },
        level: { type: 'integer', minimum: 1, maximum: 4, description: '被测系统的密码应用等级（1-4）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        value.matches.length === 0
          ? '未命中任何指标（查询词换个写法再试，或用 mpe_kb_faq 查口径）'
          : value.matches.map(m => `${m.indicator}（${m.layer}）${m.atLevel ? ` 第${m.atLevel.level}级:${m.atLevel.modal ?? '无要求'} ${m.atLevel.clause ?? ''} 权重:${m.atLevel.weight ?? '—'}` : ''}`).join('\n'),
      ),
    },
    async execute(args) {
      return loadData().kb.findIndicator({ query: args.query, level: args.level ?? null })
    },
  })

  register({
    name: 'mpe_kb_high_risk',
    description: '查询密评高风险判定项：不传 code 返回 16 项总表+8 条无缓解死条款+算法/协议黑名单+密钥管理 7 类严重隐患；传 code（如 9.3）返回该项的安全问题、缓解措施与覆盖条件。高风险是与分数并列的一票否决闸，先筛高风险再算分。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '高风险编号，如 5.2、9.3；省略则返回总表' },
      },
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (args, value) => asText(
        args.code
          ? (value.item ? `${value.item.code} ${value.item.indicator}：${value.item.mitigable ? '有缓解路径' : '⚠️ 无缓解措施（死条款）'}` : `未找到编号 ${args.code}`)
          : `16 项高风险；无缓解死条款：${value.noMitigationCodes.join('、')}`,
      ),
    },
    async execute(args) {
      const kb = loadData().kb
      if (args.code) return { item: kb.getHighRisk(args.code) }
      return kb.listHighRisk()
    },
  })

  register({
    name: 'mpe_kb_faq',
    description: '检索密评 FAQ 口径库（含十条红线、标准版本对照、可算法化判定谓词）。命中「公开材料无权威口径」清单时会明确告知——这类问题必须回答查不到，不许编数字（如具体阈值分数、整改期限天数）。引用 FAQ 口径须带「仅供参考」限定。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔多个' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        (value.noAnswerHits.length > 0 ? `⚠️ 命中无权威口径清单：${value.noAnswerHits.join('；')}\n` : '')
        + (value.matches.length === 0 ? '无匹配 FAQ' : value.matches.map(m => `[${m.source}] ${m.question}`).join('\n')),
      ),
    },
    async execute(args) {
      return loadData().kb.searchFaq(args.query)
    },
  })

  register({
    name: 'mpe_evidence_load',
    description: '读取并校验密评证据包（mpe-collect 采集器产物）：传明细 .json 路径（首选，无大小限制）或摘要 .md 路径（降级）。返回 schema 校验结果、审计红线检查（写操作/外联必须为 0）、覆盖度统计（各层面×四种证据强度、可判/待确认/未测评三分）。拿到证据包路径后第一步就调它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '证据包文件的绝对或相对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        value.kind === 'summary'
          ? `摘要模式（判定能力受限，建议要明细 json）：${value.summary.chars} 字符，问题 ${value.summary.problems.length} 条`
          : `证据包 ${value.coverage.findingsTotal} 条：可判 ${value.coverage.judgeable} / 待确认 ${value.coverage.needConfirm} / 未测评 ${value.coverage.untested}；高风险 ${value.coverage.highRiskCount}；人工填报 ${value.coverage.manualRequiredCount}${value.problems.length > 0 ? `；⚠️ 校验问题 ${value.problems.length} 条` : ''}`,
      ),
    },
    async execute(args) {
      const file = loadEvidenceFile(args.path)
      if (file.kind === 'summary') {
        return { kind: 'summary', path: file.abs, summary: checkSummaryMd(file.text) }
      }
      const { pack, problems } = parseEvidence(file.text)
      return { kind: 'detail', path: file.abs, problems, coverage: coverage(pack) }
    },
  })

  register({
    name: 'mpe_judge',
    description: '对证据包做确定性 D/A/K 预判：算法/协议黑名单直判、TLCP 探测六态映射、证据强度四态路由（direct 可判 / indirect 进待确认 / no_permission·out_of_scope 进未测评）。规则判不动的字段留 null 并输出「待确认清单（要谁确认什么）」——预判绝不越权下结论。输入明细 json 路径。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '明细 .json 路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        `预判 ${value.judgments.length} 条（其中黑名单直判 A=× 的 ${value.judgments.filter(j => j.draft.a === false).length} 条）；待确认 ${value.confirms.length}；未测评 ${value.untested.length}；高风险确定命中 ${value.highRisk.hits.length}、待人工确认 ${value.highRisk.confirms.length}`,
      ),
    },
    async execute(args) {
      const file = loadEvidenceFile(args.path)
      if (file.kind === 'summary') throw new Error('预判需要明细 .json（摘要缺结构化字段）')
      const { pack } = parseEvidence(file.text)
      const data = loadData()
      const pre = prejudge(pack.findings ?? [], data.highRisk)
      const highRisk = collectHighRisk(pack, data.highRisk)
      return { ...pre, highRisk }
    },
  })

  register({
    name: 'mpe_score',
    description: '四级量化算分（GB/T 39786 配套规则口径）：输入逐指标 D/A/K 判定结果，输出对象分→单元分→层面分→总分的完整可复核计算过程、未测评上下界四数（S_min/S_max/已测评得分/未测评占比）、高风险一票否决检查与结论。指标权重可省略——按指标名+等级自动从指标库查。禁止绕过本工具手算加权平均。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'integer', minimum: 1, maximum: 4, description: '被测系统等级，用于自动查指标权重' },
        items: {
          type: 'array',
          description: '逐指标判定结果',
          items: {
            type: 'object',
            properties: {
              indicator: { type: 'string', description: '指标名（用于自动查权重，需与指标库一致）' },
              layer: { type: 'string', description: '标准层面名（逐字）' },
              status: { type: 'string', enum: ['applicable', 'not_applicable', 'untested'] },
              naReason: { type: 'string', description: 'not_applicable 时必填论证理由' },
              weight: { type: 'number', description: '手动指定权重（省略则按 indicator+level 查库）' },
              objects: {
                type: 'array',
                description: '技术侧各测评对象的 D/A/K 取值',
                items: {
                  type: 'object',
                  properties: { d: { type: 'boolean' }, a: { type: 'boolean' }, k: { type: 'boolean' } },
                  required: ['d', 'a', 'k'],
                  additionalProperties: false,
                },
              },
              mgmt: { type: 'number', enum: [0, 0.5, 1], description: '管理侧单元分（与 objects 二选一）' },
            },
            required: ['indicator', 'layer', 'status'],
            additionalProperties: false,
          },
        },
        highRisk: {
          type: 'array',
          description: '高风险命中清单（经人工确认后的）',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              mitigated: { type: 'boolean', description: '缓解措施是否已落实并覆盖全部安全问题' },
            },
            required: ['code', 'mitigated'],
            additionalProperties: false,
          },
        },
      },
      required: ['level', 'items'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        value.anyUntested
          ? `得分区间 [${value.totalMin}, ${value.totalMax}]（存在未测评项）→ ${value.conclusion.verdict}：${value.conclusion.reason}`
          : `总分 ${value.total} → ${value.conclusion.verdict}：${value.conclusion.reason}`,
      ),
    },
    async execute(args) {
      const data = loadData()
      const byLayer = {}
      const missingWeights = []
      for (const item of args.items) {
        let weight = item.weight
        if (weight === undefined) {
          const found = data.kb.findIndicator({ query: item.indicator, level: args.level })
          weight = found.matches[0]?.atLevel?.weight ?? null
          if (weight === null && item.status === 'applicable') {
            missingWeights.push(item.indicator)
          }
        }
        ;(byLayer[item.layer] ??= []).push({ ...item, weight })
      }
      if (missingWeights.length > 0) {
        throw new Error(`以下指标在指标库查不到第${args.level}级权重，请核对指标名或手动给 weight：${missingWeights.join('、')}`)
      }
      return totalScore(byLayer, data.scoring, args.highRisk ?? [])
    },
  })
}
