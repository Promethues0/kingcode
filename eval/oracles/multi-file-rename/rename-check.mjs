/**
 * multi-file-rename 的隐藏判分用例（agent 看不到；判分时复制进工作目录副本再跑）。
 *
 * 两件事：① 新名在每个模块里都到位、旧名在任何模块的导出里都不再出现（含默认导出
 * 对象的键）；② 行为一个字没变——期望值是从夹具原件的实现跑出来的金样例，不手算。
 *
 * RENAME_OLD / RENAME_NEW 只给判分器自检用（拿原件、NEW=OLD 跑一遍应全绿）；
 * 正式判分用默认值。
 */

import * as entry from './src/entry.js'
import * as api from './src/index.js'
import * as ledgerMod from './src/ledger.js'
import * as reportMod from './src/report.js'
import * as validateMod from './src/validate.js'

const OLD = process.env.RENAME_OLD ?? 'normalizeEntry'
const NEW = process.env.RENAME_NEW ?? 'toLedgerEntry'
const renamed = OLD !== NEW

let failed = 0
let total = 0
const check = (ok, label) => {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
}
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  total++
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}
const throws = (fn, Ctor, label) => {
  let got = null
  try { fn() } catch (e) { got = e }
  check(got instanceof Ctor, `${label}（期望抛 ${Ctor.name}，实得 ${got ? got.constructor.name + ': ' + got.message : '未抛错'}）`)
}

// ── ① 名字到位 ──────────────────────────────────────────────────────────────
check(typeof entry[NEW] === 'function', `entry.js 导出 ${NEW}`)
check(typeof api[NEW] === 'function', `index.js 具名导出 ${NEW}`)
check(api[NEW] === entry[NEW], `index.js 的 ${NEW} 就是 entry.js 那一个`)
check(api.default !== null && typeof api.default === 'object', 'index.js 仍有默认导出对象')
check(typeof api.default?.[NEW] === 'function', `默认导出对象含键 ${NEW}`)
if (renamed) {
  for (const [name, mod] of [['entry.js', entry], ['index.js', api], ['ledger.js', ledgerMod], ['report.js', reportMod], ['validate.js', validateMod]]) {
    check(!(OLD in mod), `${name} 不再导出旧名 ${OLD}`)
  }
  check(!(api.default && OLD in api.default), `默认导出对象不再有键 ${OLD}`)
}
for (const [name, mod, key] of [['ledger.js', ledgerMod, 'Ledger'], ['report.js', reportMod, 'summarize'], ['validate.js', validateMod, 'validateBatch']]) {
  check(typeof mod[key] === 'function', `${name} 的 ${key} 仍在`)
  check(api[key] === mod[key], `index.js 再导出的 ${key} 与源模块一致`)
}

// ── ② 行为不变（金样例来自原件实现）─────────────────────────────────────────
if (typeof entry[NEW] !== 'function') {
  check(false, `${NEW} 不是函数，行为用例整体跳过`)
  console.log(`\n失败 ${failed} 项（共 ${total} 项）`)
  process.exit(1)
}
const fn = entry[NEW]
eq(fn({ account: ' cash ', amount: 12.34 }), { account: 'cash', cents: 1234, note: '' }, '账户去空白、金额换算成分、note 默认空串')
eq(fn({ account: 'bank', amount: '3.10', note: 42 }), { account: 'bank', cents: 310, note: '42' }, '字符串金额可解析、note 转字符串')
eq(fn({ account: 'x', amount: -0.07, note: null }), { account: 'x', cents: -7, note: '' }, '负数金额、null note')
throws(() => fn(null), TypeError, '非对象入参')
throws(() => fn('cash'), TypeError, '字符串入参')
throws(() => fn({ amount: 1 }), RangeError, '缺 account')
throws(() => fn({ account: '   ', amount: 1 }), RangeError, 'account 全空白')
throws(() => fn({ account: 'x', amount: 'abc' }), RangeError, 'amount 不是数')
throws(() => fn({ account: 'x', amount: Infinity }), RangeError, 'amount 无穷')

const ledger = new api.Ledger()
ledger.add({ account: 'cash', amount: 1 }).addMany([{ account: 'cash', amount: 2.5 }, { account: 'bank', amount: -1 }])
eq(ledger.size, 3, 'Ledger.add / addMany 入账条数')
eq(ledger.balance('cash'), 350, 'Ledger.balance cash')
eq(ledger.balance('bank'), -100, 'Ledger.balance bank')
eq(ledger.balance('none'), 0, 'Ledger.balance 未知账户')
eq(ledger.entries(), [
  { account: 'cash', cents: 100, note: '' },
  { account: 'cash', cents: 250, note: '' },
  { account: 'bank', cents: -100, note: '' },
], 'Ledger.entries 顺序与内容')
throws(() => new api.Ledger().addMany([{ account: 'ok', amount: 1 }, { amount: 1 }]), RangeError, 'addMany 整批校验')
{
  const l = new api.Ledger()
  try { l.addMany([{ account: 'ok', amount: 1 }, { amount: 1 }]) } catch { /* 期望抛 */ }
  eq(l.size, 0, 'addMany 失败时一条都不入')
}

eq(api.summarize([{ account: 'b', amount: 1 }, { account: 'a', amount: 2 }, { account: 'b', amount: 0.5 }]), { a: 200, b: 150 }, 'summarize 排序合计')
eq(api.summarize([]), {}, 'summarize 空批')
throws(() => api.summarize([{ account: 'a', amount: 'x' }]), RangeError, 'summarize 不合法条目直接抛')

eq(api.validateBatch([{ account: 'ok', amount: 1 }]), { ok: true, problems: [] }, 'validateBatch 合法')
const bad = api.validateBatch([{ account: 'ok', amount: 1 }, { amount: 1 }, null, { account: 'x', amount: 'NaN' }])
eq(bad.ok, false, 'validateBatch ok=false')
eq(bad.problems.length, 3, 'validateBatch 问题条数')
eq(bad.problems.map(p => /#(\d+)/.exec(p)?.[1] ?? null), ['1', '2', '3'], 'validateBatch 问题带正确序号')
eq(bad.problems.map(p => p.includes('entry.account is required') || p.includes('entry must be an object') || p.includes('finite')), [true, true, true], 'validateBatch 问题带原因')

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（共 ${total} 项）`)
process.exit(failed === 0 ? 0 : 1)
