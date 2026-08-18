/**
 * project_stats 工具的无头测试：不起 agent、不调模型，直接拿到 defineTool
 * 的定义并驱动 execute。
 *
 * 跑法：node test/test-project-stats.js（失败退出码 1）
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../plugins/project-stats.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** 用假的 ctx 收下插件注册的工具定义。 */
function loadTool() {
  let captured
  plugin.apply({ tools: { register: def => { captured = def } } })
  if (captured === undefined) throw new Error('插件没有注册任何工具')
  return captured
}

/**
 * 样本树清单：路径 + 该文件所在深度（根目录下为 0）+ 是否应被计入。
 * 期望值全部由这张表推导，不手算——手算过一次，算错了。
 */
const FIXTURE = [
  { path: ['a.js'], depth: 0, counted: true },
  { path: ['b.js'], depth: 0, counted: true },
  { path: ['c.ts'], depth: 0, counted: true },
  { path: ['README'], depth: 0, counted: true },                    // 无扩展名
  { path: ['src', 'd.js'], depth: 1, counted: true },
  { path: ['deep', 'l2', 'l3', 'deep.js'], depth: 3, counted: true },
  { path: ['node_modules', 'pkg', 'noise.js'], depth: 2, counted: false },  // SKIP_DIRS
  { path: ['.git', 'config'], depth: 1, counted: false },                   // 点目录
]

/** 造出样本树。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kingcode-stats-'))
  for (const f of FIXTURE) {
    if (f.path.length > 1) mkdirSync(join(root, ...f.path.slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...f.path), '')
  }
  return root
}

/** 按扩展名统计清单里应被计入的文件（可选深度上限）。 */
function expected(maxDepth = Infinity) {
  const counts = new Map()
  let total = 0
  for (const f of FIXTURE) {
    if (!f.counted || f.depth > maxDepth) continue
    total++
    const name = f.path.at(-1)
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : '(无扩展名)'
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  return { total, counts }
}

const tool = loadTool()
const root = makeFixture()
const exec = { signal: new AbortController().signal }

try {
  check(tool.name === 'project_stats', ' 工具名是 project_stats', tool.name)

  const r = await tool.execute({ dir: root }, exec)
  const byExt = Object.fromEntries(r.byExtension.map(x => [x.extension, x.count]))
  const want = expected()

  check(r.root === root, '返回的 root 是解析后的绝对路径')
  for (const [ext, n] of want.counts) {
    check(byExt[ext] === n, `${ext} 计 ${n}`, `实得 ${byExt[ext]}`)
  }
  check(r.fileCount === want.total, `fileCount 为 ${want.total}`, `实得 ${r.fileCount}`)
  // byExtension 只取前 20 档（execute 里 slice(0,20)），扩展名多于 20 种时
  // 逐项之和会小于 fileCount——那是设计如此。本样本远低于该上限，故可对齐。
  check(
    r.byExtension.reduce((s, x) => s + x.count, 0) === r.fileCount,
    'fileCount 与逐项之和自洽（样本未触及 top-20 截断）',
  )
  // 噪声目录若被走进，.js 会多出 noise.js、无扩展名会多出 .git/config
  check(byExt['.js'] === want.counts.get('.js'), 'node_modules 未被走进')
  check(byExt['(无扩展名)'] === want.counts.get('(无扩展名)'), '.git 未被走进')

  // 深度限制：maxDepth 1 时 deep/l2 及更深不再展开
  const shallowWant = expected(1)
  const shallow = await tool.execute({ dir: root, maxDepth: 1 }, exec)
  check(shallow.fileCount === shallowWant.total, `maxDepth=1 时计 ${shallowWant.total}`, `实得 ${shallow.fileCount}`)

  // 目录不存在时不抛异常，返回空结果（walk 的 catch 兜底）
  const missing = await tool.execute({ dir: join(root, '不存在') }, exec)
  check(missing.fileCount === 0, '目录不存在时返回 0 而非抛错')

  // 已取消的 signal 必须立刻停手
  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await tool.execute({ dir: root }, { signal: aborted.signal })
  check(cancelled.fileCount === 0, '已取消的 signal 不做任何遍历')

  // render 是模型可见的呈现，必须能吃下 execute 的返回值
  const blocks = tool.output.render({ dir: root }, r)
  check(Array.isArray(blocks) && blocks[0]?.type === 'text', 'render 产出 text block')
  check(blocks[0].text.includes(`${want.total} files`), 'render 文本含文件总数')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
