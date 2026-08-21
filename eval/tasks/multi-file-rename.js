/**
 * 跨文件重命名任务：夹具是一个 5 文件的小账本库，函数 normalizeEntry 在 src/ 里
 * 有 11 处标识符引用（定义 / import / 具名再导出 / 直接调用 / 作为回调裸引用 /
 * 默认导出对象的简写键），另有 2 处同名干扰项只在注释与模板字符串里。
 * agent 要把它改名为 toLedgerEntry。可见的 test.js 只走 Ledger/summarize/validateBatch
 * 这些接口、从不点名该函数，所以它既是 agent 的回归手段，也能被冻结。
 *
 * 判分（零 LLM）：
 * ① test.js 与原件逐字节一致（assertFrozen）；
 * ② src/ 文件集合不变（fileSetDiff：不许为了改名新建/删源文件）；
 * ③ src/ 里剥掉注释与字符串后不得再有旧名标识符（自带的小扫描器识别行注释、块注释、
 *    单双引号串、模板串——模板串里 ${...} 的代码保留）；注释/字符串里残留的旧名不算错；
 * ④ 隐藏用例 oracles/multi-file-rename/rename-check.mjs 复制进副本后跑：新名在各模块到位、
 *    旧名在任何导出（含默认导出对象的键）里消失、行为与原件一致。
 * 可观测项（只进 detail，不作通过条件）：是否用了 multi_edit、edit/bash 次数、
 * 是否用 sed/perl 批量替换、字符串干扰项是否被顺手改掉。
 */

import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assertFrozen, copyDir, fileSetDiff, listFiles, runOracle, toolCalls } from '../lib/guards.js'

const OLD = 'normalizeEntry'
const NEW = 'toLedgerEntry'
const ORACLE_BASENAME = '.eval-rename-check.mjs'

/**
 * 把 JS 源码里的注释与字符串字面量内容替换成空格（保留换行，行号不变），
 * 让后面的 \b标识符\b 正则只看见代码。模板串里 ${...} 内的代码保留（支持嵌套）。
 * 刻意不处理正则字面量——夹具里没有含引号的正则，判分扫描器没必要变成解析器。
 */
function blankCommentsAndStrings(src) {
  const n = src.length
  let out = ''
  const blank = (s) => s.replace(/[^\n]/g, ' ')

  // 扫描代码段；untilBrace=true 时遇到配平的 `}` 停下（给模板串 ${...} 用），返回停下的位置
  const scanCode = (start, untilBrace) => {
    let i = start
    let depth = 0
    while (i < n) {
      const c = src[i]
      const d = src[i + 1]
      if (c === '/' && d === '/') {
        let j = src.indexOf('\n', i); if (j < 0) j = n
        out += blank(src.slice(i, j)); i = j; continue
      }
      if (c === '/' && d === '*') {
        let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2
        out += blank(src.slice(i, j)); i = j; continue
      }
      if (c === '\'' || c === '"') {
        let j = i + 1
        while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++ }
        j = Math.min(j + 1, n)
        out += c + blank(src.slice(i + 1, j - 1)) + (src[j - 1] === c ? c : '')
        i = j; continue
      }
      if (c === '`') { i = scanTemplate(i); continue }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') { if (depth === 0) return i; depth-- }
      }
      out += c; i++
    }
    return i
  }

  // 从反引号开始扫描模板串，返回收尾反引号之后的位置
  const scanTemplate = (start) => {
    let i = start + 1
    out += '`'
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += '  '; i += 2; continue }
      if (c === '`') { out += '`'; return i + 1 }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'
        const end = scanCode(i + 2, true)
        if (end >= n) return n
        out += '}'; i = end + 1; continue
      }
      out += c === '\n' ? '\n' : ' '
      i++
    }
    return i
  }

  scanCode(0, false)
  return out
}

/** 在 dir 下的 src/*.js 里找旧名标识符，返回 ["src/x.js:12", ...] */
function findOldIdentifier(dir) {
  const hits = []
  const re = new RegExp(`\\b${OLD}\\b`)
  for (const rel of listFiles(join(dir, 'src'))) {
    if (!/\.(?:m?js|cjs)$/.test(rel)) continue
    const stripped = blankCommentsAndStrings(readFileSync(join(dir, 'src', rel), 'utf8'))
    stripped.split('\n').forEach((line, idx) => { if (re.test(line)) hits.push(`src/${rel}:${idx + 1}`) })
  }
  return hits
}

