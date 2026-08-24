/**
 * KingCode 的一次性任务驱动 —— 替代 @deepseek-ai/dsh-headless。
 *
 * 与上游同构（建 agent → followup → 等静默 → flush → 打印最终回答 → 按结果
 * 定退出码），但有四处刻意的差异：
 *
 * ① 诊断前缀是 `kingcode:` 而不是 `dsh:`——自有品牌的工具不该在报错时
 *    暴露宿主实现。
 * ② 核心服务缺失时上游是静默 `return`（进程会挂着不退、也不报错，
 *    看起来像卡死）；这里改成响亮报错并以非零码退出。
 * ③ 助手一句话都没产出时明确说明，而不是打印一个空行让人以为成功了——
 *    且退出码是 3 不是 0（见 exitCodeFor），CI 不该把「没有答案」当成功。
 * ④ **生命周期是可观测、可打断、有上限的**：全程往 stderr 打进度流；
 *    SIGINT/SIGTERM 先取消 agent 再 flush 会话；KINGCODE_DEADLINE_MS 给
 *    整次调用一个墙钟上限。这三件事都不碰 stdout。
 *
 * 退出码契约：**0** = 完成且有回答；**3** = 完成但助手零输出；**4** = 触到
 * KINGCODE_DEADLINE_MS；**130** = SIGINT（Unix 惯例 128+2）；**143** = SIGTERM
 * （128+15）；**1** = 其余（错误/未收敛/参数错）。0/3/1 由纯函数 exitCodeFor 定，
 * 4/130/143 走另一条路径（终止不是「结果」，不该污染那个纯函数）。
 *
 * 机读结果：环境变量 KINGCODE_RESULT_FILE 指定路径时，退出前落一行 JSON
 * {sessionId, reasonKind, errorCode, emptyOutput, exitCode, termination, signal}，
 * 给 eval harness 判分用。termination 为 'normal' | 'deadline' | 'signal'，
 * signal 仅在 'signal' 时为 'SIGINT'/'SIGTERM'，否则 null。
 *
 * 环境变量：
 * - `KINGCODE_QUIET=1`：关掉 stderr 进度流（错误诊断不受影响）。默认是**开**的。
 * - `KINGCODE_DEADLINE_MS=<毫秒>`：整次调用的墙钟上限；不设则无限制。
 *
 * **不做后台 job 收敛**：后台执行面在工具层整体关闭（见 AGENTS.md
 * 「几条刻意的决定」），一次性 CLI 退出即 dispose 整棵树，没有树外存活的工作
 * 需要 drain。
 *
 * Loader 插件必须具名导出（default export 会丢 inject）。
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createProgress } from './progress.js'

export const name = 'kingcode-runner'

export const inject = ['agentDefaultModel', 'agents', 'sessions']

export const Config = z.object({ task: z.string().required() })

/** setTimeout 的 32 位上限；超过它 Node 会把延时钳成 1ms。 */
export const MAX_DEADLINE_MS = 2_147_483_647

/** 触到 KINGCODE_DEADLINE_MS 的专用退出码。 */
export const DEADLINE_EXIT_CODE = 4

/** 信号退出码：Unix 惯例 128 + 信号号。 */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }

/**
 * 退出前等 stdout 排空的上限。
 *
 * process.exit 会把管道缓冲区里没排空的部分直接剁掉：答案超过管道缓冲区
 * （macOS 64 KiB）且下游读得慢时，stdout 被静默截断而退出码仍是 0——而
 * 「0 才意味着 stdout 上有完整回答」现在是写进四份文档的契约。写文件是同步的
 * 不受影响，受害的是 `kingcode … | 慢处理器` 这类管道消费者。
 * 上限存在的理由同样直白：下游永远不读时，宁可截断也不能永远挂着。
 */
export const STDOUT_FLUSH_MS = 10_000

/** 取消后等待 agent 收敛到 idle 的上限；到点就直接 flush，不无限等。 */
export const CANCEL_GRACE_MS = 5_000

/** 收尾整体的硬上限：dispose 卡住时也必须退出，否则「取消卡住就再也退不出去」。 */
export const HARD_EXIT_MS = 15_000

/** 可替换的进程流，便于测试捕获。 */
export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * 从本轮事件里汇总最后一条助手文本与收敛原因。
 * @param events - 会话事件流。
 * @param firstSeq - 本轮开始时的序号，之前的都不算。
 * @returns 最终文本与结束原因。
 */
export function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * 退出码契约：0=完成且有回答；3=完成但零输出（CI 不该把「没有答案」当成功）；
 * 其余（错误/未收敛）=1。3 仍是非零，不破坏「非零即失败」的外部脚本。
 *
 * **纯函数，只描述「跑完之后的结果」**：deadline（4）与信号（130/143）是
 * 「没跑完就被截断」，由 windDown 直接给码，不进这里——否则这个函数就得知道
 * 进程状态，测试也就不再是纯的了。
 * @param outcome - summarize 的结果。
 * @returns 进程退出码。
 */
