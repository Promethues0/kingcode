/**
 * 补测试类任务（变异测试判分）：夹具 duration.js 是一个 ~60 行的纯函数模块
 * （parseDuration / formatDuration，时长字符串 ⇄ 秒数），一个测试都没有。
 * 任务：给它补一套测试、覆盖边界。agent 在 fixture 的**副本**上干活。
 *
 * 判分（零 LLM）三件事：
 * ① agent 新写的测试在**原件**上全过：显式把测试文件列表交给 `node --test`
 *    （bare assert 脚本与 node:test 文件它都认：前者按退出码、后者按用例结果）。
 *    刻意不走 npm test——package.json 的 test 脚本 agent 改得到，判分不能依赖它。
 * ② 变异测试：eval/oracles/add-tests/mutants/ 下 6 个变异体，各含**一个** bug
 *    （天数常量敲错 / 负号丢失 / 空串不抛 / 尾随字符 off-by-one / 重复单位不抛 /
 *    format(0) 漏特判，规格与杀法见 oracles/add-tests/mutants.js 头注释）。
 *    每个变异体：**原地**换掉 cwd 里的 duration.js（跑完在 finally 里还原成备份），
 *    跑同一套测试，测试失败 = 杀死。**至少杀死 4 个**才算过；杀灭线是题面的一部分，不随结果调。
 *    原地换而不是「克隆到 <runDir>/mutants/<id> 再换」，是因为换目录把判据交回了被测代码手里：
 *    测试只要 `if (!import.meta.url.includes('/workdir/')) process.exit(1)` 就能非零退出「杀死」
 *    全部 6 个变异体，一条行为都没测拿满分（已实证）。同一路径下原件跑与变异体跑逐字节同环境
 *    （同 cwd、同 argv、同 env、同 import.meta.url），测试无从区分自己在跑哪一份。
 *    变异体载入时与「原件 + 规格」逐字比对，漂移 → harness-error，不用过期变异体打分。
 * ②' 阴性对照（negative control）：队列里混进 3 份**行为与原件完全一致、只是写法不同**的
 *    duration.js（原件副本 / 改名重排版 / 换一套实现，见 oracles/add-tests/controls.js），
 *    与变异体走同一通道原地换入、跑同一套测试。行为型测试对它们**必然全过**；
 *    靠源码文本或运行环境判真伪的伪测试会把对照一起「杀死」。
 *    **杀死任何一个对照 = FAIL**，不看杀了几个真变异体；对照上跑超时同样不给过（核不了就不过）。
 *    这一条是结构性的，不是黑名单：对照与原件同属一个行为等价类，能把两者分开的判据
 *    一定不是行为。对照的等价性在判分时现算（数千条系统用例 + 确定性 fuzz，逐例比返回值、
 *    抛错类型与 message 原文、导出形状），不等价 → harness-error，绝不拿它冤枉合法测试。
 * ③ 防作弊：duration.js 逐字节冻结（assertFrozen）；夹具文件不得删（fileSetDiff.removed 为空）；
 *    只认 agent **新建**的、源码里提到 node:test 或 assert 的 .js/.mjs/.cjs 文件为测试——
 *    顺手留下的探索脚本不会被当测试跑，也不会误伤 ①。
 *    空测试/只测常量的测试在 ① 能过，但一个变异体也杀不死，在 ② 自然挂掉。
 *    **测试不得读盘/起进程**（黑名单，纵深防御的第二层）：曾复现过的作弊——测试
 *    readFileSync('./duration.js') 断言源码含/不含某子串，原件过、变异体全灭、却一行行为都没测。
 *    于是先静态扫描测试文件及其相对 import 的本地文件：出现 fs / node:fs / fs/promises /
 *    child_process / node:child_process 字面量（import / require / 动态 import / createRequire /
 *    getBuiltinModule 全部经它），或对 parseDuration / formatDuration 取源码
 *    （.toString() / String() / 模板串），一律 FAIL 并点名。
 *    **这层只是给低段位作弊一句更清楚的 detail，不是防线**——黑名单封的是几种具体写法，
 *    换个写法就绕过去了（实证：`m[k] + ''` 这种别名化的隐式 toString 八条正则一条不命中，
 *    零行为断言杀掉 5/6）。真正的防线是 ②' 的阴性对照：它不猜写法，只看「你把行为一样的
 *    模块也判失败了没有」。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { assertFrozen, copyDir, fileSetDiff, runOracle } from '../lib/guards.js'
import { loadControls } from '../oracles/add-tests/controls.js'
import { loadMutants } from '../oracles/add-tests/mutants.js'

const FIXTURE = 'add-tests'
const MODULE = 'duration.js'
const FROZEN = [MODULE]
const IGNORE = ['node_modules', '.kingcode', '.git']
const KILL_THRESHOLD = 4        // 6 个变异体至少杀 4 个
const TEST_TIMEOUT_MS = 30_000  // agent 写的测试可能死循环，每轮必须带超时

const isJs = (rel) => /\.(m|c)?js$/.test(rel)
/** 测试文件的最低特征：用了 node:test 或 assert（任一断言库都绕不开它们）。 */
const looksLikeTest = (src) => /node:test|\bassert\b/.test(src)

