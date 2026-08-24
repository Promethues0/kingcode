#!/usr/bin/env node
/**
 * KingCode agent 行为评测驱动 —— 固定任务集 + 自动判分 + 基线对比。
 *
 * 跑法（真调模型，flash 便宜，全量约 N 次任务级会话）：
 *   node eval/run.js                        # 全部任务，写 eval/results/latest.json 并与基线对比
 *   node eval/run.js --task fix-slug        # 单个任务（可重复给多个），写 latest-partial.json，不碰 latest.json
 *   node eval/run.js --jobs 3               # 并发跑 3 个任务（默认 1）
 *   node eval/run.js --no-retry             # 关掉「基线通过、本次失败」的自动重跑
 *   node eval/run.js --update-baseline      # 全量跑完后把 latest 写为 baseline（禁与 --task 连用）
 *
 * 每个任务：prepare（造独立运行目录，fixture 用副本）→ spawn CLI
 * （--config eval/cordis.eval.yml，env 带 KINGCODE_RESULT_FILE / DSH_SNAPSHOT=1 /
 * KINGCODE_EVAL_SESSIONS_ROOT）→ 收 stdout/退出码/机读结果/耗时 → 定位明文会话
 * jsonl、聚合真实用量 → 判分器打分。判分零 LLM：只用退出码 / 正则 / 引擎复算
 * （金样例纪律，见 eval/README.md）。
 *
 * 状态五态：pass / fail / xfail（任务标了 expectFail 且确实失败）/ xpass（标了
 * expectFail 却过了——显眼报出，提示摘标）/ harness-error（prepare、grade 自身
 * 抛异常、夹具缺失、CLI 起不来——是评测器的病，绝不伪装成 agent 的 FAIL）。
 * 退出码：有 fail 或 harness-error → 1；其余（pass / xpass / 仅 xfail）→ 0；参数错 2。
 *
 * 抖动缓冲：本次 fail 而基线该任务 pass 的，自动重跑一次；两次都进 record.attempts，
 * 以第二次为准并标 retried: true。expectFail / harness-error 不重跑。
 *
 * 产物：<tmp>/kingcode-eval/<runId>/<taskId>/ 下 stdout.txt、stderr.txt、
 * kingcode-result.json；../sessions/ 下会话明文 jsonl（重跑用 <taskId>@2）。
 *
 * 风格对齐 test/*.js：零依赖裸 node。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findSessionFile, sessionUsage } from './lib/guards.js'

const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(EVAL_DIR, '..')
const BIN = join(REPO_ROOT, 'bin', 'kingcode.js')
const CONFIG = join(EVAL_DIR, 'cordis.eval.yml')
const RESULTS_DIR = join(EVAL_DIR, 'results')
const LATEST = join(RESULTS_DIR, 'latest.json')
const LATEST_PARTIAL = join(RESULTS_DIR, 'latest-partial.json')
// KINGCODE_EVAL_BASELINE：基线路径覆盖，只为给 harness 自己做测试（验抖动重跑等），日常别设
const BASELINE = process.env.KINGCODE_EVAL_BASELINE ?? join(EVAL_DIR, 'baseline.json')
const DEFAULT_TIMEOUT_MS = 300_000 // 整体超时防挂死；任务可用 timeoutMs 覆盖

const STATUS_TAG = {
  pass: 'PASS',
  fail: 'FAIL',
  xfail: 'XFAIL',
  xpass: 'XPASS',
  'harness-error': 'HARNESS-ERROR',
}

// ── 参数解析（零依赖，几个旗标，不值得上 commander）────────────────────────
const USAGE = '用法：node eval/run.js [--task <id>]... [--jobs N] [--no-retry] [--update-baseline]'
const argv = process.argv.slice(2)
const onlyTasks = []
let jobs = 1
let retryEnabled = true
let updateBaseline = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--task') {
    const id = argv[++i]
    if (id === undefined) { console.error('--task 后面要跟任务 id'); process.exit(2) }
    onlyTasks.push(id)
    continue
  }
  if (a === '--jobs') {
    jobs = Number(argv[++i])
    if (!Number.isInteger(jobs) || jobs < 1) { console.error('--jobs 要跟 ≥1 的整数'); process.exit(2) }
    continue
  }
  if (a === '--no-retry') { retryEnabled = false; continue }
  if (a === '--update-baseline') { updateBaseline = true; continue }
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
  console.error(`未知参数：${a}\n${USAGE}`)
  process.exit(2)
}
const partial = onlyTasks.length > 0
if (updateBaseline && partial) {
  // 花钱跑完才拒绝太蠢——参数就位时立刻拒
  console.error('拒绝：--update-baseline 只接受全量跑的结果（单任务会把基线写残）')
  process.exit(2)
}

// ── 装载任务定义（eval/tasks/*.js，默认导出；字段契约见 eval/README.md）──────
async function loadTasks() {
  const files = readdirSync(join(EVAL_DIR, 'tasks')).filter(f => f.endsWith('.js')).sort()
  const tasks = []
  const seen = new Set()
  for (const file of files) {
    const mod = await import(pathToFileURL(join(EVAL_DIR, 'tasks', file)).href)
    const t = mod.default
    for (const field of ['id', 'description', 'judge', 'task', 'prepare', 'grade']) {
      if (t?.[field] === undefined) throw new Error(`任务定义 ${file} 缺字段 ${field}`)
    }
    if (seen.has(t.id)) throw new Error(`任务 id 重复：${t.id}（${file}）`)
    seen.add(t.id)
    if (t.expectFail !== undefined && (typeof t.expectFail !== 'string' || t.expectFail.trim() === '')) {
      throw new Error(`任务 ${t.id} 的 expectFail 必须是非空字符串（写清为什么过不了）`)
    }
    tasks.push(t)
  }
  return tasks
}

/** spawn 一次 CLI，收全 stdout/stderr，超时杀整个进程组。起不来（spawn error）直接 reject → harness-error。 */
function runCli({ taskText, cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [BIN, '--config', CONFIG, taskText], {
      cwd,
      env,
      detached: true, // 独立进程组：超时能连 bash 工具的子进程一起杀干净
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - started })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`CLI 进程起不来：${error.message}`))
    })
  })
}

