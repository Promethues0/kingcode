/**
 * 运行环境上下文插件的无头测试：不起 agent、不调模型。
 *
 * 守的是四件事：注册的是 context 不是 section、provider 永远返回 string 且
 * 每 step 不 spawn 进程、在真实的临时 git 仓库里能报出分支与 clean/dirty、
 * 不在仓库 / git 不存在时如实写明而不抛。
 *
 * 跑法：node test/test-env-context.js（失败退出码 1）
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply, createProvider, snapshotGit, describeGit, renderEnvContext, localIsoDate,
  CONTEXT_NAME, CONTEXT_ORDER,
} from '../plugins/env-context.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

/** 用假的 ctx 收下插件注册的 context / section。 */
function collect(config) {
  const contexts = []
  const sections = []
  apply({ systemPrompt: { context: c => { contexts.push(c) }, section: s => { sections.push(s) } } }, config)
  return { contexts, sections }
}

/** 独立复算今天的本地 ISO 日期：sv-SE 区域的日期格式恰好是 YYYY-MM-DD。 */
const today = new Date().toLocaleDateString('sv-SE')

const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// ---- 注册形态 ----

{
  const { contexts, sections } = collect()
  eq(contexts.length, 1, '注册了恰好一条 context')
  eq(sections.length, 0, '没有注册 section（环境事实不该进 system prompt 重复发送）')
  const [c] = contexts
  eq(c.name, CONTEXT_NAME, 'context 名与导出常量一致')
  eq(c.order, CONTEXT_ORDER, 'context order 与导出常量一致')
  // 上游 context 已占：110 sandbox:policy、115 approval:policy、120 subagent:delegation
  check(![110, 115, 120].includes(c.order), 'order 不与上游 context 撞车', String(c.order))
  check(typeof c.text === 'function', 'text 是 provider 函数（日期要按天动态）')
}

// ---- provider 契约：返回 string、含日期与平台、稳定、不 spawn ----

{
  const { contexts: [c] } = collect()
  const text = c.text({})
  check(typeof text === 'string', 'provider 返回 string')
  check(text.length > 0, 'provider 返回非空')
  check(text.includes(today), '含今天的本地 ISO 日期', today)
  check(!/\d{2}:\d{2}/.test(text), '不含时分（否则每 step 文本都变、每 step 重注入）')
  check(text.includes(process.platform), '含平台名', process.platform)
  check(text.includes(process.version), '含 node 版本')
  check(text.includes('git:'), '含 git 行')
  const lineCount = text.split('\n').length
  check(lineCount >= 3 && lineCount <= 5, '输出紧凑（3-5 行）', String(lineCount))
  check(!text.includes('{{'), '文本里没有 {{（会被 system-prompt 当变量引用而抛错）')
  eq(c.text({}), text, '连续两次调用文本一致（agent-loop 只在文本变化时重注入）')
}

{
  // provider 不得 spawn：计数的假 exec 只在 createProvider（apply）时被调用，之后归零
  let calls = 0
  const exec = (...args) => { calls++; return execFileSync(...args) }
  const provider = createProvider({ cwd: process.cwd(), exec })
  const atApply = calls
  check(atApply > 0, 'apply 阶段跑了 git', String(atApply))
  provider({}); provider({}); provider({})
  eq(calls, atApply, 'provider 调用三次没有再 spawn 进程')
}

{
  // 日期用本地时区，不是 UTC
  const fixed = new Date(2026, 0, 31, 23, 30) // 本地 2026-01-31 23:30
  eq(localIsoDate(fixed), '2026-01-31', 'localIsoDate 取本地日期')
  const provider = createProvider({ cwd: process.cwd(), now: () => fixed })
  check(provider({}).includes('date: 2026-01-31'), 'provider 使用注入的时钟')
}

// ---- 真实临时 git 仓库：分支名、clean → dirty、unborn、detached ----

