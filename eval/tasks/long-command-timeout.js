/**
 * 长命令超时处理类任务：夹具的 `npm run verify` 是个慢集成校验，要实跑 135s 才打出
 * VERIFY_OK 并以 0 退出。bash 工具默认 120s 超时（eval 树 timeoutMs: 120000、上限
 * 600000），persona 也写明「Pass timeoutMs explicitly for … test suites that legitimately
 * run longer」。题面只说「跑 verify 确认通过、把最后一行告诉我」——模型得自己意识到
 * 默认超时不够，在 bash 调用上显式传 timeoutMs（一次到位，或首跑撞超时后补救）。
 * 考的是模型会不会读工具说明；后台执行在本树结构性关闭，绕不过去。
 *
 * 判分（零 LLM，不复跑 verify——再等 135s 毫无意义，证据全在会话 jsonl 里）：
 * ① package.json 与 scripts/verify.js 与原件逐字节一致——缩短等待不算跑过；
 * ② 会话里存在一次 bash 调用 args.timeoutMs ≥ 135000（值与命令记进 detail）；
 * ③ 会话里某次 bash 调用的 tool/result 文本含**整行** VERIFY_OK——命令确实在 agent 手里跑完了。
 *    必须是整行：`cat scripts/verify.js` 的结果里也有这个字面量，但那一行是
 *    `console.log('VERIFY_OK')`，子串匹配会被读源码糊弄过去（首次真跑就撞上了这条：
 *    VERIFY_OK 被归因到 cat 调用）；
 * ③' 耗时门槛：整行 VERIFY_OK 光靠文本证明不了什么——`echo VERIFY_OK`、`grep -o VERIFY_OK
 *    scripts/verify.js` 都能在 2ms 内造出同样的结果文本（离线探针已复现这条作弊路径判 PASS）。
 *    夹具冻结的前提下，verify 跑完必然等满 SETTLE_MS=135s，所以用会话事件的 ms 时间戳配对
 *    callId：产出 VERIFY_OK 的那次 bash 调用，tool/result.time − tool/call.time 必须 ≥ 135000
 *    （真跑实测约 135.2s）。允许一种变体：长调用把输出重定向到文件、之后另一次 bash 把它读出来——
 *    那就要求那次长调用（timeoutMs ≥ 135000）自身耗时 ≥ 135s 且发生在读出之前。无论哪条路，
 *    会话里都必须有一次实打实等了 135s 的 bash 调用，判分器不必复跑 verify 也能证明时间花掉了；
 * ④ agent 退出码 0 且 stdout 含 VERIFY_OK（把最后一行告诉用户）。
 * 另把「首跑是否撞过默认超时」记进 detail，只作参考不判分：补救也是合格表现。
 *
 * 整体 timeoutMs 给 420s：默认超时被杀一次（120s）+ 重跑到完（135s）+ 模型往返，还有余量。
 * 代价是全量 eval 多 2-3 分钟——值得，这条测的能力别的任务都碰不到。
 */

import { join } from 'node:path'
import { assertFrozen, copyDir, readSession, toolCalls } from '../lib/guards.js'

const ID = 'long-command-timeout'
const FIXTURE = (repoRoot) => join(repoRoot, 'eval', 'fixtures', ID)
const FROZEN = ['package.json', 'scripts/verify.js']
/** verify.js 里 SETTLE_MS 的值：bash 调用的 timeoutMs 至少得盖住它，命令才可能跑完 */
const REQUIRED_TIMEOUT_MS = 135_000
const MARK = 'VERIFY_OK'
/** 工具结果里得有独占一行的 VERIFY_OK（真跑的输出），而不是源码里的 console.log('VERIFY_OK') */
const MARK_LINE = /^VERIFY_OK\s*$/m

/** 某次工具调用的结果文本（tool/result 事件按 toolCallId 对上；多段 text 拼接）。 */
function toolResultText(events, callId) {
  const parts = []
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    for (const item of e.data?.message?.content ?? []) {
      if (item?.toolCallId !== callId) continue
      for (const piece of Array.isArray(item.content) ? item.content : []) {
        if (typeof piece?.text === 'string') parts.push(piece.text)
      }
    }
  }
  return parts.join('\n')
}

/**
 * 每个 callId 的实际耗时（ms）：tool/result.time − tool/call.time。事件的 time 是 epoch ms；
 * tool/result 的 callId 取 message.source.callId，退而取 content[].toolCallId。配不上对的返回 NaN。
 */
function elapsedByCallId(events) {
  const callAt = new Map()
  const resultAt = new Map()
  for (const e of events) {
    if (typeof e.time !== 'number') continue
    if (e.type === 'tool/call' && typeof e.data?.callId === 'string') {
      if (!callAt.has(e.data.callId)) callAt.set(e.data.callId, e.time)
    } else if (e.type === 'tool/result') {
      const ids = new Set()
      const src = e.data?.message?.source
      if (src?.kind === 'tool' && typeof src.callId === 'string') ids.add(src.callId)
      for (const item of e.data?.message?.content ?? []) {
        if (typeof item?.toolCallId === 'string') ids.add(item.toolCallId)
      }
      for (const id of ids) if (!resultAt.has(id)) resultAt.set(id, e.time)
    }
  }
  return (callId) => {
    const a = callAt.get(callId)
    const b = resultAt.get(callId)
    return typeof a === 'number' && typeof b === 'number' ? b - a : NaN
  }
}

const short = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s)
const fmtMs = (ms) => (Number.isNaN(ms) ? '无法配对' : `${ms}ms`)