/** 从 eval 组合树里抠出钉死的模型名，进结果元数据（只为可读性，抠不到不失败）。 */
function pinnedModel() {
  try {
    const m = /id:\s*agent-default-model[\s\S]*?model:\s*(\S+)/.exec(readFileSync(CONFIG, 'utf8'))
    return m?.[1] ?? null
  } catch { return null }
}

function statusOf({ pass, harnessError }, expectFail) {
  if (harnessError !== null) return 'harness-error'
  if (expectFail) return pass ? 'xpass' : 'xfail'
  return pass ? 'pass' : 'fail'
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, llmCalls: 0 }
function addUsage(into, u) {
  if (!u) return into
  for (const k of Object.keys(EMPTY_USAGE)) into[k] += u[k] ?? 0
  return into
}

const tasks = await loadTasks()
const unknown = onlyTasks.filter(id => !tasks.some(t => t.id === id))
if (unknown.length > 0) {
  console.error(`没有匹配的任务 id「${unknown.join('、')}」。可用：${tasks.map(t => t.id).join('、')}`)
  process.exit(2)
}
const selected = partial ? tasks.filter(t => onlyTasks.includes(t.id)) : tasks

// 基线先读：抖动重跑要看「基线该任务是否通过」
let baseline = null
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { /* 没有基线 */ }
const baselineTasks = new Map((baseline?.tasks ?? []).map(t => [t.id, t]))

