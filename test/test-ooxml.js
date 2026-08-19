/**
 * OOXML 生成器测试：ZIP 结构 + 工作表/文档语义 + 报告工具端到端。
 *
 * 注意：本文件只做**结构级**自检（zip 目录、XML 片段、字节头）。
 * 真正的「Excel/Word 能不能打开」由 test/verify-ooxml.py 用 openpyxl 与
 * python-docx 独立回读校验——自己生成自己解析等于自证，不算数。
 *
 * 跑法：node test/test-ooxml.js
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zip, buildXlsx, buildDocx, xmlEscape, colLetter, sheetName } from '../presets/mpe-assess/lib/ooxml.js'
import * as reportPlugin from '../presets/mpe-assess/mpe-report-tools.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)

// ── 基础工具 ────────────────────────────────────────────────────────────────
eq(colLetter(1), 'A', 'colLetter 1→A')
eq(colLetter(26), 'Z', 'colLetter 26→Z')
eq(colLetter(27), 'AA', 'colLetter 27→AA')
eq(colLetter(52), 'AZ', 'colLetter 52→AZ')
eq(xmlEscape('a<b>&"c"\'d\''), 'a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;', 'XML 五类实体转义')
eq(xmlEscape('含控制字符'), '含控制字符', '控制字符被剔除（否则 Excel 判文件损坏）')
eq(sheetName('高风险/清单:非法*字符'), '高风险_清单_非法_字符', '工作表名非法字符净化')
eq(sheetName(''), 'Sheet1', '空表名回退')
eq(sheetName('x'.repeat(40)).length, 31, '表名超长截断到 31')

// ── ZIP 结构 ────────────────────────────────────────────────────────────────
{
  const buf = zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: Buffer.from('world') }])
  eq(buf.readUInt32LE(0), 0x04034b50, 'ZIP 以本地文件头签名开头')
  // EOCD 在末尾 22 字节
  const eocdOffset = buf.length - 22
  eq(buf.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD 签名')
  eq(buf.readUInt16LE(eocdOffset + 10), 2, 'EOCD 记录条目数=2')
  check(buf.includes(Buffer.from('dir/b.txt')), '文件名写入')
}

// ── XLSX ────────────────────────────────────────────────────────────────────
{
  const buf = buildXlsx([{ name: '表一', columns: ['甲', '乙'], rows: [['x', 1], ['y', 2.5]] }])
  const text = buf.toString('latin1')
  check(text.includes('[Content_Types].xml'), 'xlsx 含 Content_Types')
  check(text.includes('xl/worksheets/sheet1.xml'), 'xlsx 含 sheet1')
  check(text.includes('xl/styles.xml'), 'xlsx 含 styles')
  check((() => { try { buildXlsx([]) } catch { return true } return false })(), '空工作表列表被拒')
}

// ── DOCX ────────────────────────────────────────────────────────────────────
{
  const buf = buildDocx([{ type: 'heading', level: 1, text: '标题' }, { type: 'paragraph', text: '正文' }])
  const text = buf.toString('latin1')
  check(text.includes('word/document.xml'), 'docx 含 document.xml')
  check(text.includes('word/styles.xml'), 'docx 含 styles.xml')
}

// ── 报告工具端到端 ──────────────────────────────────────────────────────────
{
  const tools = new Map()
  reportPlugin.apply({ effect: fn => fn(), tools: { register: d => tools.set(d.name, d) } })
  eq(tools.size, 2, '注册 2 个报告工具')
  check(tools.has('mpe_report_xlsx') && tools.has('mpe_report_docx'), '两个工具名正确')

  const dir = mkdtempSync(join(tmpdir(), 'kc-ooxml-'))
  try {
    const xp = join(dir, 'sub', '差距矩阵.xlsx')   // 故意带不存在的子目录
    const r1 = await tools.get('mpe_report_xlsx').execute({
      path: xp,
      sheets: [{ name: '差距矩阵', columns: ['指标', '判定'], rows: [['A', '不符合']] }],
    })
    check(r1.bytes > 0 && r1.sheetCount === 1, 'xlsx 工具产出非空', `${r1.bytes}B`)
    check(readFileSync(xp).readUInt32LE(0) === 0x04034b50, 'xlsx 落盘且为合法 zip')

    const dp = join(dir, '报告.docx')
    const r2 = await tools.get('mpe_report_docx').execute({
      path: dp,
      blocks: [{ type: 'heading', level: 1, text: 'T' }, { type: 'table', columns: ['a'], rows: [['b']] }],
    })
    check(r2.bytes > 0 && r2.blockCount === 2, 'docx 工具产出非空', `${r2.bytes}B`)

    let badExt = false
    try { await tools.get('mpe_report_xlsx').execute({ path: join(dir, 'x.md'), sheets: [{ name: 's', rows: [] }] }) } catch { badExt = true }
    check(badExt, '拒绝非 .xlsx 扩展名（不许退回 md）')
    let badExt2 = false
    try { await tools.get('mpe_report_docx').execute({ path: join(dir, 'x.md'), blocks: [{ type: 'paragraph', text: 'x' }] }) } catch { badExt2 = true }
    check(badExt2, '拒绝非 .docx 扩展名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
