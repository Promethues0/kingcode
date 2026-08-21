/**
 * 按栈追因类任务：入口 `node index.js` 抛 TypeError，栈顶在 A（lib/render.js 的
 * `customer.name`），根因却在 B（lib/customers.js）——B 建索引时用 `id.toLowerCase()`
 * 当键、查找时却用 normalizeId（小写 c + 4 位补零）当键，客户记录的编号是短写
 * （C7）时两边对不上，findCustomer 返回 undefined，A 一解引用就炸。B 根本不在栈里。
 *
 * 任务文本模拟用户贴日志：报错与栈是在夹具副本里真跑一次抓下来的原文，只把
 * 运行目录前缀换成了 /Users/me/ledger（用户机器上的路径本来就跟 agent 的不同）。
 *
 * 判分（零 LLM，全部 runOracle 带超时）：
 * ① data/ 两个 json 与原件逐字节一致（改数据不算修）；
 * ② 判分器自己跑 `node index.js`：退出码 0，且每张订单一行含「#单号 + 客户名」、
 *    末尾合计——期望值由判分器从原件数据按文件头约定独立复算，不抄常量；
 * ③ 隐藏用例 oracles/stack-trace-hunt/hidden-check.mjs 直接调 B 的 findCustomer，
 *    覆盖短写编号的全部书写变体（C7 / c7 / C0007 / c0007 / 空白）与反向（c1 查 C0001）；
 *    只在 A 加判空兜底、或把两边都改成 toLowerCase 的半修，这里都过不去；
 * ④ 隐藏数据 orders-hidden.json 走一遍入口端到端，同样独立复算期望。
 * render.js 是否被改只进 detail 当参考，不判分：修对 B 之后顺手加防御不算错。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertFrozen, copyDir, runOracle } from '../lib/guards.js'

const FIXTURE = ['eval', 'fixtures', 'stack-trace-hunt']
const ORACLE = ['eval', 'oracles', 'stack-trace-hunt']
const FROZEN = ['data/customers.json', 'data/orders.json']

/** 判分器自己的归一：按 lib/customers.js 文件头写明的约定（大小写不敏感、前导零可省）。 */
const canon = (id) => 'c' + String(Number.parseInt(String(id).trim().replace(/^c/i, ''), 10)).padStart(4, '0')

/** 从原件数据独立推导「每张订单该打出谁」与合计，不看 agent 的任何产物。 */
function expectedOf(customersFile, ordersFile) {
  const byId = new Map(JSON.parse(readFileSync(customersFile, 'utf8')).map(c => [canon(c.id), c]))
  const orders = JSON.parse(readFileSync(ordersFile, 'utf8'))
  const rows = orders.map(o => {
    const c = byId.get(canon(o.customer))
    if (c === undefined) throw new Error(`判分数据自相矛盾：订单 ${o.id} 的客户 ${o.customer} 在 customers.json 里不存在`)
    return { id: o.id, name: c.name }
  })
  const total = (orders.reduce((s, o) => s + o.amountCents, 0) / 100).toFixed(2)
  return { rows, total }
}

/** stdout 里每张订单是否各有一行同时含「#单号」与客户名，合计金额是否出现。 */
function checkStdout(stdout, expected) {
  const lines = stdout.split('\n')
  const missing = expected.rows
    .filter(r => !lines.some(l => l.includes(`#${r.id}`) && l.includes(r.name)))
    .map(r => `#${r.id}→${r.name}`)
  if (!stdout.includes(expected.total)) missing.push(`合计 ${expected.total}`)
  return missing
}