const runId = new Date().toISOString().replace(/[:.]/g, '-')
// 运行目录必须在仓库外：dsh-agent-instructions 从项目根（.git 上溯）到 cwd
// 逐层装载 AGENTS.md，运行目录留在仓库内就会把本仓库的指令注进每个评测会话，
// 对着一个只有几个文件的夹具全是噪声兼误导。绝对路径写进 latest.json 备查。
const runDirRoot = join(tmpdir(), 'kingcode-eval', runId)
const sessionsRoot = join(runDirRoot, 'sessions') // 每次评测全新 root：绝不与 zstd 会话混放
mkdirSync(sessionsRoot, { recursive: true })

console.log(`KingCode eval ${runId}`)
console.log(`运行目录 ${runDirRoot}`)
console.log(`组合树 ${CONFIG}（模型 ${pinnedModel() ?? '未知'}）；任务 ${selected.length}/${tasks.length} 个；并发 ${jobs}${retryEnabled ? '' : '；不重跑'}\n`)

/**
 * 跑一次任务（一次 attempt）。每次 attempt 自己的 runDir：首跑 <taskId>，重跑 <taskId>@2。
 * 返回 attempt 记录；prepare/grade/spawn 抛错 → harnessError 非空，其余字段尽量保留已收集到的。
 */
async function runAttempt(task, attempt) {
  const taskDir = join(runDirRoot, attempt === 1 ? task.id : `${task.id}@${attempt}`)
  mkdirSync(taskDir, { recursive: true })
  const resultFile = join(taskDir, 'kingcode-result.json')
  const info = {
    attempt,
    runDir: taskDir,
    pass: false,
    detail: '',
    harnessError: null,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    sessionId: null,
    sessionFile: null,
    reasonKind: null,
    errorCode: null,
    usage: null,
  }
  try {
    const prepared = await task.prepare({ runDir: taskDir, repoRoot: REPO_ROOT, sessionsRoot, attempt })
    if (prepared === null || typeof prepared !== 'object' || typeof prepared.cwd !== 'string') {
      throw new Error('prepare 必须返回 { cwd: string, env?: object }')
    }
    const { cwd } = prepared
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run = await runCli({
      taskText: task.task,
      cwd,
      env: {
        ...process.env,
        // 评测口径不该被跑评测的人的 shell 决定：谁在自己终端里 export 过
        // KINGCODE_DEADLINE_MS，每个任务都会提前退 4（而 timedOut 是 false，
        // grade 只看到一个莫名其妙的非零退出码）；KINGCODE_QUIET 则会把
        // stderr.txt 清空，事后翻证据时什么都没有。显式抹掉，不继承。
        KINGCODE_DEADLINE_MS: undefined,
        KINGCODE_QUIET: undefined,
        ...(prepared.env ?? {}), // 任务自己要设就随它（覆盖在抹除之后）
        KINGCODE_RESULT_FILE: resultFile,
        DSH_SNAPSHOT: '1', // 会话明文 jsonl，评测证据可直接翻
        KINGCODE_EVAL_SESSIONS_ROOT: sessionsRoot,
      },
      timeoutMs,
    })
    writeFileSync(join(taskDir, 'stdout.txt'), run.stdout)
    writeFileSync(join(taskDir, 'stderr.txt'), run.stderr)
    Object.assign(info, { exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs })

    let result = null
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* 崩溃/超时可能没写 */ }
    info.sessionId = result?.sessionId ?? null
    info.reasonKind = result?.reasonKind ?? null
    info.errorCode = result?.errorCode ?? null
    info.sessionFile = findSessionFile(sessionsRoot, info.sessionId)
    info.usage = info.sessionFile === null ? null : sessionUsage(info.sessionFile)

    const graded = await task.grade({
      cwd, runDir: taskDir, repoRoot: REPO_ROOT,
      stdout: run.stdout, stderr: run.stderr,
      exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs,
      result,
      sessionId: info.sessionId, sessionFile: info.sessionFile, sessionsRoot,
      usage: info.usage, prepared, attempt,
    })
    if (graded === null || typeof graded !== 'object' || typeof graded.pass !== 'boolean') {
      throw new Error(`grade 必须返回 { pass: boolean, detail?: string }，实际得到 ${JSON.stringify(graded)}`)
    }
    info.pass = graded.pass
    info.detail = graded.detail ?? ''
  } catch (error) {
    // prepare/grade/spawn 自身抛错是 harness 缺陷，不是 agent 失败——单列状态，绝不混进 FAIL
    const message = error instanceof Error ? error.message : String(error)
    info.harnessError = message
    info.pass = false
    info.detail = `harness 异常：${message}`
    console.error(`[harness-error] ${task.id}（attempt ${attempt}）\n${error instanceof Error && error.stack ? error.stack : message}`)
  }
  return info
}

