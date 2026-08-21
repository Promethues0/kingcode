/**
 * eval 任务作者的零依赖工具箱：防作弊比对、目录差异、带超时的判分命令、
 * 会话 jsonl 解析（工具调用序列 / 真实用量）、夹具复制。
 *
 * 全部同步、纯 node 内置模块；任何函数都不问模型。run.js 自己也用这里的
 * readSession / sessionUsage 聚合用量——契约只有一份，不在两处各写一遍。
 *
 * 会话 jsonl 的事件形状（读自真实会话，不是猜的）：
 *   {"type":"tool/call","seq":63,"time":…,"data":{"turn":1,"step":1,
 *     "callId":"call_…","name":"bash","arguments":"{\"command\":\"npm test\"}"}}
 *   {"type":"assistant/message","seq":62,"time":…,"data":{"turn":1,"step":1,
 *     "message":{…},"usage":{"inputTokens":3160,"outputTokens":89,
 *     "cacheReadTokens":0,"reasoningTokens":18}}}
 *   （assistant/chunk 里还有一份 chunk.type==='usage' 的同值副本——聚合只认
 *   assistant/message，免得重复计数。）
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 逐字节比对一组不许改的文件（测试、判分夹具等）。
 * 任一文件在 runDir 里被删、被改、或原件本身缺失都算 changed。
 *
 * @param {string} runDir    agent 干活的目录
 * @param {string} originDir 夹具原件目录
 * @param {string[]} relPaths 相对两目录的文件路径清单
 * @returns {{ ok: boolean, changed: Array<{ path: string, reason: 'modified'|'missing'|'origin-missing' }> }}
 */
export function assertFrozen(runDir, originDir, relPaths) {
  const changed = []
  for (const rel of relPaths) {
    const origin = join(originDir, rel)
    const after = join(runDir, rel)
    if (!existsSync(origin)) { changed.push({ path: rel, reason: 'origin-missing' }); continue }
    if (!existsSync(after)) { changed.push({ path: rel, reason: 'missing' }); continue }
    if (!readFileSync(origin).equals(readFileSync(after))) changed.push({ path: rel, reason: 'modified' })
  }
  return { ok: changed.length === 0, changed }
}

/**
 * 递归列出目录下全部文件的相对路径（POSIX 分隔符，排序稳定）。
 * @param {string} dir
 * @param {(rel: string) => boolean} [skip] 返回 true 的相对路径（文件或目录）整体跳过
 */
export function listFiles(dir, skip = () => false) {
  const out = []
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(abs, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      if (skip(rel)) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(dir)
  return out
}

/**
 * 两目录的文件清单差异（只看有没有，不看内容）。
 * added = 只在 dirB 有；removed = 只在 dirA 有。用于「不许新建/删文件」约束：
 *   fileSetDiff(originDir, cwd, { ignore: ['node_modules', '.git'] })
 *
 * @param {string} dirA
 * @param {string} dirB
 * @param {{ ignore?: Array<string|RegExp> }} [opts] ignore 项：字符串按相对路径
 *   前缀匹配（'node_modules' 同时盖住目录及其下所有），正则按相对路径 test
 * @returns {{ same: boolean, added: string[], removed: string[] }}
 */
export function fileSetDiff(dirA, dirB, { ignore = [] } = {}) {
  const skip = (rel) => ignore.some(rule => rule instanceof RegExp
    ? rule.test(rel)
    : rel === rule || rel.startsWith(rule.endsWith('/') ? rule : rule + '/'))
  const a = new Set(listFiles(dirA, skip))
  const b = new Set(listFiles(dirB, skip))
  const added = [...b].filter(p => !a.has(p)).sort()
  const removed = [...a].filter(p => !b.has(p)).sort()
  return { same: added.length === 0 && removed.length === 0, added, removed }
}

/**
 * 带超时跑判分命令（agent 写的代码可能死循环，判分命令**必须**带超时）。
 * 超时时 spawnSync 杀掉子进程，timedOut=true、status=null。
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string, maxBuffer?: number }} [opts]
 * @returns {{ status: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, error: string|null }}
 */
export function runOracle(cmd, args = [], { cwd, timeoutMs = 30_000, env, input, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer,
  })
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return {
    status: r.status,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
    error: r.error && !timedOut ? r.error.message : null,
  }
}

/**
 * 解析明文会话 jsonl 为事件数组。坏行（被 SIGKILL 截断的半行）跳过不抛，
 * 文件不存在抛 ENOENT——会话缺失是 harness 级问题，应当显式失败。
 * @param {string} sessionFile
 * @returns {Array<{ type: string, seq?: number, time?: number, data?: any }>}
 */
export function readSession(sessionFile) {
  const events = []
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 截断的尾行 */ }
  }
  return events
}

/**
 * 会话里的工具调用序列（按事件顺序）。arguments 在 jsonl 里是 JSON 字符串，
 * 这里解析成对象；解析失败时 args 退回原字符串、rawArguments 恒为原文。
 * @param {string} sessionFile
 * @returns {Array<{ name: string, args: any, rawArguments: string, callId: string, turn?: number, step?: number, seq?: number }>}
 */
export function toolCalls(sessionFile) {
  const out = []
  for (const e of readSession(sessionFile)) {
    if (e.type !== 'tool/call') continue
    const d = e.data ?? {}
    let args = d.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* 留原文 */ } }
    out.push({
      name: d.name,
      args,
      rawArguments: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? null),
      callId: d.callId,
      turn: d.turn,
      step: d.step,
      seq: e.seq,
    })
  }
  return out
}

/**
 * 会话的真实模型用量：把每个 assistant/message 的 data.usage 累加。
 * llmCalls = assistant/message 事件数（≈ 模型调用次数）。
 * @param {string} sessionFile
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number, llmCalls: number }}
 */
export function sessionUsage(sessionFile) {
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, llmCalls: 0 }
  for (const e of readSession(sessionFile)) {
    if (e.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (u === undefined || u === null) continue
    sum.llmCalls += 1
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens']) {
      if (typeof u[k] === 'number') sum[k] += u[k]
    }
  }
  return sum
}

/**
 * 按 sessionId 在 sessionsRoot 下定位明文会话文件。
 * 布局（dsh-session-persistence-jsonl）：<root>/<cwd 编码目录>/<sessionId>/session.jsonl。
 * 找不到返回 null（崩溃/超时的会话可能根本没落盘）。
 * @param {string} sessionsRoot
 * @param {string|null|undefined} sessionId
 * @returns {string|null}
 */
export function findSessionFile(sessionsRoot, sessionId) {
  if (!sessionId || !existsSync(sessionsRoot)) return null
  for (const cwdDir of readdirSync(sessionsRoot)) {
    const candidate = join(sessionsRoot, cwdDir, sessionId, 'session.jsonl')
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * 递归复制夹具到 runDir（dst 不存在则建）。src 不存在抛错——夹具缺失
 * 必须让 prepare 炸成 harness-error，而不是让 agent 对着空目录干活。
 * @param {string} src
 * @param {string} dst
 * @returns {string} dst
 */
export function copyDir(src, dst) {
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`copyDir：夹具目录不存在或不是目录：${src}`)
  }
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true })
  return dst
}
