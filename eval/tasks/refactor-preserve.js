/**
 * 重构保行为类任务：fixture 的 inventory.js 里 addStock / removeStock / reserveStock
 * 三个函数开头有一段逐字相同的参数校验（4 个 if + throw，12 行）复制了 3 次。
 * 任务：消除重复、行为不变。agent 在 fixture 的**副本**上干活。
 *
 * 判分（零 LLM）三件事，缺一不可：
 * ① 隐藏测试全过：eval/oracles/refactor-preserve/test.js 做**差分判分**——同一张
 *    用例清单（三个函数 × 正常路径 / 每条校验 / 校验顺序 / 业务错误 / 不动入参）
 *    同时喂给夹具原件与改后模块，逐例比对返回值与抛错（类型+信息），同时断言
 *    导出集合与原件一致（公开 API 不增不减）。期望值由原件现算，不手抄。
 * ② 重复确实消除。统计的特征都在去掉注释后的源码里数。**扫描口径以「运行时实测」为准**：
 *    隐藏测试本来就在子进程里 import 目标模块，判分器给那个子进程 `--import` 预载
 *    `oracles/refactor-preserve/trace-loads.js`，用 `module.registerHooks` 记下**每一次模块
 *    解析的真实结果**（见该文件头注释）。判分器不再猜「大概加载了什么」，而是从 inventory.js
 *    沿这张实测清单做可达闭包，闭包里的文件就是这次真正跑起来的实现。
 *    三条 fail-closed 规则（核对不了就不给过，与旧的 external/missing 分支同构）：
 *      · 子进程一条追踪记录都没吐 → **harness-error**（钩子没挂上，判分器没资格下结论）；
 *      · 闭包里出现非 file: 来源（`data:` 之类内联代码）→ FAIL，判分器读不到源码；
 *      · 闭包里出现工作目录之外的文件 → FAIL，实现必须留在工作目录里。
 *    这一条把「静态扫描猜运行时」的整类绕法从原理上关掉：已实证的四条——符号链接指向
 *    runDir 外原件、原件塞进 node_modules 再 `export * from 'legacy'`、`await import('./hid'+'den.js')`
 *    拼接说明符、`import(new URL('../stash/impl.js', import.meta.url).href)`——共同点都是
 *    「判分器以为自己扫全了，其实没有」。现在清单由 node 自己给：符号链接被 node 解析成真身、
 *    拼接与 new URL 说明符照样留下解析记录、CJS `require()` 也罩得住（实测 registerHooks 覆盖，
 *    register 的独立线程钩子漏 require）。
 *    静态一侧另加一条**穷尽**规则（不是黑名单）：ECMA 文法规定 `import … from` / `export … from`
 *    的说明符只能是字符串字面量，能写成任意表达式的只有动态 `import()` 与 `require()`；
 *    所以「说明符不是字符串字面量」的 `import(` / `require(` 一律 FAIL——判分器读不出说明符，
 *    就核对不了它加载了什么。
 *    实际扫描集合 = 运行时闭包 ∪ 静态模块图 ∪ cwd 目录遍历（SCAN_IGNORE 除外），按 realpath 去重。
 *    并集而不是只取运行时：目录遍历保住「把校验抄进一个没被 import 的文件」也算重复未消除的
 *    旧口径，静态模块图保住「写了但这次没走到的分支」。把校验挪进新文件仍然算数（三侧都覆盖得到）。
 *    统计的特征：
 *    a. 原件里出现 >1 次的抛错信息字面量（即那 4 条校验的 message，原件各 3 次），
 *       改后每条出现次数 ≤ 1——三份复制还在则为 3；
 *    b. `throw` 关键字总数 ≤ 原件 throw 数 − 重复冗余数（原件 14 = 12 条校验 + 2 条
 *       业务错误，冗余 4×2=8，阈值 6）——把 message 提成常量却保留三份 if/throw 的
 *       假重构过不了 a 之外还会在这里挂。
 *    c. 原件里出现 >1 次的 `if (…)` 条件表达式（括号配平抽取，连同其顶层 `||`/`&&`
 *       操作数；去掉全部空白后比对），改后每条出现次数 ≤ 1——堵「message 提成常量 +
 *       `const fail = (Ctor, msg) => { throw new Ctor(msg) }`，4 个 if 原样三份」的绕法：
 *       它让 a、b 都失明（message 只剩一处、throw 只剩一处），但三份 if 条件还在。
 *    三项阈值/特征全部从原件推导，不手算常量。
 * ③ 防作弊：test.js / package.json 与原件逐字节一致（assertFrozen）；夹具文件不得
 *    删除（fileSetDiff.removed 为空）；新建文件允许但一并纳入 ② 的扫描。
 *
 * **判分器核对不到的地方，如实登记，不吹**：运行时追踪管的是「模块从哪解析」，不管
 * 「源码从哪来」。绕过模块系统拿源码——`fs.readFileSync` 读工作目录外的文件再 `eval` /
 * `new Function` / `vm`，或被测模块自己再注册一层转换钩子（后注册者先执行，可以不调
 * next 就返回自造源码）——追踪看不见。注意这条口子比看上去窄：只要那段源码以字符串
 * 形式出现在工作目录里的任何文件中，②a/②c 数的是**源码文本子串**，照样数得到；真正漏
 * 的只有「从工作目录之外读到源码字符串再执行」。要彻底关掉得给子进程上 `--permission
 * --allow-fs-read`，但隐藏测试自己就得读工作目录外的原件做差分，允许读原件等于把这条
 * 口子重新打开（被测模块能从 process.env.RP_ORIGIN 拿到原件路径），故未采用。
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertFrozen, copyDir, fileSetDiff, listFiles, runOracle } from '../lib/guards.js'

const FIXTURE = 'refactor-preserve'
const MODULE = 'inventory.js'
const FROZEN = ['test.js', 'package.json']
const SCAN_IGNORE = ['node_modules', '.kingcode', '.git', 'test.js']

/** 去掉块注释与行注释再数特征——agent 写的 JSDoc（如 @throws 某某信息）不该算进重复。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** 子串出现次数（非重叠）。 */
const countOf = (hay, needle) => hay.split(needle).length - 1