export function exitCodeFor(outcome) {
  if (outcome.reason?.kind !== 'completed') return 1
  return outcome.text === '' ? 3 : 0
}

/**
 * 解析 KINGCODE_DEADLINE_MS。不设 / 空串 → undefined（无限制）；
 * 非正整数 → null（调用方要响亮拒绝，静默忽略等于护栏失灵）。
 * @param raw - 环境变量原值。
 * @returns 毫秒数、undefined（未设）或 null（非法）。
 */
export function parseDeadlineMs(raw) {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = raw.trim()
  // 严格十进制：Number() 会悄悄收下 0x10 / 1e3 / +5，让人以为设的是别的数
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  // 上界不是洁癖：setTimeout 超过 32 位会被 Node 钳成 1ms，于是「设 1000 天等于
  // 不限时」会变成「每次调用 0.0s 就退 4」——护栏不是失灵，是反过来咬人。
  if (value <= 0 || value > MAX_DEADLINE_MS) return null
  return value
}

/**
 * 装 SIGINT/SIGTERM 处理器：第一次交给 graceful（取消 agent → flush → 按码退出），
 * **第二次同一信号立即硬退**——取消路径自己卡住时，用户还得能把它按掉。
 *
 * proc 与回调都从外面注入，这样测试不用真发信号也能验这套分派。
 * @param proc - 事件源（生产上就是 process）。
 * @param handlers - 回调。
 * @param handlers.graceful - 首次收到某信号时调用，入参 (signal, exitCode)。
 * @param handlers.hard - 再次收到同一信号时调用，入参 (signal, exitCode)。
 * @returns 卸载全部处理器的函数。
 */
export function installSignalHandlers(proc, handlers) {
  const seen = new Set()
  const offs = []
  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    const listener = () => {
      if (seen.has(signal)) { handlers.hard(signal, exitCode); return }
      seen.add(signal)
      handlers.graceful(signal, exitCode)
    }
    proc.on(signal, listener)
    offs.push(() => proc.off(signal, listener))
  }
  return () => { for (const off of offs) off() }
}

/**
 * KINGCODE_RESULT_FILE 已设时落一份机读结果（eval harness 的判分入口）。
 * 写失败不改变任务退出码，但要在 stderr 说清楚——harness 找不到文件时
 * 不该只能靠猜。
 * @param sessionId - 本次会话 id（对应 ./.kingcode/sessions 下的持久化文件）。
 * @param outcome - summarize 的结果。
 * @param exitCode - 已定的退出码。
 * @param io - 进程副作用。
 * @param ending - 结局类型：{ termination: 'normal'|'deadline'|'signal', signal }。
 */
