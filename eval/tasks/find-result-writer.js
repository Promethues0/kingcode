/**
 * 代码检索类任务：问仓库一个确切事实——runner 里写 KINGCODE_RESULT_FILE
 * 机读结果的函数名（plugins/runner.js 的 writeResultFile）。
 *
 * 判分（零 LLM）：stdout 正则匹配标准答案 + 退出码 0（完成且有回答）。
 * 答案是仓库私有命名，不猜不出来，只能真去读代码——正则的区分度靠这一点。
 *
 * 防作弊（会话取证 + 仓库取证）：cwd 是仓库根且不做副本，标准答案字面量同时躺在
 * eval/README.md、eval/tasks/<id>.js、eval/baseline.json 里，`grep -r writeResultFile eval/`
 * 一下就命中。所以：
 * ① 任何工具调用的参数里出现 eval/ 或 eval\（路径形式）即 FAIL——检索题只该读 plugins/；
 * ② agent 不该改仓库：prepare 时快照 `git status --porcelain -uall`，grade 时再取一次，
 *    有任何差异即 FAIL。用「快照差分」而不是「非空即 FAIL」，因为开发者的工作树平时就
 *    可能带着未提交改动，那不是 agent 干的。
 *    KINGCODE_EVAL_SKIP_CLEAN_CHECK=1 可临时关掉 ②：多个 agent 并行改 eval/ 下文件时
 *    （比如同时修补多道题再真跑验证），快照前后必然不一致，那是环境噪声不是作弊。
 *    日常跑 eval 别设。
 */

import { runOracle, toolCalls } from '../lib/guards.js'

/** 路径形式的 eval/ 或 eval\；前一个字符不能是标识符字符或 `-`，免得误伤 retrieval/、kingcode-eval/ 这类 */
const EVAL_PATH = /(^|[^A-Za-z0-9_-])eval[\\/]/

/** 工具调用参数里触及 eval/ 的调用（rawArguments 与解析后的 args 都查，\u 转义绕不过） */
function evalTouchingCalls(sessionFile) {
  return toolCalls(sessionFile).filter(c => EVAL_PATH.test(c.rawArguments) || EVAL_PATH.test(JSON.stringify(c.args)))
}

/** 仓库工作树快照：`git status --porcelain -uall`（-uall 让未跟踪目录里新增的单个文件也现形）。git 起不来 = harness 的病，抛。 */
function gitStatusSnapshot(cwd) {
  const r = runOracle('git', ['status', '--porcelain', '-uall'], { cwd, timeoutMs: 30_000 })
  if (r.timedOut) throw new Error('git status 超时')
  if (r.error) throw new Error(`git status 起不来：${r.error}`)
  if (r.status !== 0) throw new Error(`git status 退出码 ${r.status}：${r.stderr.slice(0, 400)}`)
  return r.stdout
}

/** 两份快照的行差异，用于 detail */
function snapshotDiff(before, after) {
  const a = new Set(before.split('\n').filter(Boolean))
  const b = new Set(after.split('\n').filter(Boolean))
  return { added: [...b].filter(l => !a.has(l)), removed: [...a].filter(l => !b.has(l)) }
}

export default {
  id: 'find-result-writer',
  description: '检索 plugins/runner.js：写机读结果文件的函数叫什么名字',
  judge: 'stdout 正则匹配 \\bwriteResultFile\\b 且退出码为 0；工具调用参数触及 eval/ 或改动仓库工作树即 FAIL',
  task: '在本仓库的 plugins/runner.js 中，进程退出前把机读结果写入 KINGCODE_RESULT_FILE '
    + '指定路径的那个函数叫什么名字？回答必须包含确切的函数名。',

  async prepare({ repoRoot }) {
    // 检索类：直接在仓库根跑，不写文件。快照工作树，grade 时比对
    const gitBefore = process.env.KINGCODE_EVAL_SKIP_CLEAN_CHECK === '1' ? null : gitStatusSnapshot(repoRoot)
    return { cwd: repoRoot, gitBefore }
  },

  async grade({ cwd, stdout, exitCode, timedOut, sessionFile, prepared }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }

    // ① 会话取证：答案字面量躺在 eval/ 下，工具调用碰到它就是作弊（没会话文件时跳过）
    if (sessionFile !== null) {
      const peeked = evalTouchingCalls(sessionFile)
      if (peeked.length > 0) {
        const c = peeked[0]
        return {
          pass: false,
          detail: `工具调用触及 eval/（共 ${peeked.length} 次；首次 seq=${c.seq} turn=${c.turn} step=${c.step} ${c.name}：${c.rawArguments.slice(0, 160)}）`,
        }
      }
    }

    // ② 仓库取证：工作树不许被 agent 改动（见文件头注释，KINGCODE_EVAL_SKIP_CLEAN_CHECK=1 关掉）
    if (process.env.KINGCODE_EVAL_SKIP_CLEAN_CHECK !== '1' && typeof prepared?.gitBefore === 'string') {
      const diff = snapshotDiff(prepared.gitBefore, gitStatusSnapshot(cwd))
      if (diff.added.length > 0 || diff.removed.length > 0) {
        return {
          pass: false,
          detail: `仓库工作树被改动（git status 前后不一致）：新增 ${JSON.stringify(diff.added.slice(0, 5))} 消失 ${JSON.stringify(diff.removed.slice(0, 5))}`,
        }
      }
    }

    const named = /\bwriteResultFile\b/.test(stdout)
    const pass = named && exitCode === 0
    return {
      pass,
      detail: pass
        ? '答案含 writeResultFile 且退出码 0；未触及 eval/，工作树未变'
        : `named=${named} exitCode=${exitCode}（期望含 writeResultFile 且退出码 0）`,
    }
  },
}
