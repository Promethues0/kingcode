/**
 * 密改执行工具插件 —— 四个 mpe_* 工具（与 mpe-tools.js 同准则：
 * 零 @deepseek-ai import、裸 schema register、确定性工作全在工具里）。
 *
 * mpe_diff      改造前后证据包对比（可比性四校验 + 三元组配对 + 七行判定表）
 * mpe_ledger    整改台账（五状态机 + diff 回填 + 报表；显式文件持久化）
 * mpe_remediate 整改优先级排序 + KB6 措施推荐
 * mpe_kb_plan   密码应用方案模板/自检清单/0054 映射查询（KB5）
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvidence } from './lib/evidence.js'
import { diffPacks } from './lib/diff.js'
import { createLedger, addTask, transition, applyDiff, report } from './lib/ledger.js'
import { prioritize, suggestMeasures } from './lib/remediate.js'

export const name = 'kingcode-mpe-remediate-tools'
export const inject = ['tools']

const DATA_DIR = fileURLToPath(new URL('data/', import.meta.url))

let cache = null
function loadData() {
  if (cache) return cache
  const load = file => {
    try {
      return JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'))
    } catch (error) {
      throw new Error(`知识数据 ${file} 不可用（${error.message}）。请确认 preset 完整安装。`)
    }
  }
  cache = {
    scoring: load('scoring.json'),
    measures: load('measures.json'),
    plan: load('plan-template.json'),
  }
  return cache
}

const loadPack = path => {
  const { pack, problems } = parseEvidence(readFileSync(resolve(path), 'utf8'))
  return { pack, problems }
}

/** 台账文件读写：显式路径、原子写、schema 校验。 */
function readLedger(path) {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`台账文件不存在：${abs}（先用 action=init 创建）`)
  const ledger = JSON.parse(readFileSync(abs, 'utf8'))
  if (ledger.schema !== 'kingcode-mpe-ledger/1') {
    throw new Error(`不是 KingCode 整改台账（schema=${ledger.schema}）`)
  }
  return ledger
}
function writeLedger(path, ledger) {
  const abs = resolve(path)
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n')
  renameSync(tmp, abs)
}

