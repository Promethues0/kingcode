/**
 * 代码检索类任务（带固定输出格式）：一轮里出现多条助手消息时，runner 的
 * summarize 把哪一条当作最终回答？标准答案「最后一条非空」，出处
 * plugins/runner.js 的 summarize —— `if (joined !== '') text = joined` 在循环里
 * 逐条覆盖，且空串不覆盖。
 *
 * 为什么问这个而不是问退出码：退出码契约写在 AGENTS.md 里，而 AGENTS.md 会被
 * dsh-agent-instructions 注入每一个 cwd 在本仓库的会话——那道题会变成「会不会
 * 读文档」，读代码的能力一点没测到。这条事实只在代码里，文档没写。
 *
 * 判分（零 LLM）：stdout 匹配 PICKS=last_nonempty 且不得同时给出别的 PICKS 值；
 * 固定格式行既考检索也考指令遵循（eval 里大量判分依赖 agent 按格式回答）。
 *
 * 防作弊（会话取证 + 仓库取证）：cwd 是仓库根且不做副本，标准答案字面量同时躺在
 * eval/README.md、eval/tasks/<id>.js、eval/baseline.json 里，`grep -r last_nonempty eval/`
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

const VALID = ['first', 'last', 'last_nonempty', 'concatenated']

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
  id: 'summarize-picks',
  description: '检索 runner.summarize：一轮多条助手消息时取哪一条当最终回答',
  judge: 'stdout 正则匹配 PICKS=last_nonempty 且无其他 PICKS 值；工具调用参数触及 eval/ 或改动仓库工作树即 FAIL',
  task: '在本仓库的 plugins/runner.js 里，summarize 函数在同一轮出现多条 assistant/message 时，'
    + '把哪一条当作最终回答？最终回答的最后一行只写：PICKS=<first|last|last_nonempty|concatenated>，'
    + '其中 last_nonempty 表示「取最后一条非空文本的消息，空文本不覆盖已有结果」。',

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

    const answers = [...stdout.matchAll(/PICKS\s*=\s*([a-z_]+)/g)].map(m => m[1])
    const known = answers.filter(a => VALID.includes(a))
    const pass = exitCode === 0 && known.length > 0 && known.every(a => a === 'last_nonempty')
    return {
      pass,
      detail: pass
        ? 'PICKS=last_nonempty 且无杂音；未触及 eval/，工作树未变'
        : `PICKS 提取值=${JSON.stringify(answers)} exitCode=${exitCode}（期望恰好回答 last_nonempty 且退出码 0）`,
    }
  },
}
