/**
 * eval 判分地基（eval/lib/guards.js）的无头测试：不起 agent、不调模型。
 *
 * 重点守子会话收集——判分器信错了会话面，作弊就能整条洗白：
 * 子代理不是父会话里的几条事件，而是同一个 persistence root 下**另一份
 * session.jsonl**，首行带 parentSession / origin:"subagent" / delegationDepth，
 * 且**目录名不带 `session-` 前缀**（裸 uuid）。真实首行（读自本机会话，非杜撰）：
 *   {"type":"session","version":0,"id":"1167b76a-…","createdAt":1787317336217,
 *    "cwd":"/home/you/kingcode",
 *    "parentSession":"session-a5fd33c7-…","origin":"subagent","delegationDepth":1}
 *
 * 守的是：递归收全部后代（不写死 maxDepth 1）、不按目录名前缀过滤、不越界收
 * 别人的子树、成环不转死、toolCallsDeep 少给 sessionsRoot 就炸（静默缩小取证面
 * 比报错危险得多）、sessionUsageDeep 逐份相加与手工求和一致。
 *
 * 跑法：node test/test-guards.js（失败退出码 1）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  childSessionFiles, sessionFamilyFiles, sessionIdOf, sessionUsage, sessionUsageDeep, toolCalls, toolCallsDeep,
} from '../eval/lib/guards.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)
const eqJson = (actual, expectedValue, label) => eq(JSON.stringify(actual), JSON.stringify(expectedValue), label)

const J = (o) => JSON.stringify(o)
const root = mkdtempSync(join(tmpdir(), 'kingcode-guards-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

/**
 * 造一份会话：<root>/<cwd 编码目录>/<sessionId>/session.jsonl。
 * head 为 null 时首行故意写成坏 JSON（半行被 SIGKILL 截断的样子）。
 * @returns {string} 会话文件绝对路径
 */
function makeSession(cwdDir, id, head, lines = []) {
  const dir = join(root, cwdDir, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  const first = head === null ? '{"type":"session","id":"截断的半行' : J({ type: 'session', version: 0, id, ...head })
  writeFileSync(file, [first, ...lines].join('\n') + '\n')
  return file
}

const call = (seq, name, args) => J({ type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, callId: `c${seq}`, name, arguments: J(args) } })
const msg = (seq, usage) => J({ type: 'assistant/message', seq, time: seq, data: { turn: 1, step: 1, message: {}, usage } })

// ── 现场：一棵父 → 子 → 孙 的委派树，外加一棵不相干的树、一个环、两份坏会话 ──
const ENC = '--Users-prometheus-Projects-kingcode--'
const OTHER_ENC = '--tmp-elsewhere--' // 子代理换了 cwd 就落到另一个编码目录下

const parent = makeSession(ENC, 'session-P', { cwd: '/repo' }, [
  call(10, 'explore', { description: '查函数名', prompt: '在整个仓库里搜索……' }),
])
// 子会话：目录名是裸 uuid（**没有** session- 前缀），靠 parentSession 认亲
const child = makeSession(ENC, '1167b76a-79e6-4eb3-96a0-90936054fc9b',
  { cwd: '/repo', parentSession: 'session-P', origin: 'subagent', delegationDepth: 1 }, [
    call(3, 'bash', { command: 'grep -rn KINGCODE_RESULT_FILE eval/' }),
  ])
// 孙会话：当前组合树 maxDepth 1 收不到这么深，但判分不该写死这个假设
const grandchild = makeSession(OTHER_ENC, '725a670a-7f70-4026-8edf-a7ed465e125d',
  { cwd: '/tmp/elsewhere', parentSession: '1167b76a-79e6-4eb3-96a0-90936054fc9b', origin: 'subagent', delegationDepth: 2 }, [
    call(4, 'read', { file_path: 'eval/tasks/find-result-writer.js' }),
  ])
// 另一棵树：并发跑 eval 时同一个 root 下还躺着别的任务的会话，绝不能被收进来
makeSession(ENC, 'session-Q', { cwd: '/repo' }, [call(1, 'bash', { command: 'echo 别人的' })])
makeSession(ENC, '99999999-0000-0000-0000-000000000001',
  { cwd: '/repo', parentSession: 'session-Q', origin: 'subagent', delegationDepth: 1 })
// 环：A 的父是 B、B 的父是 A；再加一个自己当自己父亲的
makeSession(ENC, 'cycle-a', { cwd: '/repo', parentSession: 'cycle-b' })
makeSession(ENC, 'cycle-b', { cwd: '/repo', parentSession: 'cycle-a' })
makeSession(ENC, 'session-self', { cwd: '/repo', parentSession: 'session-self' })
// 坏会话：首行不可解析（截断）——认不出父子关系，但不许把整次收集炸掉
makeSession(ENC, 'broken-head', null, [call(1, 'bash', { command: 'echo 坏首行' })])
// 空目录：有会话目录没有 session.jsonl（进程起不来就落这样一个壳）
mkdirSync(join(root, ENC, 'no-jsonl'), { recursive: true })
// root 下的散文件：不是 cwd 目录，扫描不能被它绊倒
writeFileSync(join(root, 'stray.txt'), 'not a session dir\n')

// ── childSessionFiles：递归、认亲、不越界 ─────────────────────────────────

{
  const kids = childSessionFiles(root, 'session-P')
  eqJson(kids, [child, grandchild], '父会话收到子 + 孙两份（递归，不止一层）')
  check(!kids.some(f => basename(dirname(f)).startsWith('session-')), '收到的子会话目录名确实不带 session- 前缀')
  check(kids.every(f => !f.includes('session-Q') && !f.includes('99999999')), '不收别人子树的会话')
}