function writeResultFile(sessionId, outcome, exitCode, io, ending = { termination: 'normal', signal: null }) {
  // outcome 可能没有（硬退时轮次还没闭合）——那也要写：harness 最需要区分
  // 「被外力砍掉」的恰恰就是这种时候，只剩一个退出码是不够的
  outcome = outcome ?? { text: '', reason: undefined }
  const path = process.env['KINGCODE_RESULT_FILE']
  if (path === undefined || path === '') return
  const record = {
    sessionId,
    reasonKind: outcome.reason?.kind ?? null,
    errorCode: outcome.reason?.error?.code ?? null,
    emptyOutput: outcome.text === '',
    exitCode,
    termination: ending.termination,
    signal: ending.signal ?? null,
  }
  try {
    writeFileSync(path, JSON.stringify(record) + '\n')
  } catch (error) {
    io.stderr.write(`kingcode: 结果文件写入失败（${path}）：${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * 到点就 resolve 的等待，用于给「等 agent 收敛」封顶。
 * 刻意**不** unref：unref 的定时器撑不住事件循环，真到「只剩它一个 handle」时
 * node 会自己以 0 退出，护栏与信号收尾就都变成了一句空话。收尾路径最后一定会
 * 走到 io.exit → process.exit，残留的定时器由进程退出带走。
 */
function after(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}


/**
 * 等 stdout 落到 OS，最多等 STDOUT_FLUSH_MS。
 * 替身流（测试里的捕获流）没有 writableLength/写回调，直接放行。
 * @param stream - 目标流。
 * @returns 排空、或到点后 resolve。
 */
function flushStdout(stream) {
  if (typeof stream.writableLength !== 'number' || stream.writableLength === 0) return Promise.resolve()
  return Promise.race([
    new Promise(resolve => { stream.write('', () => resolve()) }),
    after(STDOUT_FLUSH_MS),
  ])
}

/**
 * 跑完一轮任务并请求退出。
 * @param ctx - 插件上下文。
 * @param task - 任务文本。
 * @param io - 面向进程的副作用（流与退出）。
 */
async function run(ctx, task, io) {
  // Loader 的兄弟条目是并发挂载的，必须等整棵树就绪再建 agent，
  // 否则它的 scoped 工具与适配器可能只装配了一半。
  await ctx.get('loader')?.await()

  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // 上游在这里是静默 return —— 进程既不报错也不退出，表现得像卡死。
  // 缺哪个就说哪个。
  const missing = [
    agents === undefined && 'agents',
    defaultModel === undefined && 'agentDefaultModel',
    sessions === undefined && 'sessions',
  ].filter(Boolean)
  if (missing.length > 0) {
    // 服务缺席通常只是后果：某个插件 apply 抛错，它本该 provide 的服务就没了。
    // boot() 会带着真因 reject（"failed to apply loader entry <名字>: <原因>"），
    // 但那条 rejection 要等 installFailLoud 的 unhandledRejection 钩子才落地，
    // 而这里若立刻 exit 就把它掐掉了——只剩一句「缺少核心服务」，排查方向被带偏。
    // 让出一轮宏任务：真因先打印并退出，进程还活着才轮到下面这句兜底。
    await new Promise(resolve => setTimeout(resolve, 0))
    io.stderr.write(`kingcode: 组合树缺少核心服务：${missing.join('、')}`
      + '（若上方有插件挂载失败，那才是原因）\n')
    io.exit(1)
    return
  }

  const quiet = (process.env['KINGCODE_QUIET'] ?? '') !== '' && process.env['KINGCODE_QUIET'] !== '0'
  const progress = createProgress({ write: chunk => io.stderr.write(chunk), quiet, cwd: process.cwd() })

  const deadlineMs = parseDeadlineMs(process.env['KINGCODE_DEADLINE_MS'])
  if (deadlineMs === null) {
    io.stderr.write(`kingcode: KINGCODE_DEADLINE_MS 必须是 1..2147483647 之间的十进制整数毫秒，实际是 `
      + `「${process.env['KINGCODE_DEADLINE_MS']}」——护栏宁可拒收也不静默忽略\n`)
    io.exit(1)
    return
  }

  const selection = defaultModel.currentSelection()
  const sessionId = SessionId(`session-${randomUUID()}`)

  // 事件总线先订上再建 agent：agent 创建期就会落事件（session/title、request/header…），
  // 晚订就把开头那段最容易「看起来没动静」的时间漏掉了。
  // 根 ctx 的监听不带 agent scope，因此子代理会话的事件也会到这里——用 session.id 区分。
  const offEvents = ctx.on('session/event', (session, event) => {
    try {
      progress.event(event, { main: session?.id === sessionId })
    } catch (error) {
      // 渲染进度绝不能反过来打断任务
      io.stderr.write(`kingcode: 进度渲染失败（已忽略）：${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  progress.note(`kingcode 启动：${selection.provider}/${selection.model}`
    + `${deadlineMs === undefined ? '' : `，deadline ${(deadlineMs / 1000).toFixed(1)}s`}`)

  const { agent } = await agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })

  await agent.whenIdle()
  const firstSeq = agent.session.seq

  // ── 收尾：正常完成、deadline、信号三条路共用一个出口 ─────────────────────
  let winding = false
  // 与 winding 分开：正常出口也会置 winding，但那时答案已经产出，此时再来信号
  // 应当被忽略（硬退会把已经拿到的回答丢掉）；只有截断收尾中才允许升级硬退。
  let truncating = false
  let deadlineTimer

  /**
   * 被截断的收尾（deadline / 信号）：取消 agent → 等它收敛（有上限）→ flush →
   * 说清在哪一步被截断 → 按专用码退出。stdout 一个字节都不写：这次没有「回答」，
   * 打半截答案会让 `0=有回答` 的契约变得可疑。
   * @param ending - { termination, signal, exitCode, label }。
   */
  async function windDown(ending) {
    if (winding) {
      progress.note(truncating
        ? `（${ending.label}：已在收尾中，再来一个信号将立即硬退）`
        // 正常出口：答案已经算出来了，正在写盘。此时硬退等于把它扔掉，所以
        // 只有「同一信号再来一次」才放弃——说清楚，别让人以为按了没反应。
        : `（${ending.label}：任务已完成、正在写盘；再发一次同一信号才会放弃这次的回答）`)
      return
    }
    winding = true
    truncating = true
    clearTimeout(deadlineTimer)
    // dispose 或取消卡住时的最后一道闸：到点直接硬退，别让人再也退不出去
    setTimeout(() => {
      io.stderr.write(`kingcode: 收尾超过 ${HARD_EXIT_MS / 1000}s 仍未结束，硬退（退出码 ${ending.exitCode}）\n`)
      writeResultFile(sessionId, undefined, ending.exitCode, io, ending)
      process.exit(ending.exitCode)
    }, HARD_EXIT_MS)

    progress.note(`${ending.label}：取消 agent 并收尾`)
    try { agent.cancel({ kind: 'user' }) } catch { /* 已经没有活动可取消 */ }
    await Promise.race([agent.whenIdle(), after(CANCEL_GRACE_MS)])
    try {
      await sessions.flush(agent.session)
    } catch (error) {
      io.stderr.write(`kingcode: 会话 flush 失败：${error instanceof Error ? error.message : String(error)}\n`)
    }

    const outcome = summarize(agent.session.events, firstSeq)
    progress.note(`收尾完成：${ending.label}，共 ${(progress.elapsed() / 1000).toFixed(1)}s，`
      + `会话 ${sessionId}，收敛原因 ${outcome.reason?.kind ?? '无（轮次未闭合）'}`)
    io.stderr.write(`kingcode: ${ending.label}——本次没有最终回答，stdout 为空；`
      + `已取消 agent 并写盘会话（退出码 ${ending.exitCode}）\n`)
    offEvents()
    offSignals() // 收尾已进入不可撤销段，再来的信号交回默认行为（进程直接死）比半途改主意安全
    writeResultFile(sessionId, outcome, ending.exitCode, io, ending)
    io.exit(ending.exitCode)
  }

  // 处理器与 deadline 都得等 agent 到手才能装（收尾要 cancel 它、要 flush 它的会话）。
  // 在此之前的那扇窗口（挂树 + agents.create，实测 0.1s 量级）信号走默认行为：
  // 进程直接死。那时会话里最多只有 header，没有「尾部丢失」可言，不值得为它
  // 铺一条什么都做不了的收尾路径。
  const offSignals = installSignalHandlers(process, {
    graceful: (signal, exitCode) => {
      // 截断收尾已在进行时，换一个信号也算升级：supervisor 的标准序列是
      // INT → TERM → KILL，若只认「同一信号第二次」，那记 TERM 就白发了。
      if (truncating) {
        io.stderr.write(`kingcode: 收尾期间又收到 ${signal}，立即硬退（退出码 ${exitCode}）\n`)
        writeResultFile(sessionId, undefined, exitCode, io, { termination: 'signal', signal })
        process.exit(exitCode)
        return
      }
      void windDown({ termination: 'signal', signal, exitCode, label: `收到 ${signal}` })
    },
    hard: (signal, exitCode) => {
      io.stderr.write(`kingcode: 再次收到 ${signal}，立即硬退（退出码 ${exitCode}）\n`)
      writeResultFile(sessionId, undefined, exitCode, io, { termination: 'signal', signal })
      process.exit(exitCode)
    },
  })

  if (deadlineMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      void windDown({
        termination: 'deadline',
        signal: null,
        exitCode: DEADLINE_EXIT_CODE,
        label: `触到 deadline ${(deadlineMs / 1000).toFixed(1)}s`,
      })
    }, deadlineMs)
  }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  if (winding) return // deadline/信号已经接管了收尾，别再走正常出口

  winding = true // 从这里起不再接受截断：正常出口已经开始
  clearTimeout(deadlineTimer)
  await sessions.flush(agent.session)

  const outcome = summarize(agent.session.events, firstSeq)
  const exitCode = exitCodeFor(outcome)
  progress.note(`完成：${(progress.elapsed() / 1000).toFixed(1)}s，`
    + `${outcome.reason?.kind ?? '无收敛原因'}，回答 ${outcome.text.length} 字，退出码 ${exitCode}`)
  offEvents()
  offSignals()

  if (outcome.text !== '') {
    io.stdout.write(outcome.text + '\n')
  } else if (outcome.reason?.kind !== 'error') {
    // 打个空行会让人以为成功了，说清楚更好
    io.stderr.write('kingcode: 本轮没有产出任何助手文本\n')
  }
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`kingcode: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  writeResultFile(sessionId, outcome, exitCode, io)
  await flushStdout(io.stdout) // 见 STDOUT_FLUSH_MS：不等就可能把答案剁在 64 KiB
  io.exit(exitCode)
}

/**
 * 挂载一次性驱动。
 * @param ctx - 插件上下文（需 launcher 先 provide appExit）。
 * @param config - 校验后的任务配置。
 */
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('kingcode-runner: launcher 必须在挂树前 provide ctx.appExit')
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  run(ctx, config.task, io).catch(error => {
    // 打全栈与 cause 链——agents.create/loader 阶段的失败只给 message 等于让人猜
    io.stderr.write(`kingcode: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    io.exit(1)
  })
}
