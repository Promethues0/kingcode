/**
 * refactor-preserve 的隐藏判分测试（放在 eval/oracles/，prepare 不复制，agent 看不到）。
 *
 * 差分判分：同一张用例清单同时喂给夹具原件与 agent 改后的模块，逐例比对
 * 返回值（含新对象、不动入参）/ 抛错类型 / 抛错信息 / 导出集合。期望值不手抄，
 * 由原件现算——「行为不变」的裁判就是改之前的代码本身。
 * 另设几条金样例钉住原件（原件若被无意改动，差分会空转，这里先炸）。
 *
 * 跑法：RP_ORIGIN=<原件 inventory.js> RP_TARGET=<改后 inventory.js> node test.js
 * 退出码 0 = 全过。零依赖裸 node。
 */

import { pathToFileURL } from 'node:url'

const originPath = process.env.RP_ORIGIN
const targetPath = process.env.RP_TARGET
if (!originPath || !targetPath) {
  console.error('需要环境变量 RP_ORIGIN / RP_TARGET 指向原件与改后的 inventory.js')
  process.exit(2)
}

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}

const origin = await import(pathToFileURL(originPath).href)
let target
try {
  target = await import(pathToFileURL(targetPath).href)
} catch (e) {
  check(false, '改后模块可以被 import', `import 抛错：${e?.message}`)
  console.log(`\n失败 ${failed} 项`)
  process.exit(1)
}

// ── 金样例：钉住原件本身（不从任何输出反推）──────────────────────────────
const FN_NAMES = ['addStock', 'removeStock', 'reserveStock']
check(JSON.stringify(Object.keys(origin).sort()) === JSON.stringify(FN_NAMES), '原件导出恰好是三个函数')
check(origin.addStock({ sku: 'A', qty: 1 }, 2).qty === 3, '原件 addStock 金样例')
try { origin.removeStock({ sku: 'A', qty: 2 }, 5); check(false, '原件 removeStock 库存不足要抛') } catch (e) {
  check(e instanceof RangeError && e.message === '库存不足：A 仅剩 2', '原件 removeStock 库存不足金样例')
}
try { origin.reserveStock(null, 1); check(false, '原件 reserveStock(null) 要抛') } catch (e) {
  check(e instanceof TypeError && e.message === 'item 必须是对象', '原件 reserveStock(null) 金样例')
}

// ── 导出集合必须一致（公开 API 不增不减）──────────────────────────────────
const originKeys = Object.keys(origin).sort()
const targetKeys = Object.keys(target).sort()
check(JSON.stringify(originKeys) === JSON.stringify(targetKeys), '导出集合与原件一致',
  `原件 ${JSON.stringify(originKeys)} 改后 ${JSON.stringify(targetKeys)}`)
for (const fn of FN_NAMES) {
  check(typeof target[fn] === 'function', `导出 ${fn} 仍是函数`, `实得 ${typeof target[fn]}`)
}

// ── 用例清单：三个函数 × 正常路径 / 每条校验 / 校验顺序 / 业务错误 ─────────
const bolt = { sku: 'BOLT-M6', qty: 10, name: 'M6 螺栓', bin: 'A-07' }
const perFn = [
  ['正常：有余字段', bolt, 3],
  ['正常：amount 为 1', { sku: 'X', qty: 5 }, 1],
  ['正常：qty 为 0 的入库/出库/预留', { sku: 'X', qty: 0 }, 1],
  ['正常：amount 恰好等于 qty', { sku: 'X', qty: 3 }, 3],
  ['正常：带 reserved 字段', { sku: 'X', qty: 5, reserved: 2 }, 3],
  ['正常：reserved 显式为 0', { sku: 'X', qty: 5, reserved: 0 }, 5],
  ['item 为 null', null, 1],
  ['item 为 undefined', undefined, 1],
  ['item 为字符串', 'BOLT-M6', 1],
  ['item 为数字', 42, 1],
  ['item 为数组（是对象但无 sku）', [], 1],
  ['sku 缺失', { qty: 1 }, 1],
  ['sku 为空串', { sku: '', qty: 1 }, 1],
  ['sku 为全空白', { sku: '   ', qty: 1 }, 1],
  ['sku 为数字', { sku: 7, qty: 1 }, 1],
  ['amount 为 0', { sku: 'X', qty: 5 }, 0],
  ['amount 为负', { sku: 'X', qty: 5 }, -1],
  ['amount 为小数', { sku: 'X', qty: 5 }, 1.5],
  ['amount 为数字字符串', { sku: 'X', qty: 5 }, '3'],
  ['amount 为 NaN', { sku: 'X', qty: 5 }, NaN],
  ['amount 为 Infinity', { sku: 'X', qty: 5 }, Infinity],
  ['amount 缺失', { sku: 'X', qty: 5 }, undefined],
  ['qty 为负', { sku: 'X', qty: -1 }, 1],
  ['qty 为小数', { sku: 'X', qty: 1.5 }, 1],
  ['qty 为字符串', { sku: 'X', qty: '10' }, 1],
  ['qty 缺失', { sku: 'X' }, 1],
  ['顺序：item 非对象且 amount 非法 → 先报 item', null, 0],
  ['顺序：sku 与 amount 同时非法 → 先报 sku', { sku: '', qty: -1 }, 0],
  ['顺序：amount 与 qty 同时非法 → 先报 amount', { sku: 'X', qty: -1 }, 0],
  ['业务：amount 超过 qty', { sku: 'X', qty: 2 }, 5],
  ['业务：reserved 占用后不足', { sku: 'X', qty: 5, reserved: 4 }, 2],
  ['业务：reserved 占满', { sku: 'X', qty: 5, reserved: 5 }, 1],
  ['业务：qty 为 0 时取 1', { sku: 'X', qty: 0 }, 1],
]

/** 稳定序列化：键排序，便于逐字比对两边的返回值与入参快照。 */
const canon = (v) => JSON.stringify(v, (_, x) =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
    : x)

/** 跑一例，把「返回了什么 / 抛了什么 / 入参改没改 / 是否新对象」压成可比对的快照。 */
function probe(mod, fn, item, amount) {
  const input = structuredClone(item)
  const before = canon(input)
  try {
    const value = mod[fn](input, amount)
    return { ok: true, value: canon(value), fresh: value !== input, inputIntact: canon(input) === before }
  } catch (e) {
    return { ok: false, name: e?.constructor?.name, message: e?.message, inputIntact: canon(input) === before }
  }
}

for (const fn of FN_NAMES) {
  if (typeof target[fn] !== 'function') continue
  for (const [label, item, amount] of perFn) {
    const want = probe(origin, fn, item, amount)
    const got = probe(target, fn, item, amount)
    check(canon(want) === canon(got), `${fn}：${label}`,
      canon(want) === canon(got) ? '' : `原件 ${canon(want)} 改后 ${canon(got)}`)
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