/**
 * 测试文件里不该出现的东西（静态扫描，命中即 FAIL）：
 * - 读盘/起进程模块的字面量：任何形式的 import/require/createRequire/getBuiltinModule 都绕不开这个字符串；
 * - 对被测函数取源码：parseDuration.toString() / String(parseDuration) / `${parseDuration}`，
 *   与读盘同效（变异体源码与原件不同），同样不算测行为。
 */
const FORBIDDEN = [
  { re: /(['"`])node:fs\1/, why: 'import 了 node:fs' },
  { re: /(['"`])fs\1/, why: 'import 了 fs' },
  { re: /(['"`])(?:node:)?fs\/promises\1/, why: 'import 了 fs/promises' },
  { re: /(['"`])(?:node:)?child_process\1/, why: 'import 了 child_process' },
  { re: /\b(?:parseDuration|formatDuration)\s*\.\s*toString\b/, why: '对被测函数取源码（.toString）' },
  { re: /\bString\s*\(\s*(?:parseDuration|formatDuration)\s*\)/, why: '对被测函数取源码（String()）' },
  { re: /\$\{\s*(?:parseDuration|formatDuration)\s*\}/, why: '对被测函数取源码（模板串）' },
  { re: /Function\s*\.\s*prototype\s*\.\s*toString\b/, why: '用了 Function.prototype.toString' },
]

/** 源码里的模块说明符：静态 import（含裸 import 'x'）、动态 import()、require()。 */
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

/** 相对说明符解析成 cwd 内的相对路径（试 原样 / +.js / +.mjs / +.cjs / /index.js）；解析不到返回 null。 */
function resolveLocal(cwd, fromRel, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const base = normalize(join(dirname(fromRel), spec))
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')]) {
    const abs = join(cwd, cand)
    if (existsSync(abs) && statSync(abs).isFile()) return cand.split(sep).join('/')
  }
  return null
}

/**
 * 从测试文件出发，沿相对 import 把 agent 新建的本地 js 文件全扫一遍（作弊逻辑挪进 helper 也逃不掉）。
 * 返回命中清单 [{ file, why }]；空数组 = 干净。
 */
/**
 * 只抹掉注释（保留字符串字面量——FORBIDDEN 找的正是带引号的模块名）。
 * @param {string} src
 * @returns {string} 注释处替换成等长空格的源码
 */
function stripCommentsOnly(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length
      out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; continue
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2
      out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; continue
    }
    // 字符串/模板串整段照抄：里面的 'node:fs' 就是要抓的东西
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < src.length && src[j] !== quote) { if (src[j] === '\\') j += 1; j += 1 }
      out += src.slice(i, Math.min(j + 1, src.length)); i = j + 1; continue
    }
    out += c; i += 1
  }
  return out
}

function scanForbidden(cwd, testFiles, addedSet) {
  const hits = []
  const seen = new Set()
  const queue = [...testFiles]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const src = readFileSync(join(cwd, rel), 'utf8')
    // 先抹注释再扫：一份只测行为的正经测试，只要注释里带引号提一句「不 import 'node:fs'」
    // 就会被判成作弊——**判分器冤枉正当工作比漏判一次作弊更糟**，那会让人不敢写注释。
    // （importSpecifiers 仍读原文：它要找的是真的 import，不受此影响。）
    for (const { re, why } of FORBIDDEN) if (re.test(stripCommentsOnly(src))) hits.push({ file: rel, why })
    for (const spec of importSpecifiers(src)) {
      const next = resolveLocal(cwd, rel, spec)
      if (next && isJs(next) && addedSet.has(next)) queue.push(next)
    }
  }
  return hits
}

/**
 * 变异体与阴性对照打乱成一条队列：两者走完全相同的通道（原地换入 duration.js、跑同一套测试），
 * 测试无从知道自己正在被喂哪一种。
 *
 * **顺序必须每次随机**，不能是固定交错：固定顺序等于把「第几次运行是对照」写成了公开规律，
 * 一个能跨进程数数的测试（计数落盘即可，`createRequire` 拼出 'f'+'s' 就绕过黑名单）
 * 只要在对照的序号上放行、其余判失败，就能零行为断言地拿满分——实证过。随机之后这条路
 * 需要它猜对一个每次都变的排列，而它没有任何信息可依据。
 * 每轮仍是独立的 node 进程、同一份 cwd/argv/env，合法测试与顺序无关，判分因此仍然确定。
 */
function buildQueue(mutants, controls) {
  const queue = [
    ...mutants.map(m => ({ kind: 'mutant', ...m })),
    ...controls.map(c => ({ kind: 'control', ...c })),
  ]
  // Fisher-Yates：判分器自己用真随机，不给作弊者可复现的种子
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[queue[i], queue[j]] = [queue[j], queue[i]]
  }
  return queue
}

/** 在 dir 里跑指定测试文件；退出码 0 = 全过。reporter 钉成 tap，输出格式不随 TTY 变。 */
function runTests(dir, files) {
  return runOracle(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, timeoutMs: TEST_TIMEOUT_MS })
}

/** 从一次测试运行里抠失败摘要给 detail：TAP 的 `not ok` 行优先，退回任何带 Error 的行。 */
function failureSummary({ stdout, stderr }) {
  const lines = (stdout + '\n' + stderr).split('\n').map(l => l.trim())
  const notOk = lines.filter(l => /^not ok\b/.test(l))
  const picked = notOk.length > 0 ? notOk : lines.filter(l => /Error\b/.test(l))
  return picked.slice(0, 4).join('；') || '（无可摘录的失败信息）'
}

export default {
  id: 'add-tests',
  description: '给无测试的 duration.js（时长字符串解析/格式化）补测试；变异测试判分：6 个单 bug 变异体至少杀死 4 个，且不许误杀 3 个行为等价的阴性对照',
  judge: 'agent 新建的测试（node --test 显式文件列表）在原件上全过 + 在同一工作目录里**原地**换入 6 个隐藏变异体与 3 个行为等价的阴性对照逐个复跑（跑完还原）：至少 4 个变异体失败（杀死），且**任何一个阴性对照失败即 FAIL**（说明测的是源码文本/环境而非行为；对照等价性判分时现算） + duration.js 冻结、夹具不得删',
  task: 'duration.js 里的 parseDuration 和 formatDuration 目前一个测试都没有。'
    + '请给这个模块补一套测试，覆盖正常路径和边界情况——模块头部注释写了它的约定，以此为准。'
    + '用 node:test 或裸 assert 都行，不要引入第三方依赖，不要修改 duration.js。'
    + '写完跑一遍确认全部通过，最后简要说明覆盖了哪些情况。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, 'eval', 'fixtures', FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, runDir, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }

    const originDir = join(repoRoot, 'eval', 'fixtures', FIXTURE)

    // ③ 防作弊：模块冻结；夹具文件不得删
    const frozen = assertFrozen(cwd, originDir, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }
    const diff = fileSetDiff(originDir, cwd, { ignore: IGNORE })
    if (diff.removed.length > 0) {
      return { pass: false, detail: `删了夹具文件：${diff.removed.join('、')}` }
    }

    // 测试文件 = agent 新建的、像测试的 js 文件
    const testFiles = diff.added
      .filter(isJs)
      .filter(rel => looksLikeTest(readFileSync(join(cwd, rel), 'utf8')))
    if (testFiles.length === 0) {
      return { pass: false, detail: `没有找到 agent 新建的测试文件（新增文件：${diff.added.join('、') || '无'}）` }
    }

    // ③ 续：测试不得读盘/起进程/取被测函数源码——读 duration.js 文本断言子串能「杀」所有变异体却没测任何行为
    const forbidden = scanForbidden(cwd, testFiles, new Set(diff.added))
    if (forbidden.length > 0) {
      const list = forbidden.map(h => `${h.file}：${h.why}`).join('；')
      return { pass: false, detail: `测试文件读盘/起进程/取源码，不算测行为（纯函数单测没理由这么做）：${list}` }
    }

    // ① 测试在原件上必须全过
    const onOriginal = runTests(cwd, testFiles)
    if (onOriginal.timedOut) return { pass: false, detail: `测试在原件上跑超时（${TEST_TIMEOUT_MS / 1000}s）：${testFiles.join('、')}` }
    if (onOriginal.status !== 0) {
      return { pass: false, detail: `测试在原件上没过（退出码 ${onOriginal.status}）：${failureSummary(onOriginal)}` }
    }

    // ② / ②' 变异测试 + 阴性对照：**原地**逐个换入模块，测试失败 = 「杀死」；超时不算杀死（保守）。
    //    对变异体，杀死是好事；对阴性对照，杀死是当场露馅。
    //    先把原件备份到 runDir（cwd 之外，测试的相对 import 够不到），跑完无论成败都还原——
    //    异常路径不还原会在证据目录里留下一份变异体，后来人翻 runDir 会看到假象。
    const originalSrc = readFileSync(join(originDir, MODULE), 'utf8')
    const mutants = loadMutants(originalSrc)
    const controls = await loadControls(originalSrc)   // 等价性现算，不等价直接抛 → harness-error
    const queue = buildQueue(mutants, controls)
    const modulePath = join(cwd, MODULE)
    const backupPath = join(runDir, 'module-backup', MODULE)
    mkdirSync(dirname(backupPath), { recursive: true })
    cpSync(modulePath, backupPath)
    let verdicts
    try {
      verdicts = queue.map(item => {
        cpSync(item.file, modulePath)
        const r = runTests(cwd, testFiles)
        const killed = !r.timedOut && r.status !== 0
        return { ...item, killed, timedOut: r.timedOut, status: r.status, failure: killed ? failureSummary(r) : '' }
      })
    } finally {
      cpSync(backupPath, modulePath)
    }
    // 还原没生效就别拿这轮结果打分：assertFrozen 在这一步**之前**跑，挡不住这里的失手 → harness-error
    if (!readFileSync(modulePath).equals(readFileSync(backupPath))) {
      throw new Error(`变异体跑完没能还原 ${MODULE}（备份在 ${backupPath}）`)
    }

    // 记分板：变异体 ✓=杀死（好）、对照 ✓=没被误杀（好）；两边都是 ✓ 好 ✗ 坏 ⏱ 超时
    const mark = (v) => `${v.id}${v.timedOut ? '⏱' : (v.kind === 'mutant' ? v.killed : !v.killed) ? '✓' : '✗'}`
    const mutantVerdicts = verdicts.filter(v => v.kind === 'mutant')
    const controlVerdicts = verdicts.filter(v => v.kind === 'control')
    const killed = mutantVerdicts.filter(v => v.killed).length
    const board = `变异体 ${mutantVerdicts.map(mark).join(' ')}｜阴性对照 ${controlVerdicts.map(mark).join(' ')}（✓ 好 ✗ 坏 ⏱ 超时）`
    const tail = `；${board}；测试文件 ${testFiles.join('、')}；agent 退出码 ${exitCode}`

    // ②' fail-closed：对照没全过就不给过——不管变异体杀了几个。
    const murdered = controlVerdicts.filter(v => v.killed)
    if (murdered.length > 0) {
      const list = murdered.map(v => `${v.id}（${v.what}）：${v.failure}`).join('；')
      return {
        pass: false,
        detail: '误杀阴性对照 —— 这些模块与 duration.js **行为完全一致**（等价性判分时逐例现算过），'
          + `只是写法不同，测试却判它们失败：${list}。`
          + '说明这套测试判的不是行为，而是源码文本 / 运行环境（源码指纹、Error.stack 行号、字面量子串之类），'
          + `所以杀死变异体也不算数。这些对照专抓：${[...new Set(murdered.map(v => v.catches))].join('；')}${tail}`,
      }
    }
    const unverifiable = controlVerdicts.filter(v => v.timedOut)
    if (unverifiable.length > 0) {
      return {
        pass: false,
        detail: `阴性对照 ${unverifiable.map(v => v.id).join('、')} 上测试跑超时（${TEST_TIMEOUT_MS / 1000}s），`
          + `核实不了「测的是不是行为」——核不了就不给过${tail}`,
      }
    }

    const pass = killed >= KILL_THRESHOLD
    return {
      pass,
      detail: `杀死 ${killed}/${mutantVerdicts.length}（线 ${KILL_THRESHOLD}）、阴性对照 ${controlVerdicts.length}/${controlVerdicts.length} 全过${tail}`,
    }
  },
}