/** 会话取证：用了哪些工具、怎么改的——只进 detail */
function describeProcess(sessionFile) {
  if (!sessionFile) return '会话文件缺失，无法取证'
  const calls = toolCalls(sessionFile)
  const count = (name) => calls.filter(c => c.name === name).length
  const bashCmds = calls.filter(c => c.name === 'bash').map(c => String(c.args?.command ?? ''))
  const bulkReplace = bashCmds.some(cmd => /\b(?:sed|perl)\b[^\n]*\b-[a-zA-Z]*[iI]\b/.test(cmd) || /\bsed\b[^\n]*\bs[/|#]/.test(cmd))
  return `multi_edit×${count('multi_edit')} edit×${count('edit')} write×${count('write')} bash×${count('bash')}`
    + `${bulkReplace ? '（bash 里用了 sed/perl 批量替换）' : ''}，工具调用共 ${calls.length} 次`
}

export default {
  id: 'multi-file-rename',
  description: `跨 5 个源文件把函数 ${OLD} 重命名为 ${NEW}（11 处定义/引用，另有注释与字符串里的同名干扰项）`,
  judge: '隐藏用例复制进副本复跑 + src/ 剥注释字符串后无旧名标识符 + src/ 文件集合不变 + test.js 与原件一致；multi_edit 使用情况只记入 detail',
  task: `这个小账本库里的函数 ${OLD}（定义在 src/entry.js）名字起得不好，请把它重命名为 ${NEW}。`
    + '所有定义与引用都要改，包括各文件里的 import、export 和调用处，改完不能有遗漏。'
    + '不要改 test.js（判分会校验它与原件一致）。改完跑一下 npm test 确认没弄坏，最后简要说明改了哪些文件。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, 'eval', 'fixtures', 'multi-file-rename'), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut, sessionFile }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const originDir = join(repoRoot, 'eval', 'fixtures', 'multi-file-rename')
    const oracleSrc = join(repoRoot, 'eval', 'oracles', 'multi-file-rename', 'rename-check.mjs')
    const process_ = describeProcess(sessionFile)

    // ① 测试文件冻结
    const frozen = assertFrozen(cwd, originDir, ['test.js'])
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}；${process_}` }
    }

    // ② 源文件集合不变
    const diff = fileSetDiff(join(originDir, 'src'), join(cwd, 'src'))
    if (!diff.same) {
      return { pass: false, detail: `src/ 文件集合变了：新增 [${diff.added.join(', ')}] 删除 [${diff.removed.join(', ')}]；${process_}` }
    }

    // ③ 代码里不得残留旧名标识符（注释/字符串里的不算）
    const leftovers = findOldIdentifier(cwd)
    if (leftovers.length > 0) {
      return { pass: false, detail: `src/ 代码里仍有旧名 ${OLD}：${leftovers.join('、')}；${process_}` }
    }

    // ④ 隐藏用例：新名到位、旧名从导出消失、行为不变
    const oracleDst = join(cwd, ORACLE_BASENAME)
    copyFileSync(oracleSrc, oracleDst)
    let rerun
    try {
      rerun = runOracle(process.execPath, [ORACLE_BASENAME], { cwd, timeoutMs: 30_000 })
    } finally {
      rmSync(oracleDst, { force: true })
    }
    if (rerun.timedOut) return { pass: false, detail: `隐藏用例超时；${process_}` }
    if (rerun.error) throw new Error(`隐藏用例起不来：${rerun.error}`)
    const failLines = rerun.stdout.split('\n').filter(l => l.startsWith('FAIL'))
    const totalLine = /共 (\d+) 项/.exec(rerun.stdout)?.[1] ?? '?'
    if (rerun.status !== 0) {
      const why = failLines.length > 0 ? failLines.slice(0, 4).join('；') : (rerun.stderr.split('\n').find(l => l.trim() !== '') ?? '无 FAIL 行')
      return { pass: false, detail: `隐藏用例失败（退出码 ${rerun.status}）：${why}；${process_}` }
    }

    // 可观测项：字符串干扰项有没有被顺手改掉（不计分，只记录）
    const validateSrc = readFileSync(join(cwd, 'src', 'validate.js'), 'utf8')
    const decoy = validateSrc.includes(`${OLD} rejected #`) ? '字符串干扰项保留' : '字符串干扰项被改动'

    return {
      pass: true,
      detail: `隐藏用例 ${totalLine} 项全过；src/ 无旧名标识符；${decoy}；${process_}；agent 退出码 ${exitCode}`,
    }
  },
}