/** `throw` 关键字个数（整词；`throws` 不算）。 */
const countThrows = (src) => (src.match(/\bthrow\b/g) ?? []).length

/** 去掉全部空白——`typeof item!=='object'` 与原件写法算同一条件。 */
const squash = (s) => s.replace(/\s+/g, '')

/**
 * 抽取源码里每个 `if (…)` 的条件表达式（括号配平，跳过字符串/模板字面量里的括号），
 * 返回去空白后的文本列表（含重复）。
 */
function ifConditions(src) {
  const out = []
  const re = /\bif\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let quote = null
    let i = m.index + m[0].length
    const start = i
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
      } else if (ch === '\'' || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    if (depth !== 0) break // 括号没配平：源码有语法问题，后面隐藏测试会炸，这里不猜
    out.push(squash(src.slice(start, i - 1)))
    re.lastIndex = i
  }
  return out
}

/** 把（已去空白的）条件按顶层 `||` / `&&` 拆成操作数；括号内的不拆。 */
function topLevelOperands(cond) {
  const parts = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i]
    if (quote) {
      cur += ch
      if (ch === '\\') cur += cond[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (ch === '|' || ch === '&') && cond[i + 1] === ch) {
      parts.push(cur); cur = ''; i++; continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.filter(Boolean)
}

/**
 * 原件里出现 >1 次的 if 条件（完整条件 + 其顶层操作数）——三份校验块的另一组指纹。
 * 只从原件推导，不硬编码任何表达式。
 */
function duplicatedConditions(originSrc) {
  const seen = new Map()
  for (const cond of ifConditions(originSrc)) {
    const keys = new Set([cond, ...topLevelOperands(cond)])
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([cond, n]) => ({ cond, n }))
}

/** 原件里出现 >1 次的抛错信息字面量——这就是「那段特征代码」。 */
function duplicatedMessages(originSrc) {
  const seen = new Map()
  for (const m of originSrc.matchAll(/throw new \w+\((['"`])(.*?)\1\)/g)) {
    seen.set(m[2], (seen.get(m[2]) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([msg, n]) => ({ msg, n }))
}

const BUILTIN = new Set(builtinModules)
const isBuiltin = (spec) => spec.startsWith('node:') || BUILTIN.has(spec)

/** 源码里的模块说明符：静态 import/`export … from`、裸 import 'x'、动态 import()、require()。 */
function importSpecifiers(src) {
  const out = []
  const patterns = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[2])
  return out
}

/**
 * 找出「说明符不是字符串字面量」的 `import(…)` / `require(…)`。
 *
 * 这条规则对静态一侧是**穷尽的，不是黑名单**：ECMA 文法规定 `import … from` /
 * `export … from` / 裸 `import 'x'` 的说明符只能是 StringLiteral，写不成表达式；
 * 能接任意表达式的入口只有动态 `import()` 与 `require()` 这两个调用。堵住这两个，
 * 「源码里读不出说明符」的情况就穷尽了——判分器核对不了加载的是什么，直接不给过，
 * 与 external / missing 两条分支同构。
 *
 * 注意反引号也算读不出：`importSpecifiers` 只认单双引号，模板串（哪怕没有插值）
 * 不会进模块图，放行就等于放行一个扫不到的说明符。
 * @returns {string[]} 每个可疑调用的单行片段（给 detail 用）
 */
function opaqueSpecifierCalls(src) {
  const out = []
  const re = /\b(?:import|require)\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    // 成员访问不是这两个入口：`obj.require(…)` / `foo.import(…)` 与模块加载无关
    if (src.slice(0, m.index).trimEnd().endsWith('.')) continue
    // 必须是**完整**的一条字符串字面量，后面直接收口（`)` 或 import 属性的 `,`）。
    // 只看开头一个引号不够：`import('./hid' + 'den.js')` 也以引号开头，说明符却读不出来。
    const rest = src.slice(m.index + m[0].length).trimStart()
    const quote = rest[0]
    if (quote === '\'' || quote === '"') {
      let i = 1
      for (; i < rest.length; i++) {
        if (rest[i] === '\\') i++
        else if (rest[i] === quote) break
      }
      const after = rest.slice(i + 1).trimStart()[0]
      if (i < rest.length && (after === ')' || after === ',')) continue
    }
    out.push(src.slice(m.index, m.index + 80).split('\n')[0].trim())
  }
  return out
}

/** 运行时追踪记录的行首标记，与 oracles/refactor-preserve/trace-loads.js 约定一致。 */
const TRACE_MARK = '#RPTRACE#'

/**
 * 从隐藏测试子进程的 stderr 里挑出运行时加载记录。
 * 钩子用 `writeSync(2, …)` 直写 fd 2——append-only：被测代码同在一个进程里，
 * 能多写几行假记录，却删不掉真记录，而多出来的边只会让扫描范围变大。
 */
function parseTrace(stderr) {
  const out = []
  for (const line of stderr.split('\n')) {
    const at = line.indexOf(TRACE_MARK)
    if (at < 0) continue
    try {
      out.push(JSON.parse(line.slice(at + TRACE_MARK.length)))
    } catch { /* 半行/被别的输出截断，跳过——真记录只会多不会少 */ }
  }
  return out
}

/** 报错时给人看的 stderr：把追踪记录滤掉，别让几十行 #RPTRACE# 盖住真正的失败信息。 */
const withoutTrace = (stderr) => stderr.split('\n').filter(l => !l.includes(TRACE_MARK)).join('\n')

/** file: URL → 真身绝对路径；非 file: 返回 null（交给调用方判死）。 */
function fileUrlToReal(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null
  let p
  try { p = fileURLToPath(url) } catch { return null }
  return existsSync(p) ? realpathSync(p) : p
}

/** abs 是否在 root 目录之内（root 自身不算）。 */
function isInside(root, abs) {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 用运行时追踪记录做**可达闭包**：从目标模块出发，顺着 node 实际解析出的边往下走。
 * 这就是「这次跑起来的实现由哪些文件组成」的实测答案，不是静态猜测。
 * @returns {{ files: string[], opaque: Array<{from,spec,url}> }}
 *   files = 闭包里的文件真身绝对路径（含目标模块自身）；
 *   opaque = 闭包里非 file:、非 node: 的来源（`data:` 内联代码之类，判分器读不到源码）。
 */
function runtimeClosure(records, targetAbs) {
  const edges = new Map()
  for (const r of records) {
    if (!r || typeof r.u !== 'string') continue
    const parent = typeof r.p === 'string' ? (fileUrlToReal(r.p) ?? r.p) : '(入口)'
    if (!edges.has(parent)) edges.set(parent, [])
    edges.get(parent).push({ spec: String(r.s ?? ''), url: r.u })
  }
  const start = existsSync(targetAbs) ? realpathSync(targetAbs) : targetAbs
  const seen = new Set([start])
  const queue = [start]
  const files = []
  const opaque = []
  while (queue.length > 0) {
    const cur = queue.shift()
    files.push(cur)
    for (const { spec, url } of edges.get(cur) ?? []) {
      if (url.startsWith('node:')) continue // 内置模块：没有源码可扫，也藏不了实现
      const real = fileUrlToReal(url)
      if (real === null) { opaque.push({ from: cur, spec, url }); continue }
      if (seen.has(real)) continue
      seen.add(real)
      queue.push(real)
    }
  }
  return { files, opaque }
}

/**
 * 相对/绝对说明符解析成**真身绝对路径**（试 原样 / +.js / +.mjs / +.cjs / /index.{js,mjs,cjs}）。
 * statSync 与 realpathSync 都跟随符号链接——「cwd 里只留一个链接、原件躲在链接后面」照样被读到。
 * 解析不到返回 null。
 */
function resolveModule(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec)
  const cands = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`,
    join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.cjs')]
  for (const cand of cands) {
    if (existsSync(cand) && statSync(cand).isFile()) return realpathSync(cand)
  }
  return null
}

/**
 * 扫描清单里的显示名：cwd 内给相对路径，跟出 cwd（符号链接）就给绝对路径，别把真相藏起来。
 * 比较前先把 cwd 也 realpath 一遍——传进来的 abs 都是真身，而 macOS 上 runDir 常是
 * `/var/...`（真身 `/private/var/...`）这样的软链，不归一化会让每个文件都显示成绝对路径。
 */
function label(cwd, abs) {
  const root = existsSync(cwd) ? realpathSync(cwd) : cwd
  const rel = relative(root, abs).split(sep).join('/')
  return rel === '' || rel.startsWith('..') ? abs : rel
}

/**
 * 从 entry 出发沿相对 import 走模块图（跟随符号链接）。
 * @returns {{ files: Array<{rel,abs,src}>, external: Array<{from,spec}>, missing: Array<{from,spec}> }}
 *   external = 非相对、非内置的说明符（实现躲进包里）；missing = 解析不到的相对说明符。
 */
function moduleGraph(cwd, entryRel) {
  const entryAbs = join(cwd, entryRel)
  if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
    return { files: [], external: [], missing: [{ from: '(入口)', spec: entryRel }] }
  }
  const files = []
  const external = []
  const missing = []
  const seen = new Set()
  const queue = [realpathSync(entryAbs)]
  while (queue.length > 0) {
    const abs = queue.shift()
    if (seen.has(abs)) continue
    seen.add(abs)
    const src = stripComments(readFileSync(abs, 'utf8'))
    files.push({ rel: label(cwd, abs), abs, src })
    for (const spec of importSpecifiers(src)) {
      if (isBuiltin(spec)) continue
      if (!spec.startsWith('.') && !spec.startsWith('/')) { external.push({ from: label(cwd, abs), spec }); continue }
      const next = resolveModule(abs, spec)
      if (next) queue.push(next)
      else missing.push({ from: label(cwd, abs), spec })
    }
  }
  return { files, external, missing }
}

const SYMLINK_MARK = ' \u2192 (symlink)'
const isSourceRel = (rel) => /\.(m|c)?js$/.test(rel)

/**
 * 目录遍历给出的相对路径清单 → 真身绝对路径清单（.js 文件）。
 * listFiles 把符号链接收成 `<rel> → (symlink)` 条目、且不跟随它下钻，那正是作弊用的暗门：
 * 这里把标记摘掉、realpath 到真身，指向文件的收进来，指向目录的整棵再遍历一遍。
 */
function scanTargets(dir, rel, skip) {
  const clean = rel.endsWith(SYMLINK_MARK) ? rel.slice(0, -SYMLINK_MARK.length) : rel
  const abs = join(dir, clean)
  if (!existsSync(abs)) return [] // 断链：node 也 import 不到，隐藏测试会先炸
  const real = realpathSync(abs)
  if (statSync(real).isFile()) return isSourceRel(clean) ? [{ rel: clean, abs: real }] : []
  if (!statSync(real).isDirectory()) return []
  return listFiles(real, skip)
    .filter(isSourceRel)
    .map(sub => ({ rel: `${clean}/${sub}`, abs: realpathSync(join(real, sub)) }))
}

/**
 * 待扫源码 = **运行时实测闭包** ∪ 静态模块图 ∪ cwd 下全部 .js 的目录遍历
 * （SCAN_IGNORE 除外，符号链接 realpath 到真身后照收），按 realpath 去重。
 *
 * 三者并集而不是三选一，各自补住对方的盲区：
 *   · 运行时闭包是唯一「不猜」的一侧——node 自己报的解析结果，new URL / 字符串拼接 /
 *     符号链接 / CJS require 全都现形；但它只覆盖这次真跑到的路径。
 *   · 静态模块图补「写了但这次没走到」的分支。
 *   · 目录遍历保住旧口径：把校验抄进一个谁都没 import 的文件，也算重复没消除。
 * 调用方已经保证运行时闭包里的文件都在 cwd 内（否则先 FAIL 了），所以这里读得到源码。
 */
function sourcesUnder(dir, graphFiles, runtimeFiles) {
  const skip = (rel) => SCAN_IGNORE.some(rule => rel === rule || rel.startsWith(rule + '/'))
  const out = []
  const seen = new Set()
  const add = (rel, abs, src) => {
    if (seen.has(abs)) return
    seen.add(abs)
    out.push({ rel, src })
  }
  for (const abs of runtimeFiles) add(label(dir, abs), abs, stripComments(readFileSync(abs, 'utf8')))
  for (const f of graphFiles) add(f.rel, f.abs, f.src)
  for (const listed of listFiles(dir, skip)) {
    for (const { rel, abs } of scanTargets(dir, listed, skip)) {
      add(rel, abs, stripComments(readFileSync(abs, 'utf8')))
    }
  }
  return out
}

export default {
  id: 'refactor-preserve',
  description: '消除三个函数里逐字复制的参数校验块，行为（返回值、抛错类型与信息、导出）不变',
  judge: '隐藏差分测试（原件 vs 改后逐例比对 + 导出集合）全过 + 重复特征计数（校验 message 各 ≤1、throw 总数 ≤ 原件减冗余、原件重复的 if 条件各 ≤1）；扫描口径以运行时实测为准——隐藏测试子进程 --import 挂 module.registerHooks 记下每次模块解析的真实结果，从 inventory.js 做可达闭包，闭包跑出工作目录或出现非 file: 来源即 FAIL、一条记录都没有即 harness-error，再并上静态模块图与 cwd 目录遍历；非字符串字面量说明符的 import()/require() 直接 FAIL + test.js/package.json 冻结',
  task: 'inventory.js 里 addStock、removeStock、reserveStock 三个函数开头的参数校验是整段复制粘贴的，'
    + '请把这段重复消掉。行为必须完全不变：同样的入参得到同样的返回值，非法入参抛出同样类型、同样信息的错误。'
    + '模块对外导出保持原样（不增不减），不要改 test.js 和 package.json。'
    + '改完跑一下 npm test 确认，最后简要说明你改了什么。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, 'eval', 'fixtures', FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, runDir, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }

    const originDir = join(repoRoot, 'eval', 'fixtures', FIXTURE)
    const oracleTest = join(repoRoot, 'eval', 'oracles', FIXTURE, 'test.js')

    // ③ 防作弊：冻结文件逐字节一致；夹具文件不得删
    const frozen = assertFrozen(cwd, originDir, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }
    const diff = fileSetDiff(originDir, cwd, { ignore: ['node_modules', '.kingcode', '.git'] })
    if (diff.removed.length > 0) {
      return { pass: false, detail: `删了夹具文件：${diff.removed.join('、')}` }
    }

    // ① 隐藏差分测试（子进程 + 超时；agent 的代码可能死循环，绝不在 harness 进程里 import）
    //    同时 --import 预载运行时加载追踪钩子：判分器不猜运行时加载了什么，直接问 node 自己。
    const tracer = join(repoRoot, 'eval', 'oracles', FIXTURE, 'trace-loads.js')
    if (!existsSync(tracer)) throw new Error(`运行时加载追踪钩子缺失：${tracer}`) // 判分资产没了 → harness-error
    const oracle = runOracle(process.execPath, ['--import', pathToFileURL(tracer).href, oracleTest], {
      cwd: runDir,
      timeoutMs: 30_000,
      env: { ...process.env, RP_ORIGIN: join(originDir, MODULE), RP_TARGET: join(cwd, MODULE) },
    })
    if (oracle.timedOut) return { pass: false, detail: '隐藏测试超时（30s）' }
    if (oracle.error) throw new Error(`隐藏测试起不来：${oracle.error}`) // spawn 失败是判分环境问题 → harness-error

    // 追踪记录一条都没有 → 子进程根本没走到「解析 test.js」这一步（钩子没挂上/node 没起来）。
    // 这是判分环境的病，**必须** harness-error：既不能伪装成 agent 的 FAIL（README 明令），
    // 也绝不能悄悄退回静态扫描当没事发生——判分器没资格对「加载了什么」下结论时就别下。
    // 放在 status 判定之前：node 自己起不来时 status 也是非 0，那不是隐藏测试判 agent 不过。
    const trace = parseTrace(oracle.stderr)
    if (trace.length === 0) {
      throw new Error(`隐藏测试子进程没吐出任何模块加载追踪记录（--import ${tracer} 的 `
        + `module.registerHooks 没生效，退出码 ${oracle.status}）：判分器无法核实运行时加载了哪些代码。`
        + `stderr 末尾：${withoutTrace(oracle.stderr).trim().split('\n').slice(-3).join(' / ')}`)
    }

    if (oracle.status !== 0) {
      const fails = oracle.stdout.split('\n').filter(l => l.startsWith('FAIL'))
      return {
        pass: false,
        detail: `隐藏测试失败（退出码 ${oracle.status}，${fails.length} 项）：${fails.slice(0, 4).join('；') || withoutTrace(oracle.stderr).trim().split('\n').slice(-1)[0]}`,
      }
    }

    // ② 重复确实消除：阈值全部从原件推导
    const originSrc = stripComments(readFileSync(join(originDir, MODULE), 'utf8'))
    const dupes = duplicatedMessages(originSrc)
    if (dupes.length === 0) throw new Error('夹具原件里没有重复的抛错信息——夹具被改坏了')
    const redundancy = dupes.reduce((s, { n }) => s + (n - 1), 0)
    const maxThrows = countThrows(originSrc) - redundancy

    // ②-0 运行时实测：这次到底加载了哪些代码（trace 已在上面取到并确认非空）。
    const cwdReal = realpathSync(cwd)
    const { files: runtimeFiles, opaque } = runtimeClosure(trace, join(cwd, MODULE))
    if (opaque.length > 0) {
      const list = opaque.map(o => `${label(cwd, o.from)} → ${o.url.slice(0, 60)}`).join('、')
      return {
        pass: false,
        detail: `运行时从非文件来源加载了代码：${list}——判分器读不到这段源码，`
          + '核对不了重复是否真的消除了；实现必须放在工作目录的文件里',
      }
    }
    const outside = runtimeFiles.filter(abs => !isInside(cwdReal, abs))
    if (outside.length > 0) {
      return {
        pass: false,
        detail: `运行时从工作目录之外加载了实现：${outside.join('、')}——`
          + `${MODULE} 只是个转发壳，真正跑的代码不在判分器扫得到的范围里；重构后的实现必须留在工作目录内`,
      }
    }

    const graph = moduleGraph(cwd, MODULE)
    const opaqueCalls = [...graph.files, ...runtimeFiles.map(abs => ({
      rel: label(cwd, abs), src: stripComments(readFileSync(abs, 'utf8')),
    }))].flatMap(f => opaqueSpecifierCalls(f.src).map(snippet => `${f.rel}: ${snippet}`))
    if (opaqueCalls.length > 0) {
      return {
        pass: false,
        detail: `说明符不是字符串字面量的动态加载：${[...new Set(opaqueCalls)].join('、')}——`
          + '判分器从源码里读不出它加载的是什么（静态 import/export … from 按文法只能跟字面量，'
          + '能写成表达式的只有 import() 与 require()），核对不了就不给过',
      }
    }
    if (graph.external.length > 0) {
      const list = graph.external.map(e => `${e.from} → '${e.spec}'`).join('、')
      return {
        pass: false,
        detail: `${MODULE} 的实现来自扫描范围之外的包（非相对导入）：${list}——判分器核对不了包里的代码，`
          + '重构后的实现必须留在工作目录的相对模块里',
      }
    }
    if (graph.missing.length > 0) {
      const list = graph.missing.map(e => `${e.from} → '${e.spec}'`).join('、')
      return { pass: false, detail: `模块图里有解析不到的相对导入：${list}——判分器没法核对这部分实现` }
    }

    const files = sourcesUnder(cwd, graph.files, runtimeFiles)
    const all = files.map(f => f.src).join('\n')
    const stillDuplicated = dupes
      .map(({ msg }) => ({ msg, count: countOf(all, msg) }))
      .filter(({ count }) => count > 1)
    if (stillDuplicated.length > 0) {
      return {
        pass: false,
        detail: `重复未消除：${stillDuplicated.map(({ msg, count }) => `"${msg}"×${count}`).join('、')}（每条应 ≤1；扫描 ${files.map(f => f.rel).join('、')}）`,
      }
    }
    const throwsNow = countThrows(all)
    if (throwsNow > maxThrows) {
      return {
        pass: false,
        detail: `throw 仍有 ${throwsNow} 处，阈值 ${maxThrows}（原件 ${countThrows(originSrc)} − 冗余 ${redundancy}）——校验分支还是多份`,
      }
    }
    const dupConds = duplicatedConditions(originSrc)
    if (dupConds.length === 0) throw new Error('夹具原件里没有重复的 if 条件——夹具被改坏了')
    const allSquashed = squash(all)
    const condsStill = dupConds
      .map(({ cond }) => ({ cond, count: countOf(allSquashed, cond) }))
      .filter(({ count }) => count > 1)
    if (condsStill.length > 0) {
      return {
        pass: false,
        detail: `校验条件仍多份：${condsStill.map(({ cond, count }) => `\`${cond}\`×${count}`).join('、')}（每条应 ≤1）——把 throw 藏进助手函数不算消除重复`,
      }
    }

    const okCount = oracle.stdout.split('\n').filter(l => l.startsWith('OK')).length
    return {
      pass: true,
      detail: `隐藏测试 ${okCount} 项全过；${dupes.length} 条校验 message 各 ≤1 次、throw ${throwsNow}/${maxThrows}、`
        + `原件里重复过的 ${dupConds.length} 条条件文本在改后源码里各出现 ≤1 次`
        + `（文本判据：语义等价的改写不在它的辨识范围内）。扫描 ${files.map(f => f.rel).join('、')}`
        + `（运行时实测加载 ${runtimeFiles.map(abs => label(cwd, abs)).join('、')}，全部在工作目录内）；agent 退出码 ${exitCode}`,
    }
  },
}
