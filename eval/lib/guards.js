/**
 * eval 任务作者的零依赖工具箱：防作弊比对、目录差异、带超时的判分命令、
 * 会话 jsonl 解析（工具调用序列 / 真实用量）、夹具复制。
 *
 * 全部同步、纯 node 内置模块；任何函数都不问模型。run.js 自己也用这里的
 * readSession / sessionUsageDeep 聚合用量——契约只有一份，不在两处各写一遍。
 *
 * 子代理**另开一份 session.jsonl**，取证只看父会话就会被一句委派洗白——
 * 见下面「子会话（子代理）」一节的 childSessionFiles / toolCallsDeep。
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
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

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
      // 符号链接 isFile()/isDirectory() 都是 false（readdirSync 不跟随），原本
      // 会**直接消失**——而 assertFrozen 的 readFileSync 跟随链接，同一个文件
      // 两个 guard 一个说「没动过」一个说「不存在」。收录成一个绝不可能与原件
      // 清单相等的条目，让 fileSetDiff 一定报出来：把原件藏在链接后面、cwd 里
      // 只留一个指过去的链接，是现成的作弊路径（实证能让 refactor-preserve
      // 在一行重构都没做的情况下判绿）。
      if (entry.isSymbolicLink()) { out.push(`${rel} → (symlink)`); continue }
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

// ── 子会话（子代理）────────────────────────────────────────────────────────
//
// 子代理不是父会话里的几条事件，而是**另一份 session.jsonl**：同一个
// persistence root 下另开一个目录，首行长这样（读自真实会话，不是猜的）：
//   {"type":"session","version":0,"id":"1167b76a-…","createdAt":…,
//    "cwd":"/home/you/kingcode",
//    "parentSession":"session-a5fd33c7-…","origin":"subagent","delegationDepth":1}
// 注意两件事：① 子会话的**目录名不带 `session-` 前缀**（就是裸 uuid），按前缀
// 过滤会把它们整批漏掉；② 父子关系只能靠 `parentSession` 连，别按目录名猜。
//
// 只看父会话的取证有个致命洞：「工具参数触及 eval/ 即 FAIL」这类判分，agent
// 一句 explore 委派就洗白了——真正 grep 到答案的 bash 落在子会话里，父会话干净
// 得像没作弊（离线复现：cheat-frw 判 pass，同样的读留在父会话里判 fail）。
// 所以凡是「全会话都不许出现 X」的取证，都必须走父 + 全部后代的合集。

/** 会话首行最多读这么多字节：session 事件只有两百来字节，没必要为一行整读几百 KB 的 jsonl */
const SESSION_HEADER_BYTES = 64 * 1024

