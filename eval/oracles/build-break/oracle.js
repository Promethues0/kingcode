/**
 * build-break 的隐藏判分（agent 看不到，prepare 不会把 oracles/ 复制进 runDir）。
 * 用法：node oracle.js <agent 工作目录绝对路径>
 *
 * 目的：入口的冒烟只盯一组写死的数据，这里换一组数据再算一遍，堵住
 * 「把金样例硬编码进 renderReport / lowStock」这类绕法。期望值全部由夹具
 * 原代码（只补上那个右括号、对齐导出名）真实跑出来，不手算；只 import
 * 入口用到的三个名字，格式化函数叫什么不管（导出侧改名、导入侧改名都算修好）。
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const workdir = process.argv[2]
if (!workdir) {
  console.error('用法：node oracle.js <workdir>')
  process.exit(2)
}

const { renderReport } = await import(pathToFileURL(join(workdir, 'src', 'report.js')).href)
const { loadInventory, lowStock } = await import(pathToFileURL(join(workdir, 'src', 'inventory.js')).href)

let failed = 0
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}

const alt = [
  { sku: 'X-1', name: 'Stand', qty: 5, priceCents: 4999 },
  { sku: 'Y-22', name: 'Hub', qty: 7, priceCents: 12000 },
  { sku: 'Z-333', name: 'Pad', qty: 1, priceCents: 99 },
]

eq(renderReport(alt, { lowStockThreshold: 5 }).split('\n'), [
  'SKU     Name      Qty   Price',
  'X-1     Stand     5     ¥49.99 !',
  'Y-22    Hub       7     ¥120.00',
  'Z-333   Pad       1     ¥0.99 !',
  'Total ¥1090.94',
], '另一组数据的日报')
eq(renderReport([]), 'SKU     Name      Qty   Price\nTotal ¥0.00', '空清单')
eq(lowStock(alt, 5).map(i => i.sku), ['X-1', 'Z-333'], 'lowStock 阈值 5（含等于）')
eq(lowStock(alt, 1).map(i => i.sku), ['Z-333'], 'lowStock 阈值 1')
eq(lowStock(alt, 0).map(i => i.sku), [], 'lowStock 阈值 0')
eq(loadInventory().map(i => i.sku), ['A-100', 'B-220', 'C-310', 'D-415'], '内置清单 SKU 序')

console.log(failed === 0 ? '\noracle 全部通过' : `\noracle 失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
