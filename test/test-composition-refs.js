/**
 * 组合层引用的守卫测试：四个 cordis 文件里每一处 `name:` 都得解析得到。
 *
 * 存在的理由是一类**只在运行时才炸、而且炸得很晚**的失败：升级 dsh 时上游改名或
 * 删包，组合层还照旧引用它。单元测试全绿、`npm ci` 全绿、`--help` 也正常，
 * 直到真的 boot 才报 "failed to import loader entry"；preset 那一层更晚——
 * 要等到有人用那个预设开会话。本次 0.1.0-rc.6 → 0.1.2-alpha.3 的升级动了 57 个
 * 依赖、新增 18 个包，正是这类断链最容易发生的时刻，而当时没有任何测试盯着它。
 *
 * ── 四个文件的解析基准各不相同，这是本测试最要紧的知识 ──────────────────
 * 写这个测试之前我按「统一从仓库根解析」查过一遍，20 处报错里 19 处是假阳性。
 * 正确的基准是：
 *   cordis.yml                        相对路径 → 仓库根；包名 → 仓库 node_modules
 *   eval/cordis.eval.yml              相对路径 → **eval/**（写的是 ../plugins/x.js）
 *   presets/kingcode/agent.cordis.yml 包名 → **profile 目录**，也就是全局 dsh 那棵树；
 *                                     仓库 node_modules 里没有它们是正常的
 *   profile/cordis.patch.yml          包名 → profile 目录；其中 kingcode-web-brand
 *                                     是 setup.sh 把**本仓库子目录**link 进去的
 * 把基准搞错的代价是「测试天天红、大家学会无视它」，比没有测试更糟。
 *
 * 跑法：node test/test-composition-refs.js（失败退出码 1）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const note = (line) => { console.log(`     ${line}`) }

/**
 * 本仓库自带的包，按 package.json 的 name 索引。
 * **仓库根自己也算一个**：setup.sh 把整个仓库 link 成 profile 里的包 `kingcode`，
 * 预设正是靠这条写 `kingcode/plugins/<x>.js` 来引用本仓库插件的。漏了根就会
 * 把那两行判成断链——写这个测试时我第一版就漏了，是它自己抓出来的。
 */
function localPackages() {
  const out = new Map()
  try { out.set(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name, '.') } catch { /* 同下 */ }
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const manifest = join(ROOT, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    try { out.set(JSON.parse(readFileSync(manifest, 'utf8')).name, entry.name) } catch { /* 坏 json 交给别的测试管 */ }
  }
  return out
}

/** 全局 dsh 那棵树的 node_modules；找不到就返回 undefined（CI 上正常）。 */
function globalDshModules() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dir = join(root, '@deepseek-ai', 'dsh', 'node_modules')
    return existsSync(dir) ? dir : undefined
  } catch { return undefined }
}

const LOCAL = localPackages()
const GLOBAL_DSH = globalDshModules()

/** 一处引用的写法：相对路径还是包名。 */
const isRelative = (name) => name.startsWith('./') || name.startsWith('../')

/**
 * 解析一个包名。子路径（如 a/b/c）先解析基包，再看它的 exports 有没有那一条。
 * @param name - 引用里写的包名，可能带子路径。
 * @param allowGlobal - 是否允许落到全局 dsh 那棵树上。
 * @returns 命中来源的说明，解析不到时返回 undefined。
 */
function resolvePackage(name, allowGlobal) {
  const parts = name.split('/')
  const base = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = name.slice(base.length)

  const checkExports = (manifestPath, where) => {
    if (subpath === '') return where
    // 子路径写成文件的（kingcode/plugins/x.js），直接查文件在不在——比翻 exports 准
    if (/\.(?:js|mjs|cjs)$/.test(subpath)) {
      return existsSync(join(dirname(manifestPath), subpath)) ? where : undefined
    }
    try {
      const exp = JSON.parse(readFileSync(manifestPath, 'utf8')).exports
      // 没有 exports 字段的包，子路径按老式目录解析，这里不深究
      if (exp === undefined || typeof exp !== 'object') return where
      return Object.keys(exp).includes(`.${subpath}`) ? where : undefined
    } catch { return where }
  }

  if (LOCAL.has(base)) return checkExports(join(ROOT, LOCAL.get(base), 'package.json'), `仓库子目录 ${LOCAL.get(base)}/`)

  const inRepo = join(ROOT, 'node_modules', base, 'package.json')
  if (existsSync(inRepo)) return checkExports(inRepo, '仓库 node_modules')

  if (allowGlobal && GLOBAL_DSH !== undefined) {
    const inGlobal = join(GLOBAL_DSH, base, 'package.json')
    if (existsSync(inGlobal)) return checkExports(inGlobal, '全局 dsh 树')
  }
  return undefined
}

/** 四个组合层，各带自己的解析基准。 */
const LAYERS = [
  { file: 'cordis.yml', relBase: '.', allowGlobal: false, why: 'CLI 形态的组合，跑在仓库里' },
  { file: 'eval/cordis.eval.yml', relBase: 'eval', allowGlobal: false, why: '相对路径写的是 ../plugins/，基准是 eval/' },
  { file: 'presets/kingcode/agent.cordis.yml', relBase: '.', allowGlobal: true, why: '预设的包名从 profile（全局 dsh）解析' },
  { file: 'profile/cordis.patch.yml', relBase: '.', allowGlobal: true, why: 'profile 覆盖层，含 link 进去的本仓库子包' },
]

let total = 0
for (const layer of LAYERS) {
  const path = join(ROOT, layer.file)
  if (!existsSync(path)) { check(false, `${layer.file} 存在`); continue }
  const text = readFileSync(path, 'utf8')
  const names = [...new Set([...text.matchAll(/^[^\S\n]*(?:-[^\S\n]*)?name:[^\S\n]*'([^']+)'/gm)].map((m) => m[1]))]

  console.log(`\n── ${layer.file}（${names.length} 处引用；${layer.why}）`)
  let bad = 0
  for (const name of names) {
    total++
    // cordis: 是内置协议（cordis:group / cordis:include），不是包
    if (name.startsWith('cordis:') || name.startsWith('$')) continue

    if (isRelative(name)) {
      const target = resolve(ROOT, layer.relBase, name)
      if (!existsSync(target)) { bad++; note(`✗ ${name} → ${target}`) }
      continue
    }
    const where = resolvePackage(name, layer.allowGlobal)
    if (where === undefined) { bad++; note(`✗ ${name}（仓库/${layer.allowGlobal ? '全局 dsh' : '仅仓库'} 都解析不到）`) }
  }
  check(bad === 0, `${layer.file} 的引用全部解析得到`, bad === 0 ? '' : `${bad} 处断链`)
}

console.log()
check(total > 100, '扫到的引用数量合理（解析器失灵会让它骤减）', `共 ${total} 处`)
check(LOCAL.size > 0, '认出了本仓库自带的子包', [...LOCAL.keys()].join(', '))
if (GLOBAL_DSH === undefined) {
  console.log('跳过 全局 dsh 树的核对  本机没装 dsh；预设那一层的包名这次没验（CI 正常，开发机上应当能找到）')
} else {
  check(true, '找到了全局 dsh 树', GLOBAL_DSH.replace(/.*node_modules\//, '…/'))
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
