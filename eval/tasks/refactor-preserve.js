/**
 * 重构保行为类任务：fixture 的 inventory.js 里 addStock / removeStock / reserveStock
 * 三个函数开头有一段逐字相同的参数校验（4 个 if + throw，12 行）复制了 3 次。
 * 任务：消除重复、行为不变。agent 在 fixture 的**副本**上干活。
 *
 * 判分（零 LLM）三件事，缺一不可：
 * ① 隐藏测试全过：eval/oracles/refactor-preserve/test.js 做**差分判分**——同一张
 *    用例清单（三个函数 × 正常路径 / 每条校验 / 校验顺序 / 业务错误 / 不动入参）
 *    同时喂给夹具原件与改后模块，逐例比对返回值与抛错（类型+信息）；同时断言
 *    导出集合与原件一致（公开 API 不增不减）。期望值由原件现算，不手抄。
 * ② 重复确实消除。统计的特征（都在去掉注释后的源码里数，扫 cwd 下全部 .js，
 *    test.js 除外，所以把校验挪进新文件也算数）：
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
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** cwd 下全部待扫源码拼成一串（test.js 冻结且不含实现，排除）。 */
function sourcesUnder(dir) {
  const skip = (rel) => SCAN_IGNORE.some(rule => rel === rule || rel.startsWith(rule + '/'))
  return listFiles(dir, skip)
    .filter(rel => /\.(m|c)?js$/.test(rel))
    .map(rel => ({ rel, src: stripComments(readFileSync(join(dir, rel), 'utf8')) }))
}

export default {
  id: 'refactor-preserve',
  description: '消除三个函数里逐字复制的参数校验块，行为（返回值、抛错类型与信息、导出）不变',
  judge: '隐藏差分测试（原件 vs 改后逐例比对 + 导出集合）全过 + 重复特征计数（校验 message 各 ≤1、throw 总数 ≤ 原件减冗余、原件重复的 if 条件各 ≤1）+ test.js/package.json 冻结',
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
    const oracle = runOracle(process.execPath, [oracleTest], {
      cwd: runDir,
      timeoutMs: 30_000,
      env: { ...process.env, RP_ORIGIN: join(originDir, MODULE), RP_TARGET: join(cwd, MODULE) },
    })
    if (oracle.timedOut) return { pass: false, detail: '隐藏测试超时（30s）' }
    if (oracle.error) throw new Error(`隐藏测试起不来：${oracle.error}`) // spawn 失败是判分环境问题 → harness-error
    if (oracle.status !== 0) {
      const fails = oracle.stdout.split('\n').filter(l => l.startsWith('FAIL'))
      return {
        pass: false,
        detail: `隐藏测试失败（退出码 ${oracle.status}，${fails.length} 项）：${fails.slice(0, 4).join('；') || oracle.stderr.trim().split('\n').slice(-1)[0]}`,
      }
    }

    // ② 重复确实消除：阈值全部从原件推导
    const originSrc = stripComments(readFileSync(join(originDir, MODULE), 'utf8'))
    const dupes = duplicatedMessages(originSrc)
    if (dupes.length === 0) throw new Error('夹具原件里没有重复的抛错信息——夹具被改坏了')
    const redundancy = dupes.reduce((s, { n }) => s + (n - 1), 0)
    const maxThrows = countThrows(originSrc) - redundancy

    const files = sourcesUnder(cwd)
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
      detail: `隐藏测试 ${okCount} 项全过；${dupes.length} 条校验 message 各 ≤1 次、throw ${throwsNow}/${maxThrows}、${dupConds.length} 条校验条件各 ≤1 次；agent 退出码 ${exitCode}`,
    }
  },
}