export default {
  id: 'stack-trace-hunt',
  description: '按栈追因：TypeError 栈顶在 render.js，根因在 customers.js 的索引键不归一（禁改数据）',
  judge: '复跑 node index.js 退出 0 且逐单含期望客户名；隐藏用例直调 findCustomer 覆盖短写编号各变体；data/*.json 与原件逐字节一致',
  task: '跑 `node index.js` 直接炸了，日志如下（路径是我机器上的）：\n\n'
    + '#1001  Alice Chen     120.50  gold\n'
    + '#1002  Bob Lee         80.00  silver\n'
    + 'file:///Users/me/ledger/lib/render.js:9\n'
    + '  const who = customer.name.padEnd(12)\n'
    + '                       ^\n'
    + '\n'
    + "TypeError: Cannot read properties of undefined (reading 'name')\n"
    + '    at renderRow (file:///Users/me/ledger/lib/render.js:9:24)\n'
    + '    at file:///Users/me/ledger/index.js:12:41\n'
    + '    at ModuleJob.run (node:internal/modules/esm/module_job:437:25)\n'
    + '    at async node:internal/modules/esm/loader:639:26\n'
    + '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n'
    + '\n'
    + 'Node.js v24.15.0\n\n'
    + '报错那行只是症状，请找到真正的原因把它修掉，不要在 render.js 里加个判空把错误糊过去。'
    + 'data/ 下的两个 json 是上游系统导出的，不要改数据。改动尽量小，修好后自己跑一遍 node index.js '
    + '确认四张订单都能打出来，最后用一两句话说明根因在哪。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, ...FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const fixture = join(repoRoot, ...FIXTURE)
    const oracle = join(repoRoot, ...ORACLE)

    // ① 数据文件不许动
    const frozen = assertFrozen(cwd, fixture, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的数据文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }

    // render.js 有没有被碰只作参考，不判分
    const renderTouched = !assertFrozen(cwd, fixture, ['lib/render.js']).ok
    const note = `agent 退出码 ${exitCode}；render.js ${renderTouched ? '被改过' : '未动'}`

    // ② 判分器自己复跑入口
    const run = runOracle(process.execPath, ['index.js'], { cwd, timeoutMs: 20_000 })
    if (run.timedOut) return { pass: false, detail: `复跑 node index.js 超时；${note}` }
    if (run.status !== 0) {
      const firstErr = run.stderr.split('\n').find(l => /Error/.test(l)) ?? '(stderr 无 Error 行)'
      return { pass: false, detail: `复跑 node index.js 退出码 ${run.status}：${firstErr}；${note}` }
    }
    const visible = expectedOf(join(fixture, 'data', 'customers.json'), join(fixture, 'data', 'orders.json'))
    const missingVisible = checkStdout(run.stdout, visible)
    if (missingVisible.length > 0) {
      return { pass: false, detail: `入口退出 0 但输出缺：${missingVisible.join('、')}；${note}` }
    }

    // ③ 隐藏用例：直接调 B 的 findCustomer，覆盖那条条件分支的全部写法
    const unit = runOracle(process.execPath, [join(oracle, 'hidden-check.mjs'), cwd], { cwd, timeoutMs: 20_000 })
    if (unit.timedOut) return { pass: false, detail: `隐藏用例超时；${note}` }
    if (unit.status !== 0) {
      const fails = unit.stdout.split('\n').filter(l => l.startsWith('FAIL')).join('；') || unit.stderr.trim().split('\n')[0]
      return { pass: false, detail: `隐藏用例未过（入口能跑但根因没修对）：${fails}；${note}` }
    }

    // ④ 隐藏数据端到端
    const hiddenOrders = join(oracle, 'orders-hidden.json')
    const e2e = runOracle(process.execPath, ['index.js', hiddenOrders], { cwd, timeoutMs: 20_000 })
    if (e2e.timedOut) return { pass: false, detail: `隐藏数据端到端超时；${note}` }
    if (e2e.status !== 0) {
      const firstErr = e2e.stderr.split('\n').find(l => /Error/.test(l)) ?? '(stderr 无 Error 行)'
      return { pass: false, detail: `隐藏数据端到端退出码 ${e2e.status}：${firstErr}；${note}` }
    }
    const hidden = expectedOf(join(fixture, 'data', 'customers.json'), hiddenOrders)
    const missingHidden = checkStdout(e2e.stdout, hidden)
    if (missingHidden.length > 0) {
      return { pass: false, detail: `隐藏数据端到端输出缺：${missingHidden.join('、')}；${note}` }
    }

    return { pass: true, detail: `入口复跑通过、隐藏用例 ${unit.stdout.split('\n').filter(l => l.startsWith('OK')).length} 项全过、隐藏数据端到端通过；${note}` }
  },
}