const root = mkdtempSync(join(tmpdir(), 'kingcode-env-context-'))
try {
  const repo = join(root, 'repo')
  sh(root, ['init', '-q', repo])
  sh(repo, ['symbolic-ref', 'HEAD', 'refs/heads/probe-branch'])
  sh(repo, ['config', 'user.email', 'test@example.com'])
  sh(repo, ['config', 'user.name', 'test'])

  // unborn 分支（刚 init、零提交）：symbolic-ref 仍能报出分支名，且 clean
  {
    const snap = snapshotGit(repo)
    eq(snap.kind, 'repo', 'unborn 仓库识别为 repo')
    eq(snap.branch, 'probe-branch', 'unborn 仓库能报出分支名')
    eq(snap.dirty, false, 'unborn 空仓库 clean')
  }

  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh(repo, ['add', 'a.txt'])
  sh(repo, ['commit', '-q', '-m', 'init'])

  // clean
  {
    const { contexts: [c] } = collect({ cwd: repo })
    const text = c.text({})
    check(text.includes('branch probe-branch'), '干净仓库：报出分支名', text.split('\n').at(-1))
    check(text.includes('working tree clean'), '干净仓库：报 clean')
    check(!text.includes('dirty'), '干净仓库：不说 dirty')
  }

  // dirty：一个改动 + 一个未跟踪
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  {
    const snap = snapshotGit(repo)
    eq(snap.dirty, true, '脏仓库：dirty=true')
    // 期望值由 git 自己复算，不手数
    const expectedChanged = sh(repo, ['status', '--porcelain']).split('\n').length
    eq(snap.changed, expectedChanged, '脏仓库：变更路径数与 git status --porcelain 行数一致')
    const { contexts: [c] } = collect({ cwd: repo })
    const text = c.text({})
    check(text.includes('working tree dirty'), '脏仓库：报 dirty')
    check(text.includes(`${expectedChanged} changed paths`), '脏仓库：报出变更数')
    // apply 时拍的快照：之后仓库再变，provider 文本不变（不重跑 git）
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    eq(c.text({}), text, '快照在 apply 时固定，后续文件变化不改文本')
  }

  // detached HEAD
  {
    const sha = sh(repo, ['rev-parse', '--short', 'HEAD'])
    sh(repo, ['checkout', '-q', '--detach', sha])
    const snap = snapshotGit(repo)
    eq(snap.detached, true, 'detached HEAD 识别')
    eq(snap.branch, sha, 'detached HEAD 报短 sha')
    check(describeGit(snap).includes(`detached HEAD at ${sha}`), 'detached HEAD 文案')
  }

  // 分支名带 {{ 不会炸 assemble
  {
    const text = renderEnvContext({ date: '2026-01-01', git: describeGit({ kind: 'repo', branch: 'feat/{{x}}', detached: false, dirty: false, changed: 0 }) })
    check(!text.includes('{{'), '分支名里的 {{ 被拆开')
    check(text.includes('feat/{ {x}}'), '拆开后仍保留分支名信息')
  }

  // ---- 非 git 目录 ----
  const plain = join(root, 'plain')
  sh(root, ['init', '-q', join(root, 'unused')]) // 让 root 下确有别的仓库，证明识别按 cwd 不按兄弟目录
  execFileSync('mkdir', ['-p', plain])
  let inRepo = true
  try { sh(plain, ['rev-parse', '--is-inside-work-tree']); } catch { inRepo = false }
  if (inRepo) {
    // 系统 tmpdir 本身落在某个 git 仓库里（罕见），这组断言无法成立，如实跳过
    console.log('SKIP tmpdir 位于 git 仓库内，跳过「非 git 目录」断言')
  } else {
    let threw = false
    let snap
    try { snap = snapshotGit(plain) } catch { threw = true }
    check(!threw, '非 git 目录不抛')
    eq(snap?.kind, 'not-a-repo', '非 git 目录识别为 not-a-repo')
    const { contexts: [c] } = collect({ cwd: plain })
    const text = c.text({})
    check(text.includes('not a git repository'), '非 git 目录如实写明', text.split('\n').at(-1))
    check(text.includes(today), '非 git 目录仍有日期')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---- git 不存在 / 超时：注入假 exec ----

{
  const enoent = () => { const e = new Error('spawnSync git ENOENT'); e.code = 'ENOENT'; throw e }
  const snap = snapshotGit(process.cwd(), enoent)
  eq(snap.kind, 'unavailable', 'git ENOENT 识别为 unavailable')
  let threw = false
  let text
  try { text = createProvider({ cwd: process.cwd(), exec: enoent })({}) } catch { threw = true }
  check(!threw, 'git 不存在时 provider 不抛')
  check(typeof text === 'string' && text.includes('git: not available'), 'git 不存在时如实写明')
  check(text.includes(today), 'git 不存在时仍有日期')
}

{
  const timeout = () => { const e = new Error('spawnSync git ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e }
  const snap = snapshotGit(process.cwd(), timeout)
  eq(snap.kind, 'error', 'git 超时归为 error')
  const text = createProvider({ cwd: process.cwd(), exec: timeout })({})
  check(text.includes('git: unknown (ETIMEDOUT)'), 'git 超时如实写原因')
}

{
  // 本仓库自身：rev-parse 的分支名应与插件报出的一致（独立第三方回读）
  const branch = sh(process.cwd(), ['symbolic-ref', '--short', 'HEAD'])
  const snap = snapshotGit(process.cwd())
  eq(snap.kind, 'repo', '本仓库识别为 repo')
  eq(snap.branch, branch, '本仓库分支与 git symbolic-ref 一致')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
