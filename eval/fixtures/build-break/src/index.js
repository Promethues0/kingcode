/**
 * 构建入口：生成一份日报，与金样例逐行比对，作为构建的冒烟检查。
 * 任一行不一致即构建失败（退出码 1）。金样例由本项目自身输出生成，勿手改。
 */

import { loadInventory, lowStock } from './inventory.js'
import { renderReport } from './report.js'

const GOLDEN_REPORT = [
  'SKU     Name      Qty   Price',
  'A-100   Keyboard  12    ¥259.00',
  'B-220   Mouse     0     ¥89.00 !',
  'C-310   Monitor   3     ¥1299.00 !',
  'D-415   Cable     48    ¥15.00',
  'Total ¥7725.00',
]
const GOLDEN_LOW = ['B-220', 'C-310']

const items = loadInventory()
const got = renderReport(items).split('\n')
const low = lowStock(items).map(item => item.sku)

let failed = 0
const eq = (a, b, label) => {
  if (a === b) return
  failed++
  console.error(`smoke FAIL ${label}\n  期望 ${JSON.stringify(b)}\n  实得 ${JSON.stringify(a)}`)
}

eq(got.length, GOLDEN_REPORT.length, '日报行数')
GOLDEN_REPORT.forEach((line, i) => eq(got[i], line, `日报第 ${i + 1} 行`))
eq(JSON.stringify(low), JSON.stringify(GOLDEN_LOW), '低库存清单')

if (failed > 0) {
  console.error(`\nbuild failed: smoke ${failed} 项不符`)
  process.exit(1)
}
console.log(got.join('\n'))
console.log('\nbuild ok')
