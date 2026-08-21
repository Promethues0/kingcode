/**
 * inventory.js 的验收测试。跑法：npm test（即 node test.js）。
 * 评测判分会校验本文件与夹具原件逐字节一致——改测试不算完成。
 */

import { addStock, removeStock, reserveStock } from './inventory.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (got, want, label) =>
  check(got === want, label, got === want ? '' : `期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
const throws = (fn, Ctor, message, label) => {
  try { fn() } catch (e) {
    const ok = e instanceof Ctor && e.message === message
    return check(ok, label, ok ? '' : `期望 ${Ctor.name}(${JSON.stringify(message)}) 实得 ${e?.constructor?.name}(${JSON.stringify(e?.message)})`)
  }
  check(false, label, '期望抛错，实际没抛')
}

const bolt = { sku: 'BOLT-M6', qty: 10, name: 'M6 螺栓' }

eq(addStock(bolt, 5).qty, 15, '入库：数量相加')
eq(addStock(bolt, 5).name, 'M6 螺栓', '入库：其余字段保留')
eq(bolt.qty, 10, '入库：不修改入参')
eq(removeStock(bolt, 4).qty, 6, '出库：数量相减')
eq(reserveStock(bolt, 3).reserved, 3, '预留：reserved 从 0 起累加')
eq(reserveStock({ ...bolt, reserved: 2 }, 3).reserved, 5, '预留：在已有 reserved 上累加')

throws(() => addStock(null, 1), TypeError, 'item 必须是对象', '入库：item 为 null')
throws(() => removeStock({ sku: '', qty: 1 }, 1), TypeError, 'item.sku 必须是非空字符串', '出库：sku 为空')
throws(() => reserveStock(bolt, 0), RangeError, 'amount 必须是正整数', '预留：amount 为 0')
throws(() => removeStock(bolt, 11), RangeError, '库存不足：BOLT-M6 仅剩 10', '出库：库存不足')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