/** 读文件开头的第一行（读不到 / 开头没有换行则返回能读到的那段）。文件打不开返回 null。 */
function readFirstLine(file) {
  let fd
  try { fd = openSync(file, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(SESSION_HEADER_BYTES)
    const n = readSync(fd, buf, 0, SESSION_HEADER_BYTES, 0)
    const text = buf.toString('utf8', 0, n)
    const nl = text.indexOf('\n')
    return nl === -1 ? text : text.slice(0, nl)
  } finally { closeSync(fd) }
}

/**
 * 扫 `<root>/<cwd 编码目录>/<sessionId>/session.jsonl`，只读每份首行建索引。
 * 首行不是合法 JSON（会话刚建、被截断）也照样收录，只是没有父子信息。
 * @param {string} sessionsRoot
 * @returns {Array<{ sessionId: string, file: string, parentSession: string|null, origin: string|null, delegationDepth: number|null }>}
 */
function indexSessions(sessionsRoot) {
  const out = []
  if (typeof sessionsRoot !== 'string' || !existsSync(sessionsRoot)) return out
  for (const cwdDir of readdirSync(sessionsRoot)) {
    let entries
    try { entries = readdirSync(join(sessionsRoot, cwdDir), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(sessionsRoot, cwdDir, entry.name, 'session.jsonl')
      if (!existsSync(file) || !statSync(file).isFile()) continue
      let head = null
      const line = readFirstLine(file)
      if (line !== null) { try { head = JSON.parse(line) } catch { /* 首行不可解析 */ } }
      // session 事件是平铺的（没有 data 包一层），但别把这当死规矩
      const d = (head && typeof head === 'object' ? (head.data ?? head) : {}) ?? {}
      out.push({
        // 目录名即 sessionId（persistence 落盘约定）；首行有 id 时以首行为准
        sessionId: typeof d.id === 'string' && d.id !== '' ? d.id : entry.name,
        file,
        parentSession: typeof d.parentSession === 'string' && d.parentSession !== '' ? d.parentSession : null,
        origin: typeof d.origin === 'string' ? d.origin : null,
        delegationDepth: typeof d.delegationDepth === 'number' ? d.delegationDepth : null,
      })
    }
  }
  return out
}

/**
 * rootSessionId 的**全部后代**会话文件（递归，不是只看一层）。
 * 当前组合树 maxDepth 1，但那是配置不是不变量——这里按真正的树来收，
 * 将来放开层数不用再改判分。同一 id 只收一次，父子指成环也不会转不出来。
 *
 * 顺序：广度优先，同层按 sessionId 排序——稳定可复现，detail 里点名才有意义。
 *
 * @param {string} sessionsRoot 本次评测的会话根目录
 * @param {string|null|undefined} rootSessionId 父（根）会话 id
 * @returns {string[]} 后代会话 jsonl 的绝对路径（不含父会话自己）
 */
export function childSessionFiles(sessionsRoot, rootSessionId) {
  if (typeof rootSessionId !== 'string' || rootSessionId === '') return []
  const byParent = new Map()
  for (const s of indexSessions(sessionsRoot)) {
    if (s.parentSession === null) continue
    if (!byParent.has(s.parentSession)) byParent.set(s.parentSession, [])
    byParent.get(s.parentSession).push(s)
  }
  const seen = new Set([rootSessionId])
  const files = []
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()
    const kids = (byParent.get(id) ?? []).slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    for (const kid of kids) {
      if (seen.has(kid.sessionId)) continue
      seen.add(kid.sessionId)
      files.push(kid.file)
      queue.push(kid.sessionId)
    }
  }
  return files
}

/**
 * 父会话 + 全部后代的会话文件（父在最前）。取证要覆盖整棵委派树时用它。
 * rootSessionId 省略时从 sessionFile 首行取（取不到就退回目录名）。
 * @param {string} sessionFile 父会话 jsonl 绝对路径
 * @param {string} sessionsRoot
 * @param {string} [rootSessionId]
 * @returns {string[]}
 */
export function sessionFamilyFiles(sessionFile, sessionsRoot, rootSessionId) {
  if (typeof sessionsRoot !== 'string') {
    // 少给 sessionsRoot 就只剩父会话——那正是这个函数要堵的洞，宁可炸也不能静悄悄缩小取证面
    throw new Error('sessionFamilyFiles：必须传 sessionsRoot（grade 的入参里有），否则取证只覆盖父会话')
  }
  const rootId = rootSessionId ?? sessionIdOf(sessionFile)
  return [sessionFile, ...childSessionFiles(sessionsRoot, rootId)]
}

/**
 * 从会话文件推断它的 sessionId：首行 session 事件的 id，退而取所在目录名。
 * @param {string} sessionFile
 * @returns {string}
 */
export function sessionIdOf(sessionFile) {
  const line = readFirstLine(sessionFile)
  if (line !== null) {
    try {
      const head = JSON.parse(line)
      const d = head?.data ?? head
      if (typeof d?.id === 'string' && d.id !== '') return d.id
    } catch { /* 首行不可解析 */ }
  }
  return basename(dirname(sessionFile))
}

/**
 * 父会话 + 全部后代的工具调用合集——凡是「整棵委派树里都不许出现 X」的取证，
 * 调用点把 `toolCalls(sessionFile)` 换成这个即可（多传一个 sessionsRoot）。
 *
 * 每项在 toolCalls 的字段之外多带 `sessionId` / `sessionFile` / `subagent`，
 * 好让 detail 指明作弊发生在哪一层。顺序：父会话全部调用，再按 sessionFamilyFiles
 * 的顺序接上各后代的（**不跨会话按时间排**——各会话的 seq 各自独立，混排只会让
 * detail 更难读）。
 *
 * @param {string} sessionFile 父会话 jsonl
 * @param {string} sessionsRoot
 * @param {string} [rootSessionId]
 * @returns {Array<{ name: string, args: any, rawArguments: string, callId: string, turn?: number, step?: number, seq?: number, sessionId: string, sessionFile: string, subagent: boolean }>}
 */
export function toolCallsDeep(sessionFile, sessionsRoot, rootSessionId) {
  const files = sessionFamilyFiles(sessionFile, sessionsRoot, rootSessionId)
  const out = []
  for (const [i, file] of files.entries()) {
    const id = sessionIdOf(file)
    for (const c of toolCalls(file)) out.push({ ...c, sessionId: id, sessionFile: file, subagent: i > 0 })
  }
  return out
}

/**
 * 整棵委派树的真实用量：父会话 + 全部后代逐份 sessionUsage 相加。
 * 形状与 sessionUsage 完全一致，多一个 `sessions`（计入了几份会话）。
 * 子代理常常比父会话烧得还多（实测一次：父 in+out 12365 / 子 16000），
 * 只算父会话的「真实花费」能低估一半以上。
 * @param {string} sessionFile 父会话 jsonl
 * @param {string} sessionsRoot
 * @param {string} [rootSessionId]
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number, llmCalls: number, sessions: number }}
 */
export function sessionUsageDeep(sessionFile, sessionsRoot, rootSessionId) {
  const files = sessionFamilyFiles(sessionFile, sessionsRoot, rootSessionId)
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, llmCalls: 0, sessions: 0 }
  for (const file of files) {
    const u = sessionUsage(file)
    sum.sessions += 1
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'llmCalls']) sum[k] += u[k]
  }
  return sum
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
