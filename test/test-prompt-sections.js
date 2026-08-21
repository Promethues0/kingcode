/**
 * 系统提示词补充段的无头测试：不起 agent、不调模型。
 *
 * 守的是四件事：默认三段都真的注册了、order 落在空闲频段且相对次序正确
 * （工具取舍必须排在上游 100-116 的工具指导段之后）、正文里没有漏写的
 * {{变量}}（system-prompt 只解析注册过的变量，写错会原样漏进提示词）、
 * 按段开关真的生效（关掉的段不注册；Web 预设用的组合只剩 discipline + web-routing）。
 *
 * 跑法：node test/test-prompt-sections.js（失败退出码 1）
 */

import { apply, DEFAULT_CONFIG, SESSION_CONTRACT, DISCIPLINE, TOOL_ROUTING, WEB_ROUTING } from '../plugins/prompt-sections.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

/** 用假的 ctx 收下插件注册的所有 section。 */
function collectSections(config) {
  const sections = []
  apply({ systemPrompt: { section: s => { sections.push(s) } } }, config)
  return sections
}

const sections = collectSections()

eq(sections.length, 3, '不传 config 时注册了三段（一次性 CLI 的现状）')
eq(JSON.stringify(DEFAULT_CONFIG), JSON.stringify({ sessionContract: true, discipline: true, toolRouting: true, webRouting: false }),
  '默认开关：前三段开、webRouting 关')

// 上游已占用的 order：-100 identity、0 persona、50 plan:policy、100-105 fs/search/bash、
// 106 jobs、110/111 web、114 goal、115 workflow、116 ralph、116.5 subagent。
// 自有段必须避开这些，且不能互相撞车。
const UPSTREAM_ORDERS = new Set([-100, 0, 50, 100, 101, 102, 103, 104, 105, 106, 110, 111, 114, 115, 116, 116.5])
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
check(routing.order > 116.5, '工具取舍排在全部上游工具指导段之后', String(routing.order))
check(contract.order < discipline.order, '会话契约先于工作纪律')

// 正文体检：变量只有注册过的才会被解析，漏写的 {{...}} 会原样进提示词
for (const [label, text] of [['会话契约', SESSION_CONTRACT], ['工作纪律', DISCIPLINE], ['工具取舍', TOOL_ROUTING], ['Web 工具取舍', WEB_ROUTING]]) {
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

// ── 按段开关 ────────────────────────────────────────────────────────────────
const names = config => collectSections(config).map(s => s.name).sort().join(',')

eq(names({ sessionContract: false }), 'kingcode:discipline,kingcode:tool-routing', '关掉 sessionContract 后该段不注册')
eq(names({ discipline: false }), 'kingcode:session-contract,kingcode:tool-routing', '关掉 discipline 后该段不注册')
eq(names({ toolRouting: false }), 'kingcode:discipline,kingcode:session-contract', '关掉 toolRouting 后该段不注册')
eq(names({ sessionContract: false, discipline: false, toolRouting: false }), '', '全关则一段不注册')

// Web 预设（presets/kingcode/agent.cordis.yml）用的组合
const web = collectSections({ sessionContract: false, toolRouting: false, webRouting: true })
eq(web.map(s => s.name).sort().join(','), 'kingcode:discipline,kingcode:web-routing',
  'Web 组合只剩 discipline + web-routing（没有 session-contract，没有 tool-routing）')
const webRouting = web.find(s => s.name === 'kingcode:web-routing')
eq(webRouting.order, routing.order, 'web-routing 与 tool-routing 同占一个频位（互斥替换）')
check(webRouting.text === WEB_ROUTING && webRouting.fn === undefined, 'web-routing 是静态文本，与常量同源')

// 两个 routing 互斥：同时打开必须响亮失败，而不是注册两段同 order 的互相矛盾的话
let threw = false
try { collectSections({ webRouting: true }) } catch { threw = true }
check(threw, 'toolRouting 与 webRouting 同时打开会抛错')

// Web 段的载荷：每条都对照 standard preset / web 组合树实况写，改没了就该有人知道
check(WEB_ROUTING.includes('ask_user_question'), 'Web 取舍告诉模型可以向用户提问（standard preset 挂 tool-ask-user）')
check(WEB_ROUTING.includes('plan mode'), 'Web 取舍提到 plan mode（standard preset 挂 plan-mode）')
check(WEB_ROUTING.includes('web_fetch is not available'), 'Web 取舍如实说 web_fetch 关着（tool-web fetch: false）')
check(WEB_ROUTING.includes('60s') && WEB_ROUTING.includes('timeoutMs'), 'Web 取舍给的 bash 默认超时是 web 树 bash-sandbox 的 60s')
check(WEB_ROUTING.includes('run_in_background') && WEB_ROUTING.includes('job_output'), 'Web 取舍覆盖了后台任务（standard preset 挂 tool-jobs）')
check(!WEB_ROUTING.includes('one-shot') && !WEB_ROUTING.includes('no second turn'), 'Web 取舍里没有一次性 CLI 的话')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
