/**
 * KingCode 的 stderr 进度流 —— 把会话事件渲染成人/CI 都能读的逐行进度。
 *
 * 为什么存在：runner 从 followup 到 whenIdle 之间一个字都不打，最坏可静默十几
 * 分钟（模型重试退避、长命令、子代理），用户与 CI 都无从区分「在干活」和「死了」。
 *
 * 三条硬约束：
 * ① **只写 stderr**。stdout 是产品输出（最终回答），一个字节都不许污染。
 * ② **不用 ANSI**。stderr 常被重定向进日志文件，颜色只会变成乱码。
 * ③ **每行带相对起始的秒数**，且整行裁到一屏宽度内——事后翻日志要能一眼
 *    看出卡在哪一步、卡了多久；参数可能有几 KB，必须截断。
 *
 * 事件名与形状取自现场（node_modules/@deepseek-ai/dsh-session 的 SessionEventMap、
 * dsh-llm-retry 的 SessionEventMap 合并声明，以及 .kingcode/sessions-plain 下的
 * 真实 jsonl），不是猜的：
 * - turn/start {turn} · turn/end {turn, reason:{kind,...}} · step/start {turn, step}
 * - tool/call {turn, step, callId, name, arguments}（arguments 是模型原样产出的
 *   JSON 字符串，未解析）· tool/result {turn, step, message, error?:{name,code}}
 * - assistant/message {turn, step, message, usage?, interrupted?}
 * - llm/retry {retryId, turn, step, provider, mode, retry, maxRetries?, delayMs,
 *   failure:{message, code, status?}} · llm/retry-started {retryId, turn, step, retry}
 */

import { basename, relative, sep } from 'node:path'

/** 一行的最大宽度（含时间戳前缀）。80 太窄，命令行摘要会被切成没用的碎片。 */
export const LINE_WIDTH = 100

/** 工具参数摘要里单个字段的最大长度（bash 命令按需求给 ~80 字符）。 */
export const ARG_WIDTH = 80

/**
 * 把字符串压成单行并截断到 max：换行/制表变空格，超长补 `…`。
 * @param value - 原始文本。
 * @param max - 最大长度（含省略号）。
 * @returns 单行且不超过 max 的文本。
 */
export function clip(value, max) {
  // 先剥控制字符再压空白：工具参数与助手文本都是模型可控的，里面的 ESC/BEL/BS
  // 会原样进 stderr——那正是本文件开头「不用 ANSI」想避免的东西（清屏、改标题、
  // 日志里一堆乱码），只不过来源不是渲染器自己。\t\n\r 交给下面的 \s+ 处理。
  const printable = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '·')
  const flat = printable.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * 把绝对路径压成相对 cwd 的短形式；不在 cwd 之下的退回文件名。
 * 工具参数里的路径基本都是绝对路径，原样打会把一行全占满。
 * @param value - 路径字符串。
 * @param cwd - 当前工作目录。
 * @returns 便于阅读的短路径。
 */
export function shortPath(value, cwd) {
  if (typeof value !== 'string' || value === '') return ''
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) return value
  const rel = relative(cwd, value)
  if (rel !== '' && !rel.startsWith('..' + sep) && rel !== '..') return rel
  return basename(value)
}

/** 第一个有内容的字符串字段——未知工具的兜底摘要。 */
function firstStringField(args) {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.trim() !== '') return `${key}=${value}`
  }
  return ''
}

/**
 * 工具调用的关键参数摘要。按工具名分派，未知工具走兜底。
 * 输入是模型原样产出的 JSON 字符串——**可能不是合法 JSON**（模型截断/乱写），
 * 解析失败时退回原始串的截断，绝不因为渲染进度而让主流程抛错。
 * @param toolName - tool/call 事件的 name。
 * @param rawArguments - tool/call 事件的 arguments（未解析的 JSON 字符串）。
 * @param cwd - 用于把绝对路径压短的工作目录。
 * @returns 一行参数摘要（可能为空串）。
 */
