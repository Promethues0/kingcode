/**
 * 系统提示词补充段的无头测试：不起 agent、不调模型。
 *
 * 守的是三件事：三段都真的注册了、order 落在空闲频段且相对次序正确
 * （工具取舍必须排在上游 100-105 的工具指导段之后）、正文里没有漏写的
 * {{变量}}（system-prompt 只解析注册过的变量，写错会原样漏进提示词）。
 *
 * 跑法：node test/test-prompt-sections.js（失败退出码 1）
 */

import { apply, SESSION_CONTRACT, DISCIPLINE, TOOL_ROUTING } from '../plugins/prompt-sections.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

/** 用假的 ctx 收下插件注册的所有 section。 */
function collectSections() {
  const sections = []
  apply({ systemPrompt: { section: s => { sections.push(s) } } })
  return sections
}

const sections = collectSections()

eq(sections.length, 3, '注册了三段')

// 上游已占用的 order：-100 identity、0 persona、100-105 各工具段、116.5 subagent。
// 自有段必须避开这些，且不能互相撞车。
const UPSTREAM_ORDERS = new Set([-100, 0, 100, 101, 102, 103, 104, 105, 116.5])
const orders = sections.map(s => s.order)
check(new Set(orders).size === orders.length, '三段 order 互不相同', orders.join('/'))
check(orders.every(o => !UPSTREAM_ORDERS.has(o)), 'order 不与上游已占段撞车', orders.join('/'))

const byName = new Map(sections.map(s => [s.name, s]))
for (const expectedName of ['kingcode:session-contract', 'kingcode:discipline', 'kingcode:tool-routing']) {
  check(byName.has(expectedName), `注册了 ${expectedName}`)
}

// 相对次序：会话契约与纪律紧跟 persona（order 0）之后、工具段（100+）之前；
// 工具取舍必须在工具段之后，否则它仲裁不了那些工具。
const contract = byName.get('kingcode:session-contract')
const discipline = byName.get('kingcode:discipline')
const routing = byName.get('kingcode:tool-routing')
check(contract.order > 0 && contract.order < 100, '会话契约排在 persona 之后、工具段之前', String(contract.order))
check(discipline.order > 0 && discipline.order < 100, '工作纪律排在 persona 之后、工具段之前', String(discipline.order))
check(routing.order > 105, '工具取舍排在全部上游工具指导段之后', String(routing.order))
check(contract.order < discipline.order, '会话契约先于工作纪律')

// 正文体检：变量只有注册过的才会被解析，漏写的 {{...}} 会原样进提示词
for (const [label, text] of [['会话契约', SESSION_CONTRACT], ['工作纪律', DISCIPLINE], ['工具取舍', TOOL_ROUTING]]) {
  check(!text.includes('{{'), `${label}没有未解析的模板变量`)
  check(text.trim().length > 0, `${label}非空`)
  check(text === text.trim(), `${label}首尾无多余空白`)
}

// 每段各自的载荷：这些是它们存在的理由，改没了就该有人知道
check(SESSION_CONTRACT.includes('never end your turn with a clarifying question'),
  '会话契约堵住了「以提问收尾」这条静默失败路径')
check(SESSION_CONTRACT.includes('stdout'), '会话契约说明了最终消息即交付物')
check(DISCIPLINE.includes('Re-reading your own diff is not verification'),
  '工作纪律给了「验证」的可检验定义')
check(TOOL_ROUTING.includes('grep') && TOOL_ROUTING.includes('todo_write') && TOOL_ROUTING.includes('subagent'),
  '工具取舍覆盖了 grep/todo_write/subagent 三处易误用点')
check(TOOL_ROUTING.includes('timeoutMs'), '工具取舍告诉了模型 bash 超时的覆盖方式')

// 每段都是纯静态文本（没有 fn），否则测试断言的东西与运行时不是同一份
check(sections.every(s => typeof s.text === 'string' && s.fn === undefined),
  '三段都是静态文本，与本测试断言的常量同源')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