const asText = value => [{ type: 'text', text: value }]
const jsonSchema = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  const register = def => ctx.effect(() => ctx.tools.register(def))

  register({
    name: 'mpe_diff',
    description: '改造前后证据包对比（密改闭环的技术核心）：先做可比性四校验（同机/同采集器版本/同运行身份/同探测口径+时序），不可比就直说不硬凑；通过后按 (层面+指标+标题) 三元组配对（绝不用条目 id——跨运行无稳定含义），逐条给七行判定表结论；高风险差集只认方向（基线有复采无=消除；复采有基线无=改造引入新问题，事故级报警）。输入基线包与复采包的明细 .json 路径。',
    parameters: {
      type: 'object',
      properties: {
        baselinePath: { type: 'string', description: '基线包（改造前，S3 原文中的 B 包）明细 .json 路径' },
        afterPath: { type: 'string', description: '复采包（改造后，S3 原文中的 A 包）明细 .json 路径' },
      },
      required: ['baselinePath', 'afterPath'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        !value.comparability.comparable
          ? `❌ 不可比：${value.comparability.checks.filter(c => !c.pass).map(c => c.name).join('、')}——${value.note}`
          : `可比。生效 ${value.stats.effective} / 变化待审 ${value.stats.changedNeedsReview} / 没改动 ${value.stats.noChange} / 待确认 ${value.stats.needsConfirm} / 未测评 ${value.stats.untested} / 新条目 ${value.stats.newEntries}${value.highRisk.alarm ? `\n${value.highRisk.alarm}` : ''}${value.untestedRegression ? `\n⚠️ ${value.untestedRegression}` : ''}`,
      ),
    },
    async execute(args) {
      const baseline = loadPack(args.baselinePath)
      const after = loadPack(args.afterPath)
      const result = diffPacks(baseline.pack, after.pack)
      return { ...result, packProblems: { baseline: baseline.problems, after: after.problems } }
    },
  })

  register({
    name: 'mpe_ledger',
    description: '整改台账（贯穿密改全程的唯一事实源，JSON 文件显式持久化）。action：init 建账 / add 建任务（11 字段，verifyPath 三选一：复采可验|复采可提示|复采够不到）/ update 状态迁移（五状态：未开始|进行中|待取证|已闭环|不整改；不整改必须给理由与决策人，闭环必须证据非空）/ apply_diff 把 mpe_diff 结论批量回填（涉及 no_permission/indirect/out_of_scope 一律停在待取证）/ report 出闭环率+批次进度+阻塞项。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'add', 'update', 'apply_diff', 'report'] },
        path: { type: 'string', description: '台账 JSON 文件路径（如工作区内 mpe-ledger.json）' },
        meta: { type: 'object', additionalProperties: true, description: 'init：台账元信息（系统名/等级等）' },
        task: { type: 'object', additionalProperties: true, description: 'add：任务字段（id 必填；indicator/current/target/remedy/systems/owner/risk/verifyPath/evidenceForm/due/batch）' },
        taskId: { type: 'string', description: 'update：任务编号' },
        state: { type: 'string', enum: ['未开始', '进行中', '待取证', '已闭环', '不整改'], description: 'update：目标状态' },
        note: { type: 'string', description: 'update：说明（不整改时为必填理由）' },
        decider: { type: 'string', description: 'update：不整改的决策人' },
        evidence: { type: 'string', description: 'update：证据（写基线/复采采集时间+具体条目，不要只写「已核对」）' },
        outcomes: {
          type: 'array',
          description: 'apply_diff：mpe_diff 结论清单',
          items: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              verdict: { type: 'string', description: 'mpe_diff 的 verdict 枚举' },
              evidenceNote: { type: 'string' },
              paperworkDone: { type: 'boolean', description: '书面证据（变更单/证书/密钥记录）是否已交' },
            },
            required: ['taskId', 'verdict'],
            additionalProperties: false,
          },
        },
      },
      required: ['action', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (args, value) => asText(
        args.action === 'report'
          ? `闭环率 ${value.report.closureRate ?? '—'}%（${value.report.closed}/${value.report.total}，不整改 ${value.report.waived}）；阻塞 ${value.report.blockers.length} 项${value.report.blockers[0] ? `，最久：${value.report.blockers[0].id} 卡在 ${value.report.blockers[0].owner ?? '?'} ${value.report.blockers[0].stuckDays ?? '?'} 天` : ''}`
          : `${args.action} 完成（${value.taskCount} 个任务）`,
      ),
    },
    async execute(args) {
      if (args.action === 'init') {
        if (existsSync(resolve(args.path))) throw new Error(`台账已存在：${args.path}（避免覆盖，换路径或直接使用）`)
        const ledger = createLedger(args.meta ?? {})
        writeLedger(args.path, ledger)
        return { taskCount: 0, path: resolve(args.path) }
      }
      const ledger = readLedger(args.path)
      if (args.action === 'add') {
        if (!args.task) throw new Error('add 需要 task')
        const task = addTask(ledger, args.task)
        writeLedger(args.path, ledger)
        return { taskCount: ledger.tasks.length, added: task.id, missingFields: task.missingFields }
      }
      if (args.action === 'update') {
        if (!args.taskId || !args.state) throw new Error('update 需要 taskId 与 state')
        const task = transition(ledger, args.taskId, args.state, {
          note: args.note, decider: args.decider, evidence: args.evidence,
        })
        writeLedger(args.path, ledger)
        return { taskCount: ledger.tasks.length, taskId: task.id, state: task.state }
      }
      if (args.action === 'apply_diff') {
        if (!args.outcomes) throw new Error('apply_diff 需要 outcomes')
        const applied = applyDiff(ledger, args.outcomes)
        writeLedger(args.path, ledger)
        return { taskCount: ledger.tasks.length, applied }
      }
      if (args.action === 'report') {
        return { taskCount: ledger.tasks.length, report: report(ledger) }
      }
      throw new Error(`不认识的 action：${args.action}`)
    },
  })

  register({
    name: 'mpe_remediate',
    description: '整改优先级排序（S3 五级排序法，禁「好改的先改」：高风险恒第一批→按提分效率=层面权重×指标权重×缺口→配置快赢→长周期项单独立项旗标→管理类并行）+ KB6 整改措施推荐（症状→方案→验证方法→坑）。输入差距清单，输出分批计划。',
    parameters: {
      type: 'object',
      properties: {
        gaps: {
          type: 'array',
          description: '差距清单（来自评估结论或测评不符合项）',
          items: {
            type: 'object',
            properties: {
              indicator: { type: 'string' },
              layer: { type: 'string', description: '标准层面名（逐字）' },
              isHighRisk: { type: 'boolean' },
              weight: { type: 'number', description: '指标权重（可从 mpe_kb_indicator 查）' },
              unitScore: { type: 'number', description: '当前单元分 0~1，缺省按 0' },
              kind: { type: 'string', enum: ['config', 'long', 'mgmt', 'other'], description: '任务性质（配置快赢/长周期/管理类）' },
            },
            required: ['indicator', 'layer'],
            additionalProperties: false,
          },
        },
        measureQuery: { type: 'string', description: '可选：按指标名或症状查 KB6 整改措施' },
      },
      required: ['gaps'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_args, value) => asText(
        value.batches.map(b => `${b.name}：${b.items.length} 项`).join('；')
        + (value.flags.length > 0 ? `\n${value.flags.join('\n')}` : '')
        + (value.measures && value.measures.matches.length > 0 ? `\n措施命中 ${value.measures.matches.length} 条` : ''),
      ),
    },
    async execute(args) {
      const data = loadData()
      const result = prioritize(args.gaps, data.scoring)
      if (args.measureQuery) {
        result.measures = suggestMeasures(args.measureQuery, data.measures)
      }
      return result
    },
  })

  register({
    name: 'mpe_kb_plan',
    description: '密码应用方案知识查询（KB5）：section=chapters 章节树与每章要点 / lint 送审自检 15 条（对照表禁止出现「不符合」等硬规则）/ elements 八要素 / legacy GM/T 0054→GB/T 39786 指标映射 / gov 政务流程门槛。写方案、审方案、老方案迁移前先查这里。',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['chapters', 'lint', 'elements', 'legacy', 'gov', 'layout'] },
      },
      required: ['section'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (args, value) => asText(`KB5 ${args.section}：${JSON.stringify(value).length} 字符（规范值见结构化返回）`),
    },
    async execute(args) {
      const plan = loadData().plan
      switch (args.section) {
        case 'chapters': return { chapters: plan.chapters, complianceTable: plan.compliance_table }
        case 'lint': return { checklist: plan.lint_checklist, complianceTable: plan.compliance_table }
        case 'elements': return { eightElements: plan.eight_elements }
        case 'legacy': return { mapping: plan.legacy_mapping }
        case 'gov': return { govProcess: plan.gov_process }
        case 'layout': return { layoutRequirements: plan.layout_requirements }
        default: throw new Error(`不认识的 section：${args.section}`)
      }
    },
  })
}