export function summarizeToolArgs(toolName, rawArguments, cwd) {
  let args
  try {
    args = JSON.parse(rawArguments ?? '')
  } catch {
    return clip(rawArguments ?? '', ARG_WIDTH)
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return clip(String(rawArguments ?? ''), ARG_WIDTH)
  }
  const p = (key) => shortPath(args[key], cwd)
  switch (toolName) {
    case 'bash':
      return clip(args.command ?? '', ARG_WIDTH)
    case 'read':
    case 'read_image':
    case 'write':
      return clip(p('file_path'), ARG_WIDTH)
    case 'edit':
      return clip(p('file_path'), ARG_WIDTH)
    case 'multi_edit': {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const files = [...new Set(edits.map(e => shortPath(e?.file_path, cwd)).filter(Boolean))]
      return clip(`${edits.length} 处改动 ${files.join(' ')}`, ARG_WIDTH)
    }
    case 'grep': {
      const where = p('path')
      const include = typeof args.include === 'string' ? ` include=${args.include}` : ''
      return clip(`/${args.pattern ?? ''}/${where ? ' in ' + where : ''}${include}`, ARG_WIDTH)
    }
    case 'glob':
      return clip(`${args.pattern ?? ''}${args.path ? ' in ' + p('path') : ''}`, ARG_WIDTH)
    case 'lsp': {
      const at = args.line === undefined ? '' : `:${args.line}:${args.character ?? 0}`
      return clip(`${args.operation ?? ''} ${p('file_path')}${at}`, ARG_WIDTH)
    }
    case 'todo_write':
      return `${Array.isArray(args.todos) ? args.todos.length : 0} 条待办`
    case 'subagent':
    case 'subagent_fork':
    case 'explore':
      return clip(args.description ?? args.prompt ?? '', ARG_WIDTH)
    case 'web_fetch':
      return clip(args.url ?? '', ARG_WIDTH)
    case 'web_search':
      return clip(args.query ?? '', ARG_WIDTH)
    default:
      return clip(firstStringField(args), ARG_WIDTH)
  }
}

/** `[  12.3s] ` 形式的时间戳前缀，右对齐到固定宽度，便于 grep 与目测。 */
function stamp(elapsedMs) {
  return `[${(elapsedMs / 1000).toFixed(1).padStart(7)}s] `
}

