/**
 * KingCode 的一次性任务驱动 —— 替代 @deepseek-ai/dsh-headless。
 *
 * 与上游同构（建 agent → followup → 等静默 → flush → 打印最终回答 → 按结果
 * 定退出码），但有三处刻意的差异：
 *
 * ① 诊断前缀是 `kingcode:` 而不是 `dsh:`——自有品牌的工具不该在报错时
 *    暴露宿主实现。
 * ② 核心服务缺失时上游是静默 `return`（进程会挂着不退、也不报错，
 *    看起来像卡死）；这里改成响亮报错并以非零码退出。
 * ③ 助手一句话都没产出时明确说明，而不是打印一个空行让人以为成功了——
 *    且退出码是 3 不是 0（见 exitCodeFor），CI 不该把「没有答案」当成功。
 *
 * 机读结果：环境变量 KINGCODE_RESULT_FILE 指定路径时，退出前落一行 JSON
 * {sessionId, reasonKind, errorCode, emptyOutput, exitCode}，给 eval harness 判分用。
 *
 * Loader 插件必须具名导出（default export 会丢 inject）。
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'kingcode-runner'

export const inject = ['agentDefaultModel', 'agents', 'sessions']

export const Config = z.object({ task: z.string().required() })

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
 * @param outcome - summarize 的结果。
 * @returns 进程退出码。
 */
export function exitCodeFor(outcome) {
  if (outcome.reason?.kind !== 'completed') return 1
  return outcome.text === '' ? 3 : 0
}

/**
 * KINGCODE_RESULT_FILE 已设时落一份机读结果（eval harness 的判分入口）。
 * 写失败不改变任务退出码，但要在 stderr 说清楚——harness 找不到文件时
 * 不该只能靠猜。
 * @param sessionId - 本次会话 id（对应 ./.kingcode/sessions 下的持久化文件）。
 * @param outcome - summarize 的结果。
 * @param exitCode - 已定的退出码。
 * @param io - 进程副作用。
 */
function writeResultFile(sessionId, outcome, exitCode, io) {
  const path = process.env['KINGCODE_RESULT_FILE']
  if (path === undefined || path === '') return
  const record = {
    sessionId,
    reasonKind: outcome.reason?.kind ?? null,
    errorCode: outcome.reason?.error?.code ?? null,
    emptyOutput: outcome.text === '',
    exitCode,
  }
  try {
    writeFileSync(path, JSON.stringify(record) + '\n')
  } catch (error) {
    io.stderr.write(`kingcode: 结果文件写入失败（${path}）：${error instanceof Error ? error.message : String(error)}\n`)
  }
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

  const selection = defaultModel.currentSelection()
  const sessionId = SessionId(`session-${randomUUID()}`)
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
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const outcome = summarize(agent.session.events, firstSeq)
  if (outcome.text !== '') {
    io.stdout.write(outcome.text + '\n')
  } else if (outcome.reason?.kind !== 'error') {
    // 打个空行会让人以为成功了，说清楚更好
    io.stderr.write('kingcode: 本轮没有产出任何助手文本\n')
  }
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`kingcode: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  const exitCode = exitCodeFor(outcome)
  writeResultFile(sessionId, outcome, exitCode, io)
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