function fmtUsage(u) {
  if (!u) return ''
  return `, ${u.inputTokens}+${u.cacheReadTokens}c in / ${u.outputTokens} out, ${u.llmCalls} 调用`
}

function printRecord(r) {
  const head = `${STATUS_TAG[r.status].padEnd(5)} ${r.id}`
  const meta = `(${(r.durationMs / 1000).toFixed(1)}s, exit ${r.exitCode}${r.timedOut ? ', 超时' : ''}${fmtUsage(r.usage)}${r.retried ? ', 重跑后' : ''})`
  let tail = ''
  if (r.status === 'xfail') tail = `  [预期失败：${r.expectFail}]`
  if (r.status === 'xpass') tail = `  ← 预期失败却通过了，请摘掉 expectFail（原因曾是：${r.expectFail}）`
  console.log(`${head}  ${meta}  ${r.detail}${tail}`)
}

async function runTask(task) {
  const attempts = [await runAttempt(task, 1)]
  let final = attempts[0]
  const baselinePassed = baselineTasks.get(task.id)?.pass === true
  if (retryEnabled && final.harnessError === null && !final.pass && !task.expectFail && baselinePassed) {
    console.log(`RETRY ${task.id}  首跑失败而基线通过，疑似抖动，重跑一次（首跑：${final.detail}）`)
    attempts.push(await runAttempt(task, 2))
    final = attempts[1]
  }
  const record = {
    id: task.id,
    description: task.description,
    judge: task.judge,
    expectFail: task.expectFail ?? null,
    status: statusOf(final, task.expectFail),
    pass: final.pass,
    detail: final.detail,
    harnessError: final.harnessError,
    exitCode: final.exitCode,
    timedOut: final.timedOut,
    durationMs: final.durationMs,
    sessionId: final.sessionId,
    sessionFile: final.sessionFile,
    reasonKind: final.reasonKind,
    errorCode: final.errorCode,
    usage: final.usage,
    runDir: final.runDir,
    retried: attempts.length > 1,
    attempts: attempts.map(a => ({ ...a, status: statusOf(a, task.expectFail) })),
  }
  printRecord(record)
  return record
}

/** 最简工作池：jobs 个 worker 从队列领任务，结果按 items 原序回填。 */
async function runPool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

const wallStart = Date.now()
const records = await runPool(selected, jobs, runTask)
const wallMs = Date.now() - wallStart

// ── 汇总与落盘 ───────────────────────────────────────────────────────────────
const count = (s) => records.filter(r => r.status === s).length
const totalsUsage = { ...EMPTY_USAGE }
for (const r of records) for (const a of r.attempts) addUsage(totalsUsage, a.usage) // 含重跑：这是真实花费
const summary = {
  schema: 'kingcode-eval-result/2',
  runId,
  config: 'eval/cordis.eval.yml',
  model: pinnedModel(),
  runDirRoot, // 产物在仓库外（见上），不记路径就翻不到证据
  sessionsRoot,
  partial, // 单任务跑出来的不是全量口径
  selected: partial ? selected.map(t => t.id) : null,
  jobs,
  tasks: records,
  totals: {
    total: records.length,
    passed: count('pass'),
    failed: count('fail'),
    xfail: count('xfail'),
    xpass: count('xpass'),
    harnessError: count('harness-error'),
    retried: records.filter(r => r.retried).length,
    durationMs: records.reduce((s, r) => s + r.durationMs, 0), // 各任务最终 attempt 之和
    wallMs, // 墙钟（并发时 < durationMs）
    usage: totalsUsage, // 全部 attempt 之和（含重跑）
  },
}
mkdirSync(RESULTS_DIR, { recursive: true })
const outFile = partial ? LATEST_PARTIAL : LATEST
writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n')

