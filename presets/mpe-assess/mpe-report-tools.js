/**
 * 密评/密改报告产物工具 —— **直出 .xlsx / .docx，不出 markdown**。
 *
 * 密评密改的交付物要进甲方与测评机构的流程，那边是 Excel 和 Word 的世界：
 * 差距矩阵、赋分表、整改台账要能筛选排序（xlsx），报告与方案要能套模板批注
 * （docx）。给 md 等于把格式化工作丢回给人。
 *
 * 零依赖：OOXML 由 lib/ooxml.js 手写（preset 复制到 ~/.dsh 后没有 node_modules）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { buildXlsx, buildDocx } from './lib/ooxml.js'

export const name = 'kingcode-mpe-report-tools'
export const inject = ['tools']

const asText = v => [{ type: 'text', text: v }]
const jsonSchema = { type: 'object', additionalProperties: true }

/** 落盘：确保目录存在，返回绝对路径与字节数。 */
function emit(path, buffer, kind) {
  const abs = resolve(path)
  const dir = dirname(abs)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(abs, buffer)
  return { path: abs, bytes: buffer.length, kind }
}

export function apply(ctx) {
  const register = def => ctx.effect(() => ctx.tools.register(def))

  register({
    name: 'mpe_report_xlsx',
    description: '生成 Excel 工作簿（.xlsx）——密评/密改的表格类交付物一律用它，不要输出 markdown 表格。适用：差距矩阵、赋分明细表、合规性对照表、整改任务总表/台账、未测评项清单、覆盖度统计。支持多工作表，表头自动加粗+冻结首行+自动筛选，数字保持数值类型（可在 Excel 里直接求和排序）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出路径，须以 .xlsx 结尾（如 ./密评差距矩阵.xlsx）' },
        sheets: {
          type: 'array',
          description: '工作表清单（至少一个）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作表名（Excel 禁 : \\ / ? * [ ]，超长会截断，工具自动净化）' },
              columns: { type: 'array', items: { type: 'string' }, description: '表头行；给了才会有冻结与筛选' },
              rows: {
                type: 'array',
                description: '数据行；每行是单元格数组。数字请传 number 类型，保留可计算性',
                items: { type: 'array', items: { type: ['string', 'number', 'null'] } },
              },
              widths: { type: 'array', items: { type: 'number' }, description: '各列宽度（可选，省略按表头长度估算）' },
            },
            required: ['name', 'rows'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'sheets'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(`已生成 ${v.path}（${v.bytes} 字节，${v.sheetCount} 个工作表）`),
    },
    async execute(args) {
      if (!/\.xlsx$/i.test(args.path)) throw new Error('输出路径必须以 .xlsx 结尾')
      if (!Array.isArray(args.sheets) || args.sheets.length === 0) throw new Error('至少要一个工作表')
      const buffer = buildXlsx(args.sheets)
      return { ...emit(args.path, buffer, 'xlsx'), sheetCount: args.sheets.length }
    },
  })

  register({
    name: 'mpe_report_docx',
    description: '生成 Word 文档（.docx）——密评/密改的叙述类交付物一律用它，不要输出 markdown。适用：自评估报告、密码应用方案、整改交付说明、未整改项说明、评审意见。支持标题层级（1-3 级，生成真正的 Word 标题样式可自动生成目录）、段落（\\n 换行）、表格（首行表头加粗带底色、全边框）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出路径，须以 .docx 结尾（如 ./密评自评估报告.docx）' },
        blocks: {
          type: 'array',
          description: '文档内容块，按顺序渲染',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'table'] },
              text: { type: 'string', description: 'heading/paragraph 的文字；段落内 \\n 渲染为换行' },
              level: { type: 'integer', minimum: 1, maximum: 3, description: 'heading 的层级' },
              columns: { type: 'array', items: { type: 'string' }, description: 'table 的表头' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'table 的数据行' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'blocks'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(`已生成 ${v.path}（${v.bytes} 字节，${v.blockCount} 个内容块）`),
    },
    async execute(args) {
      if (!/\.docx$/i.test(args.path)) throw new Error('输出路径必须以 .docx 结尾')
      if (!Array.isArray(args.blocks) || args.blocks.length === 0) throw new Error('文档至少要一个内容块')
      const buffer = buildDocx(args.blocks)
      return { ...emit(args.path, buffer, 'docx'), blockCount: args.blocks.length }
    },
  })
}
