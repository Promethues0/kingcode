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
 *    每个变异体：把工作目录克隆一份、换掉 duration.js、跑同一套测试，测试失败 = 杀死。
 *    **至少杀死 4 个**才算过；杀灭线是题面的一部分，不随结果调。
 *    变异体载入时与「原件 + 规格」逐字比对，漂移 → harness-error，不用过期变异体打分。
 * ③ 防作弊：duration.js 逐字节冻结（assertFrozen）；夹具文件不得删（fileSetDiff.removed 为空）；
 *    只认 agent **新建**的、源码里提到 node:test 或 assert 的 .js/.mjs/.cjs 文件为测试——
 *    顺手留下的探索脚本不会被当测试跑，也不会误伤 ①。
 *    空测试/只测常量的测试在 ① 能过，但一个变异体也杀不死，在 ② 自然挂掉。
 *    **测试不得读盘/起进程**：曾复现过的作弊——测试 readFileSync('./duration.js') 断言源码含/不含
 *    某子串，原件过、变异体全灭、却一行行为都没测。于是先静态扫描测试文件及其相对 import 的
 *    本地文件：出现 fs / node:fs / fs/promises / child_process / node:child_process 字面量
 *    （import / require / 动态 import / createRequire / getBuiltinModule 全部经它），或对
 *    parseDuration / formatDuration 取源码（.toString() / String() / 模板串），一律 FAIL 并点名。
 *    纯函数单测没理由做这些；合法测试（import 模块、调函数、断言返回值/抛错）不会命中。
 */

import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { assertFrozen, copyDir, fileSetDiff, runOracle } from '../lib/guards.js'
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
const ignored = (rel) => IGNORE.some(rule => rel === rule || rel.startsWith(rule + '/'))

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
function scanForbidden(cwd, testFiles, addedSet) {
  const hits = []
  const seen = new Set()
  const queue = [...testFiles]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const src = readFileSync(join(cwd, rel), 'utf8')
    for (const { re, why } of FORBIDDEN) if (re.test(src)) hits.push({ file: rel, why })
    for (const spec of importSpecifiers(src)) {
      const next = resolveLocal(cwd, rel, spec)
      if (next && isJs(next) && addedSet.has(next)) queue.push(next)
    }
  }
  return hits
}

/** 把工作目录克隆到 dst（跳过 node_modules/.kingcode/.git），供换入变异体后跑测试。 */
function cloneWorkdir(cwd, dst) {
  cpSync(cwd, dst, {
    recursive: true,
    filter: (src) => !ignored(relative(cwd, src).split(sep).join('/')),
  })
  return dst
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
  description: '给无测试的 duration.js（时长字符串解析/格式化）补测试；变异测试判分：6 个单 bug 变异体至少杀死 4 个',
  judge: 'agent 新建的测试（node --test 显式文件列表）在原件上全过 + 换入 6 个隐藏变异体逐个复跑、至少 4 个失败（杀死）+ duration.js 冻结、夹具不得删',
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

    // ② 变异测试：逐个换入变异体，测试失败 = 杀死；超时不算杀死（保守）
    const mutants = loadMutants(readFileSync(join(originDir, MODULE), 'utf8'))
    const verdicts = mutants.map(m => {
      const dir = cloneWorkdir(cwd, join(runDir, 'mutants', m.id))
      cpSync(m.file, join(dir, MODULE))
      const r = runTests(dir, testFiles)
      const killed = !r.timedOut && r.status !== 0
      return { id: m.id, killed, timedOut: r.timedOut, status: r.status }
    })
    const killed = verdicts.filter(v => v.killed).length
    const board = verdicts.map(v => `${v.id}${v.killed ? '✓' : v.timedOut ? '⏱' : '✗'}`).join(' ')
    const pass = killed >= KILL_THRESHOLD
    return {
      pass,
      detail: `杀死 ${killed}/${mutants.length}（线 ${KILL_THRESHOLD}）：${board}；测试文件 ${testFiles.join('、')}；agent 退出码 ${exitCode}`,
    }
  },
}