const t = summary.totals
console.log(`\n通过 ${t.passed}/${t.total}（失败 ${t.failed}，预期失败 ${t.xfail}，意外通过 ${t.xpass}，harness 异常 ${t.harnessError}，重跑 ${t.retried}）`)
console.log(`agent 合计 ${(t.durationMs / 1000).toFixed(1)}s，墙钟 ${(wallMs / 1000).toFixed(1)}s；用量 in ${t.usage.inputTokens}（+缓存 ${t.usage.cacheReadTokens}）/ out ${t.usage.outputTokens}，模型调用 ${t.usage.llmCalls} 次；已写 eval/results/${partial ? 'latest-partial' : 'latest'}.json`)
if (t.xpass > 0) {
  console.log(`\n!! XPASS ${t.xpass} 项：${records.filter(r => r.status === 'xpass').map(r => r.id).join('、')}——标了 expectFail 却通过了，请到任务定义里摘掉 expectFail 并更新 README 的 known-fail 表`)
}
if (t.harnessError > 0) {
  console.log(`\n!! HARNESS-ERROR ${t.harnessError} 项：${records.filter(r => r.status === 'harness-error').map(r => `${r.id}（${r.harnessError}）`).join('；')}——这是评测器/任务定义的病，不是 agent 的，修 harness 而不是改判分`)
}

// ── 基线对比（只在全量跑时做；单任务跑的口径与基线不可比）─────────────────
if (partial) {
  console.log('\n单任务跑：不做基线对比，不覆盖 eval/results/latest.json')
} else if (baseline !== null) {
  const regressions = []
  const improvements = []
  for (const r of records) {
    const b = baselineTasks.get(r.id)
    if (b === undefined) { console.log(`NEW  ${r.id}（基线里没有）`); continue }
    const bPass = b.pass === true // 旧 schema 只有 pass，新 schema 也保留 pass：跨版本可比
    if (bPass && !r.pass) {
      regressions.push(r.id + (r.status === 'xfail' ? '（已标 expectFail）' : r.status === 'harness-error' ? '（harness 异常）' : ''))
    }
    if (!bPass && r.pass) {
      improvements.push(r.id + (r.status === 'xpass' ? '（可摘 expectFail）' : ''))
    }
  }
  for (const id of baselineTasks.keys()) {
    if (!records.some(r => r.id === id)) console.log(`GONE ${id}（基线有、本次没跑到——任务被删了？）`)
  }
  if (regressions.length > 0) console.log(`回归 ${regressions.length} 项：${regressions.join('、')}（基线 ${baseline.runId ?? '?'} 时通过）`)
  if (improvements.length > 0) console.log(`改善 ${improvements.length} 项：${improvements.join('、')}`)
  if (regressions.length === 0 && improvements.length === 0) console.log(`与基线 ${baseline.runId ?? '?'} 相比无变化`)
} else {
  console.log('无 eval/baseline.json，跳过基线对比（全量跑一次 --update-baseline 生成）')
}

const red = t.failed > 0 || t.harnessError > 0
if (updateBaseline) {
  if (t.harnessError > 0) {
    console.log('拒绝写基线：有 harness 异常的结果不配当基线，先修 harness')
  } else {
    copyFileSync(LATEST, BASELINE)
    console.log('已把 latest 写为 eval/baseline.json')
  }
}

process.exit(red ? 1 : 0)