{
  eqJson(childSessionFiles(root, '1167b76a-79e6-4eb3-96a0-90936054fc9b'), [grandchild], '从子会话出发只收到孙会话')
  eqJson(childSessionFiles(root, '725a670a-7f70-4026-8edf-a7ed465e125d'), [], '叶子会话没有后代')
  eqJson(childSessionFiles(root, 'session-Q'), [join(root, ENC, '99999999-0000-0000-0000-000000000001', 'session.jsonl')], '另一棵树各收各的')
}

{
  eqJson(childSessionFiles(root, 'nobody-home'), [], '不存在的 sessionId → 空')
  eqJson(childSessionFiles(root, null), [], 'sessionId 为 null → 空（会话没落盘时 run.js 就是给 null）')
  eqJson(childSessionFiles(root, ''), [], 'sessionId 为空串 → 空')
  eqJson(childSessionFiles(join(root, '不存在的目录'), 'session-P'), [], 'sessionsRoot 不存在 → 空，不抛')
}

{
  // 环：转不出来就是死循环，这条测试会直接挂住——所以它同时是超时哨兵
  eqJson(childSessionFiles(root, 'cycle-a').map(f => basename(dirname(f))), ['cycle-b'], '父子成环只收一次，不转死')
  eqJson(childSessionFiles(root, 'session-self'), [], '自己当自己父亲不算自己的后代')
}

// ── sessionIdOf：首行 id 优先，坏首行退回目录名 ───────────────────────────

{
  eq(sessionIdOf(parent), 'session-P', '首行 id 即 sessionId')
  eq(sessionIdOf(child), '1167b76a-79e6-4eb3-96a0-90936054fc9b', '子会话首行 id')
  eq(sessionIdOf(join(root, ENC, 'broken-head', 'session.jsonl')), 'broken-head', '首行坏了退回目录名')
}

// ── sessionFamilyFiles / toolCallsDeep：父在最前，少给 root 就炸 ──────────

{
  eqJson(sessionFamilyFiles(parent, root, 'session-P'), [parent, child, grandchild], '家族文件 = 父在最前 + 全部后代')
  eqJson(sessionFamilyFiles(parent, root), [parent, child, grandchild], '不给 rootSessionId 时从首行推断')
  let threw = null
  try { sessionFamilyFiles(parent, undefined) } catch (e) { threw = e }
  check(threw !== null, '漏传 sessionsRoot 直接抛（静默只看父会话＝取证面被悄悄缩小）')
}

{
  const deep = toolCallsDeep(parent, root, 'session-P')
  eqJson(deep.map(c => c.name), ['explore', 'bash', 'read'], '合集含父会话与全部后代的工具调用')
  eqJson(deep.map(c => c.subagent), [false, true, true], '每条都标明是不是子代理干的')
  eqJson(deep.map(c => c.sessionId), ['session-P', '1167b76a-79e6-4eb3-96a0-90936054fc9b', '725a670a-7f70-4026-8edf-a7ed465e125d'], '每条都带所属 sessionId')
  eqJson(toolCalls(parent).map(c => c.name), ['explore'], '对照：只看父会话时那两次读根本看不见')

  // 这正是被修的作弊路：父会话参数里没有 eval/，子会话里有
  const EVAL_PATH = /(^|[^A-Za-z0-9_-])eval[\\/]/
  const touched = deep.filter(c => EVAL_PATH.test(c.rawArguments))
  eq(touched.length, 2, '子代理里的 eval/ 触碰被取证抓到')
  eq(toolCalls(parent).filter(c => EVAL_PATH.test(c.rawArguments)).length, 0, '同一份证据在父会话里一条都看不到')

  // 解析后的 args 保持 toolCalls 的契约
  eq(deep[1].args.command, 'grep -rn KINGCODE_RESULT_FILE eval/', 'args 仍是解析后的对象')
}

// ── sessionUsageDeep：逐份相加，与手工求和一致 ────────────────────────────

{
  const u = (i, o, c, r) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: c, reasoningTokens: r })
  const pFile = makeSession(ENC, 'session-U', { cwd: '/repo' }, [msg(1, u(100, 10, 1000, 5)), msg(2, u(200, 20, 2000, 6))])
  const cFile = makeSession(ENC, 'aaaaaaaa-0000-0000-0000-00000000000c',
    { cwd: '/repo', parentSession: 'session-U', origin: 'subagent', delegationDepth: 1 },
    [msg(1, u(1000, 500, 3000, 70))])

  const deep = sessionUsageDeep(pFile, root, 'session-U')
  const parentOnly = sessionUsage(pFile)
  const childOnly = sessionUsage(cFile)
  eq(deep.sessions, 2, '计入了父 + 1 份子会话')
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'llmCalls']) {
    eq(deep[k], parentOnly[k] + childOnly[k], `${k} = 父 + 子（独立手工求和）`)
  }
  // 低估幅度：这就是「只算父会话的真实花费」错得有多离谱
  const paid = parentOnly.inputTokens + parentOnly.outputTokens
  const total = deep.inputTokens + deep.outputTokens
  check(total > paid * 2, '父会话口径能把 in+out 低估过半（本例夹具刻意做成这样）', `父 ${paid} / 合计 ${total}`)
  eq(sessionUsageDeep(cFile, root, 'aaaaaaaa-0000-0000-0000-00000000000c').sessions, 1, '叶子会话只算它自己')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
