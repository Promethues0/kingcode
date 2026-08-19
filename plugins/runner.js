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
 * ③ 助手一句话都没产出时明确说明，而不是打印一个空行让人以为成功了。
 *
 * Loader 插件必须具名导出（default export 会丢 inject）。
 */

import { randomUUID } from 'node:crypto'
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
function summarize(events, firstSeq) {
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
    io.stderr.write(`kingcode: 组合树缺少核心服务：${missing.join('、')}\n`)
    io.exit(1)
    return
  }

  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
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
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
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
    io.stderr.write(`kingcode: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
