/**
 * stack-trace-hunt 的隐藏判分用例（agent 看不到：oracles/ 绝不复制进 runDir）。
 *
 * 跑法：node hidden-check.mjs <agent 的工作目录>
 * 直接调 B 模块（lib/customers.js）的 findCustomer，覆盖「客户记录里的编号是短写
 * （C7）」这条分支的全部书写变体。只在 A（render.js）加判空兜底的话，这里仍然挂；
 * 把查找改成「两边都只 toLowerCase」的半修，C0007/c0007 也过不去。
 *
 * 断言的全是 lib/customers.js 文件头写明的约定，没有任何夹具之外的隐含要求。
 * 风格同 test/*.js：check/eq，零依赖。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cwd = process.argv[2]
if (!cwd || !existsSync(join(cwd, 'lib', 'customers.js'))) {
  console.error('用法：node hidden-check.mjs <含 lib/customers.js 的目录>')
  process.exit(2)
}

const mod = await import(pathToFileURL(join(cwd, 'lib', 'customers.js')).href)
if (typeof mod.findCustomer !== 'function') {
  console.log('FAIL lib/customers.js 不再导出 findCustomer（对外接口被改了）')
  process.exit(1)
}

let failed = 0
const eq = (got, want, label) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}
const nameOf = (id) => {
  try { return mod.findCustomer(id)?.name } catch (e) { return `抛异常：${e.message}` }
}

// 原本就能查到的写法必须仍然能查到（别把对的改坏）
eq(nameOf('C0001'), 'Alice Chen', '规范写法 C0001')
eq(nameOf('c0002'), 'Bob Lee', '小写规范写法 c0002')

// 条件分支：客户记录里存的是短写 C7，各种写法都得命中同一位客户
eq(nameOf('C7'), 'Carol Wu', '短写 C7（报错现场那一单）')
eq(nameOf('c7'), 'Carol Wu', '短写小写 c7')
eq(nameOf('C0007'), 'Carol Wu', '补零写法 C0007')
eq(nameOf('c0007'), 'Carol Wu', '归一形 c0007')
eq(nameOf(' c0007 '), 'Carol Wu', '带首尾空白')

// 反过来：存的是补零形 C0001，用短写查也得命中
eq(nameOf('c1'), 'Alice Chen', '短写查补零形记录 c1')
eq(nameOf('C2'), 'Bob Lee', '短写查补零形记录 C2')

console.log(failed === 0 ? '\n隐藏用例全部通过' : `\n隐藏用例失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
