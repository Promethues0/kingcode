/**
 * 账本库的验收测试。跑法：npm test（即 node test.js）。
 * 只通过 Ledger / summarize / validateBatch 这些公开接口测行为。
 * 评测判分会校验本文件与夹具原件逐字节一致——不要改它。
 */

import { Ledger, summarize, validateBatch } from './src/index.js'

let failed = 0
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}

const ledger = new Ledger()
ledger
  .add({ account: 'cash', amount: 10 })
  .addMany([{ account: 'cash', amount: 2.5 }, { account: 'bank', amount: -1.25 }])
eq(ledger.size, 3, 'add 与 addMany 共入账 3 条')
eq(ledger.balance('cash'), 1250, 'cash 余额以分计')
eq(ledger.balance('bank'), -125, '负数金额允许')
eq(ledger.balance('nobody'), 0, '未知账户余额为 0')

eq(
  summarize([{ account: 'b', amount: 1 }, { account: 'a', amount: 2 }, { account: 'b', amount: 0.5 }]),
  { a: 200, b: 150 },
  'summarize 按账户名排序汇总',
)

eq(validateBatch([{ account: 'ok', amount: 1 }]), { ok: true, problems: [] }, '合法批次无问题')
const bad = validateBatch([{ account: 'ok', amount: 1 }, { amount: 1 }, { account: 'x', amount: 'NaN' }])
eq(bad.ok, false, '含不合法条目时 ok=false')
eq(bad.problems.length, 2, '两条不合法各报一次')
eq(bad.problems[0].includes('#1'), true, '问题信息带条目序号')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
