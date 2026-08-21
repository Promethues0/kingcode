/**
 * KingCode 的运行环境上下文：把今天日期、平台、git 分支与工作树状态注入模型。
 *
 * 走 systemPrompt.context() 而不是 section()：section 进 system prompt，每次
 * 请求重复发送；context 由 agent-loop 每 step 拼成一条「runtime context」用户
 * 消息，且**只在文本变化时才重新注入**（RuntimeContextProjection.project 对比
 * 上一份快照）。所以这里的文本必须稳定：日期只到天（带时间每 step 都变，
 * 等于每 step 白塞一条消息），git 状态在 apply 时拍一次快照，之后不再刷新。
 *
 * 两条硬约束：
 * ① provider 每次 assemble 都会被调用（每 step 一次），里面**不能 spawn 进程**
 *    ——git 只在 apply 时用 execFileSync 跑一次，结果缓存。
 * ② provider 必须返回 string（不能 undefined），且不能抛：不在 git 仓库、
 *    git 没装、git 超时都如实写进文本，不影响 agent 启动。
 *
 * Loader 插件必须具名导出 name/inject/apply（default export 会静默丢 inject）。
 */

import { execFileSync } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

export const name = 'kingcode-env-context'

export const inject = ['systemPrompt']

/**
 * cwd 默认取进程 cwd，与 fs-local 的 `cwd: !!js process.cwd()` 同源。
 * git: false 时不拍 git 快照、不写 git 行——给 Web 预设用：那里一个 dsh 进程服务多个
 * 工作区会话，process.cwd() 是服务进程的目录而不是会话的工作区，git 行只会说错话。
 */
export const Config = z.object({ cwd: z.string(), git: z.boolean().default(true) })

/** context 名与 order。上游已占：110 sandbox:policy、115 approval:policy、120 subagent:delegation；环境事实排最前。 */
export const CONTEXT_NAME = 'kingcode:env'
export const CONTEXT_ORDER = 10

/** 单条 git 命令的超时：大仓库 status 可能慢，但不能拖住启动。 */
const GIT_TIMEOUT_MS = 5000

/** 本地时区的 ISO 日期（YYYY-MM-DD）。不用 toISOString()：那是 UTC，东八区晚上会差一天。 */
export function localIsoDate(now = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 跑一条 git 子命令，返回去掉首尾空白的 stdout；失败按原样抛（调用方分类）。 */
function git(cwd, args, exec) {
  return String(exec('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })).trim()
}

/**
 * 对 cwd 拍一次 git 快照。永不抛。
 *
 * 返回值的 kind：
 * - `repo`：在 git 工作树里，带 branch / detached / dirty / changed
 * - `not-a-repo`：cwd 不在任何 git 仓库里
 * - `unavailable`：git 不在 PATH（ENOENT）
 * - `error`：其它失败（超时、权限等），带 reason
 *
 * @param cwd - 要检查的目录。
 * @param exec - 可替换的 execFileSync（测试注入假的）。
 */
export function snapshotGit(cwd, exec = execFileSync) {
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree'], exec)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'unavailable' }
    // 不在仓库里 git 以 128 退出；其它非零码也归到这里——对模型而言都是「没有 git 信息」
    if (typeof error?.status === 'number') return { kind: 'not-a-repo' }
    return { kind: 'error', reason: error?.code ?? error?.message ?? String(error) }
  }
  try {
    // symbolic-ref 在「刚 init 还没提交」的 unborn 分支上也能给出分支名；
    // 它在 detached HEAD 上会失败，这时退回短 sha。
    let branch
    let detached = false
    try {
      branch = git(cwd, ['symbolic-ref', '--short', 'HEAD'], exec)
    } catch {
      branch = git(cwd, ['rev-parse', '--short', 'HEAD'], exec)
      detached = true
    }
    const porcelain = git(cwd, ['status', '--porcelain'], exec)
    const changed = porcelain === '' ? 0 : porcelain.split('\n').length
    return { kind: 'repo', branch, detached, dirty: changed > 0, changed }
  } catch (error) {
    return { kind: 'error', reason: error?.code ?? error?.message ?? String(error) }
  }
}

/** 把 git 快照写成一行。 */
export function describeGit(snapshot) {
  switch (snapshot.kind) {
    case 'repo': {
      const head = snapshot.detached ? `detached HEAD at ${snapshot.branch}` : `branch ${snapshot.branch}`
      const tree = snapshot.dirty
        ? `working tree dirty (${snapshot.changed} changed path${snapshot.changed === 1 ? '' : 's'})`
        : 'working tree clean'
      return `git: ${head}, ${tree}`
    }
    case 'not-a-repo':
      return 'git: not a git repository'
    case 'unavailable':
      return 'git: not available (git not found in PATH)'
    default:
      return `git: unknown (${snapshot.reason})`
  }
}

/**
 * 渲染整段上下文。context 文本会经 {{变量}} 插值，分支名里万一带 `{{`
 * 会让整次 assemble 抛错，这里先拆开。
 */
export function renderEnvContext({ date, git: gitLine }) {
  const lines = [
    'Environment:',
    `date: ${date}`,
    `platform: ${process.platform} ${process.arch}, node ${process.version}`,
  ]
  if (gitLine !== undefined) lines.push(gitLine)
  return lines.join('\n').replaceAll('{{', '{ {')
}

/**
 * 构造 provider：git 在此刻拍快照并缓存，provider 本身只拼字符串。
 * @param options.cwd - git 检查目录，默认 process.cwd()。
 * @param options.exec - 可替换的 execFileSync。
 * @param options.now - 可替换的时钟（返回 Date）。
 * @param options.git - false 则完全不碰 git（不 spawn、不写 git 行）。
 */
export function createProvider({ cwd = process.cwd(), exec = execFileSync, now = () => new Date(), git = true } = {}) {
  const gitLine = git ? describeGit(snapshotGit(cwd, exec)) : undefined
  return () => {
    try {
      return renderEnvContext({ date: localIsoDate(now()), git: gitLine })
    } catch {
      // provider 绝不能让 assemble 失败；退化成最少的事实也比抛错强
      return `Environment:\nplatform: ${process.platform}`
    }
  }
}

/**
 * 注册一条运行时上下文。
 * @param ctx - 插件上下文（需 systemPrompt 服务）。
 * @param config - 可选 `{ cwd, git }`。
 */
export function apply(ctx, config = {}) {
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: createProvider({ cwd: config.cwd ?? process.cwd(), git: config.git ?? true }),
  })
}