export default {
  id: ID,
  description: '跑一条要 135s 的 npm run verify：bash 默认 120s 超时，模型须在调用上显式传 timeoutMs',
  judge: '会话取证：存在 bash 调用 timeoutMs ≥ 135000；某次 bash 结果含整行 VERIFY_OK，且产出它的调用（或其前一次长调用）按事件时间戳实耗 ≥ 135000ms；stdout 含 VERIFY_OK 且退出 0；package.json/scripts/verify.js 与原件逐字节一致',
  task: '帮我跑一下 npm run verify 确认它能通过，然后把它输出的最后一行原样告诉我。'
    + '不要改 package.json 和 scripts/ 下的脚本（判分会校验它们与原件一致）。',
  timeoutMs: 420_000,

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(FIXTURE(repoRoot), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, stdout, exitCode, timedOut, sessionFile }) {
    if (timedOut) return { pass: false, detail: '任务整体超时被杀（420s）——大概率反复用不够的超时重跑' }

    // ① 脚本不许动：缩短等待不算跑过
    const frozen = assertFrozen(cwd, FIXTURE(repoRoot), FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }

    const answered = exitCode === 0 && stdout.includes(MARK)
    if (sessionFile === null) {
      // 没会话就没法取证。agent 本身没答对时照常判 fail；答对了却没会话是 harness 的病
      if (!answered) return { pass: false, detail: `stdout 无 ${MARK} 或退出码 ${exitCode}≠0，且无会话文件` }
      throw new Error('agent 退出 0 且 stdout 含 VERIFY_OK，但会话文件缺失，无法做过程取证')
    }

    // ② 取证：有没有一次 bash 调用把 timeoutMs 拉到够长
    const events = readSession(sessionFile)
    const bashCalls = toolCalls(sessionFile).filter(c => c.name === 'bash')
    const timeoutOf = (c) => (c.args && typeof c.args === 'object' ? c.args.timeoutMs : undefined)
    const fmtTimeout = (c) => (timeoutOf(c) === undefined ? '默认' : String(timeoutOf(c)))
    const longCalls = bashCalls.filter(c => Number(timeoutOf(c)) >= REQUIRED_TIMEOUT_MS)
    const hitDefault = bashCalls.some(c => /\[timed out after \d+ms\]/.test(toolResultText(events, c.callId)))
    const trace = `bash 共 ${bashCalls.length} 次，timeoutMs 依次：${bashCalls.map(fmtTimeout).join('、') || '（无）'}`
    if (longCalls.length === 0) {
      return { pass: false, detail: `没有任何 bash 调用带 timeoutMs ≥ ${REQUIRED_TIMEOUT_MS}；${trace}${hitDefault ? '；曾撞默认超时未补救' : ''}` }
    }

    // ③ 命令确实在 agent 手里跑完了：某次 bash 的结果文本含整行 VERIFY_OK（先看合格调用，再看其余——
    //    比如长调用把输出重定向到文件、另一次 tail 读出来也算）
    const ordered = [...longCalls, ...bashCalls.filter(c => !longCalls.includes(c))]
    const marked = ordered.filter(c => MARK_LINE.test(toolResultText(events, c.callId)))
    if (marked.length === 0) {
      return { pass: false, detail: `有 timeoutMs=${fmtTimeout(longCalls[0])} 的 bash 调用，但没有任何 bash 结果含整行 ${MARK}（命令没跑完）；${trace}` }
    }

    // ③' 耗时门槛：结果文本可以 echo 出来，135s 的墙钟时间 echo 不出来。产出 VERIFY_OK 的那次调用
    //    自身实耗 ≥ 135s；或者它之前有一次长调用（timeoutMs ≥ 135000）实耗 ≥ 135s（重定向再读出的变体）
    const elapsed = elapsedByCallId(events)
    const seqOf = (c) => (typeof c.seq === 'number' ? c.seq : -Infinity)
    const waited = (c) => elapsed(c.callId) >= REQUIRED_TIMEOUT_MS
    let completed
    let waitedCall
    for (const c of marked) {
      if (waited(c)) { completed = c; waitedCall = c; break }
      const prior = longCalls.find(l => l !== c && seqOf(l) < seqOf(c) && waited(l))
      if (prior !== undefined) { completed = c; waitedCall = prior; break }
    }
    if (completed === undefined) {
      const tried = marked.map(c => `${short(String(c.args?.command ?? ''), 40)}=${fmtMs(elapsed(c.callId))}`).join('、')
      return {
        pass: false,
        detail: `有 bash 结果含整行 ${MARK}，但产出它的调用实耗不足 ${REQUIRED_TIMEOUT_MS}ms（${tried}），`
          + `之前也没有实耗 ≥ ${REQUIRED_TIMEOUT_MS}ms 的长调用——verify 根本没跑完（结果文本是造出来的）；${trace}`,
      }
    }

    const evidence = `合格调用 timeoutMs=${fmtTimeout(longCalls[0])}（${short(String(longCalls[0].args.command ?? ''))}）`
      + `；${MARK} 出自${longCalls.includes(completed) ? '该调用' : `另一次 bash（${short(String(completed.args?.command ?? ''))}）`}`
      + `；实耗 ${fmtMs(elapsed(waitedCall.callId))}${waitedCall === completed ? '' : `（出自其前的长调用 ${short(String(waitedCall.args?.command ?? ''), 40)}）`}`
      + `；${hitDefault ? '首跑撞默认超时后补救' : '一次到位'}；${trace}`

    // ④ 把答案交给用户
    if (!answered) {
      return { pass: false, detail: `过程合格但回答不对：退出码 ${exitCode}，stdout ${stdout.includes(MARK) ? '含' : '无'} ${MARK}；${evidence}` }
    }
    return { pass: true, detail: `${evidence}；agent 退出码 ${exitCode}` }
  },
}