/** 时长的紧凑写法，用在工具完成行上。 */
function dur(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/** turn/end 的收敛原因压成一个短词（aborted 带上是谁取消的）。 */
function reasonLabel(reason) {
  if (reason === undefined || reason === null) return '未知'
  if (reason.kind === 'aborted') return `aborted/${reason.reason?.kind ?? '?'}`
  if (reason.kind === 'error') return `error/${reason.error?.code ?? '?'}`
  return String(reason.kind)
}

/**
 * 建一个进度渲染器。
 *
 * 静默开关由调用方传入（runner 读 KINGCODE_QUIET）：quiet 为真时**一个字节都不写**，
 * 连 note() 也不写——CI 里要的是「完全没有进度流」，而不是「少几行」。
 * 错误诊断不归这里管，runner 照旧直接写 stderr。
 *
 * @param options - 渲染器配置。
 * @param options.write - 写一行的副作用（必须是 stderr）。
 * @param options.now - 取当前毫秒（可注入，便于测试）。
 * @param options.quiet - 为真则完全静默。
 * @param options.cwd - 压短路径用的工作目录。
 * @returns 渲染器：event() 喂会话事件，note() 打一条自有说明。
 */
export function createProgress({ write, now = () => Date.now(), quiet = false, cwd = process.cwd() }) {
  const startedAt = now()
  /** callId → 调用开始时刻，用来在 tool/result 上打出这次调用真花了多久。 */
  const pending = new Map()
  /** retryId → 退避开始时刻，用来在 retry-started 上打出真等了多久。 */
  const retrying = new Map()

  const emit = (body) => {
    if (quiet || body === null || body === '') return
    // 先裁正文再拼前缀：clip 会把连续空白压成一个空格，先拼就把时间戳的右对齐
    // padding 吃掉了（`[   12.3s]` 变成 `[ 12.3s]`），一列数字就再也对不齐。
    // 缩进（工具行相对轮/步行）同理，得在 clip 之外单独留出来。
    const prefix = stamp(now() - startedAt)
    const indent = /^ */.exec(body)[0]
    write(prefix + indent + clip(body, LINE_WIDTH - prefix.length - indent.length) + '\n')
  }

  return {
    /** 相对起始的毫秒数，收尾时给「跑了多久」用。 */
    elapsed: () => now() - startedAt,

    /**
     * 打一条 runner 自己的说明（取消、超时、收尾结论）。
     * @param body - 一行文本。
     */
    note(body) {
      emit(body)
    },

    /**
     * 渲染一条会话事件。
     * @param event - session/event 送来的事件（形状见文件头注释）。
     * @param options - 渲染选项。
     * @param options.main - 是否主会话；子代理会话只渲染工具与轮次收尾，避免刷屏。
     */
    event(event, { main = true } = {}) {
      if (quiet) return
      const type = event?.type
      const data = event?.data ?? {}
      if (!main) {
        // 子代理有自己的会话；全量渲染会淹掉主线，只留「它在动」的最小证据
        if (type === 'tool/call') emit(`  └ 子代理 ${data.name} ${summarizeToolArgs(data.name, data.arguments, cwd)}`)
        else if (type === 'turn/end') emit(`  └ 子代理结束（${reasonLabel(data.reason)}）`)
        return
      }
      switch (type) {
        case 'turn/start':
          emit(`─ 轮 ${data.turn} 开始`)
          break
        case 'step/start':
          emit(`步 ${data.turn}.${data.step} 请求模型`)
          break
        case 'tool/call':
          pending.set(data.callId, { at: now(), name: data.name })
          emit(`  ${data.name} ${summarizeToolArgs(data.name, data.arguments, cwd)}`)
          break
        case 'tool/result': {
          const callId = data.message?.source?.callId
          const started = pending.get(callId)
          if (started !== undefined) pending.delete(callId)
          const spent = started === undefined ? '' : ` ${dur(now() - started.at)}`
          // 工具名要带上：并发调用时（一次 13 个 read 很常见）收尾行会乱序回来，
          // 全是一模一样的「└ 完成」，「卡在哪一步」就又看不出来了
          const who = started?.name === undefined ? '' : ` ${started.name}`
          const failed = data.error !== undefined
            || data.message?.content?.some(block => block?.isError === true) === true
          emit(`  └${who} ${failed ? `失败${spent}${data.error?.code ? '：' + data.error.code : ''}` : `完成${spent}`}`)
          break
        }
        case 'assistant/message': {
          const text = (data.message?.content ?? [])
            .filter(block => block?.type === 'text')
            .map(block => block.text)
            .join('')
          if (text.trim() !== '') emit(`  助手 ${clip(text, 60)}`)
          break
        }
        case 'llm/retry': {
          retrying.set(data.retryId, now())
          const of = data.maxRetries === undefined ? '' : `/${data.maxRetries}`
          emit(`! 模型重试 ${data.retry}${of} 退避 ${dur(data.delayMs)}`
            + `（${data.provider}${data.failure?.code ? ' ' + data.failure.code : ''}`
            + `${data.failure?.status ? ' HTTP ' + data.failure.status : ''}）`)
          break
        }
        case 'llm/retry-started': {
          const waitedFrom = retrying.get(data.retryId)
          if (waitedFrom !== undefined) retrying.delete(data.retryId)
          emit(`! 模型重试 ${data.retry} 开始${waitedFrom === undefined ? '' : `（实等 ${dur(now() - waitedFrom)}）`}`)
          break
        }
        case 'compaction/start':
          emit('~ 上下文压缩开始')
          break
        case 'compaction/end':
          emit('~ 上下文压缩结束')
          break
        case 'turn/end':
          emit(`─ 轮 ${data.turn} 结束（${reasonLabel(data.reason)}）`)
          break
        default:
          // 其余事件（assistant/chunk、request/header、user/message…）刻意不渲染：
          // chunk 是 token 级的，一轮几百条，打出来只会把真正的进度冲走
          break
      }
    },
  }
}
