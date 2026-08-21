#!/usr/bin/env node
/**
 * KingCode agent 行为评测驱动 —— 固定任务集 + 自动判分 + 基线对比。
 *
 * 跑法（真调模型，flash 便宜，全量约 4 次任务级会话）：
 *   node eval/run.js                      # 全部任务
 *   node eval/run.js --task fix-slug      # 单个任务
 *   node eval/run.js --update-baseline    # 全量跑完后把 latest 写为 baseline
 *
 * 每个任务：prepare（造独立运行目录，fixture 用副本）→ spawn CLI
 * （--config eval/cordis.eval.yml，env 带 KINGCODE_RESULT_FILE / DSH_SNAPSHOT=1 /
 * KINGCODE_EVAL_SESSIONS_ROOT）→ 收 stdout/退出码/机读结果/耗时 → 判分器打分。
 * 判分零 LLM：只用退出码 / 正则 / 引擎复算（金样例纪律，见 eval/README.md）。
 *
 * 产物：eval/results/runs/<runId>/<taskId>/ 下 stdout.txt、stderr.txt、
 * kingcode-result.json 与会话明文 jsonl；汇总写 eval/results/latest.json；
 * eval/baseline.json 存在时逐任务对比并报告回归/改善。
 *
 * 风格对齐 test/*.js：零依赖裸 node，失败退出码 1。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(EVAL_DIR, '..')
const BIN = join(REPO_ROOT, 'bin', 'kingcode.js')
const CONFIG = join(EVAL_DIR, 'cordis.eval.yml')
const RESULTS_DIR = join(EVAL_DIR, 'results')
const LATEST = join(RESULTS_DIR, 'latest.json')
const BASELINE = join(EVAL_DIR, 'baseline.json')
const DEFAULT_TIMEOUT_MS = 300_000 // 整体超时防挂死；任务可用 timeoutMs 覆盖

// ── 参数解析（零依赖，只有两个旗标，不值得上 commander）─────────────────────
const argv = process.argv.slice(2)
let onlyTask
let updateBaseline = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--task') { onlyTask = argv[++i]; continue }
  if (argv[i] === '--update-baseline') { updateBaseline = true; continue }
  if (argv[i] === '-h' || argv[i] === '--help') {
    console.log('用法：node eval/run.js [--task <id>] [--update-baseline]')
    process.exit(0)
  }
  console.error(`未知参数：${argv[i]}（可用：--task <id> / --update-baseline）`)
  process.exit(2)
}
if (updateBaseline && onlyTask !== undefined) {
  // 花钱跑完才拒绝太蠢——参数就位时立刻拒
  console.error('拒绝：--update-baseline 只接受全量跑的结果（单任务会把基线写残）')
  process.exit(2)
}

// ── 装载任务定义（eval/tasks/*.js，默认导出 {id, description, judge, task, prepare, grade}）──
async function loadTasks() {
  const files = readdirSync(join(EVAL_DIR, 'tasks')).filter(f => f.endsWith('.js')).sort()
  const tasks = []
  for (const file of files) {
    const mod = await import(pathToFileURL(join(EVAL_DIR, 'tasks', file)).href)
    const t = mod.default
    for (const field of ['id', 'description', 'judge', 'task', 'prepare', 'grade']) {
      if (t?.[field] === undefined) throw new Error(`任务定义 ${file} 缺字段 ${field}`)
    }
    tasks.push(t)
  }
  return tasks
}

/** spawn 一次 CLI，收全 stdout/stderr，超时杀整个进程组。 */
function runCli({ taskText, cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
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
      resolvePromise({ stdout, stderr: stderr + `\nspawn 失败：${error.message}`, exitCode: null, timedOut, durationMs: Date.now() - started })
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

const tasks = await loadTasks()
const selected = onlyTask === undefined ? tasks : tasks.filter(t => t.id === onlyTask)
if (selected.length === 0) {
  console.error(`没有匹配的任务 id「${onlyTask}」。可用：${tasks.map(t => t.id).join('、')}`)
  process.exit(2)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
// 运行目录必须在仓库外：dsh-agent-instructions 从项目根（.git 上溯）到 cwd
// 逐层装载 AGENTS.md，运行目录留在仓库内就会把本仓库的指令注进每个评测会话，
// 对着一个只有几个文件的夹具全是噪声兼误导。绝对路径写进 latest.json 备查。
const runDirRoot = join(tmpdir(), 'kingcode-eval', runId)
const sessionsRoot = join(runDirRoot, 'sessions') // 每次评测全新 root：绝不与 zstd 会话混放
mkdirSync(sessionsRoot, { recursive: true })

console.log(`KingCode eval ${runId}`)
console.log(`运行目录 ${runDirRoot}`)
console.log(`组合树 ${CONFIG}（模型 ${pinnedModel() ?? '未知'}）；任务 ${selected.length}/${tasks.length} 个\n`)

const records = []
for (const task of selected) {
  const taskDir = join(runDirRoot, task.id)
  mkdirSync(taskDir, { recursive: true })
  const resultFile = join(taskDir, 'kingcode-result.json')

  let record
  try {
    const { cwd } = await task.prepare({ runDir: taskDir, repoRoot: REPO_ROOT })
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run = await runCli({
      taskText: task.task,
      cwd,
      env: {
        ...process.env,
        KINGCODE_RESULT_FILE: resultFile,
        DSH_SNAPSHOT: '1', // 会话明文 jsonl，评测证据可直接翻
        KINGCODE_EVAL_SESSIONS_ROOT: sessionsRoot,
      },
      timeoutMs,
    })
    writeFileSync(join(taskDir, 'stdout.txt'), run.stdout)
    writeFileSync(join(taskDir, 'stderr.txt'), run.stderr)

    let result = null
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* 崩溃/超时可能没写 */ }

    const graded = await task.grade({
      cwd, runDir: taskDir, repoRoot: REPO_ROOT,
      stdout: run.stdout, stderr: run.stderr,
      exitCode: run.exitCode, timedOut: run.timedOut, result,
    })
    record = {
      id: task.id,
      description: task.description,
      judge: task.judge,
      pass: graded.pass === true,
      detail: graded.detail ?? '',
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      sessionId: result?.sessionId ?? null,
      reasonKind: result?.reasonKind ?? null,
      errorCode: result?.errorCode ?? null,
    }
  } catch (error) {
    // prepare/grade 自身抛错是 harness 缺陷，不是 agent 失败——但同样算 FAIL 并如实记录
    record = {
      id: task.id, description: task.description, judge: task.judge,
      pass: false, detail: `harness 异常：${error instanceof Error ? error.message : String(error)}`,
      exitCode: null, timedOut: false, durationMs: 0, sessionId: null, reasonKind: null, errorCode: null,
    }
  }
  records.push(record)
  console.log(`${record.pass ? 'PASS' : 'FAIL'} ${record.id}  (${(record.durationMs / 1000).toFixed(1)}s, exit ${record.exitCode}${record.timedOut ? ', 超时' : ''})  ${record.detail}`)
}

// ── 汇总与落盘 ───────────────────────────────────────────────────────────────
const passed = records.filter(r => r.pass).length
const summary = {
  schema: 'kingcode-eval-result/1',
  runId,
  config: 'eval/cordis.eval.yml',
  model: pinnedModel(),
  runDirRoot, // 产物在仓库外（见上），不记路径就翻不到证据
  partial: onlyTask !== undefined, // 单任务跑出来的 latest 不是全量口径
  tasks: records,
  totals: {
    total: records.length,
    passed,
    failed: records.length - passed,
    durationMs: records.reduce((s, r) => s + r.durationMs, 0),
  },
}
mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(LATEST, JSON.stringify(summary, null, 2) + '\n')
console.log(`\n${passed}/${records.length} 通过，共 ${(summary.totals.durationMs / 1000).toFixed(1)}s；已写 eval/results/latest.json`)

// ── 基线对比 ────────────────────────────────────────────────────────────────
let baseline = null
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch { /* 没有基线 */ }
if (baseline !== null) {
  const before = new Map((baseline.tasks ?? []).map(t => [t.id, t]))
  const regressions = []
  const improvements = []
  for (const r of records) {
    const b = before.get(r.id)
    if (b === undefined) { console.log(`NEW  ${r.id}（基线里没有）`); continue }
    if (b.pass && !r.pass) regressions.push(r.id)
    if (!b.pass && r.pass) improvements.push(r.id)
  }
  if (onlyTask === undefined) {
    for (const id of before.keys()) {
      if (!records.some(r => r.id === id)) console.log(`GONE ${id}（基线有、本次没跑到——任务被删了？）`)
    }
  }
  if (regressions.length > 0) console.log(`回归 ${regressions.length} 项：${regressions.join('、')}（基线 ${baseline.runId ?? '?'} 时通过）`)
  if (improvements.length > 0) console.log(`改善 ${improvements.length} 项：${improvements.join('、')}`)
  if (regressions.length === 0 && improvements.length === 0) console.log(`与基线 ${baseline.runId ?? '?'} 相比无变化`)
} else {
  console.log('无 eval/baseline.json，跳过基线对比（全量跑一次 --update-baseline 生成）')
}

if (updateBaseline) {
  copyFileSync(LATEST, BASELINE)
  console.log('已把 latest 写为 eval/baseline.json')
}

process.exit(passed === records.length ? 0 : 1)
