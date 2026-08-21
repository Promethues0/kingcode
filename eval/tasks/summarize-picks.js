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
 */

const VALID = ['first', 'last', 'last_nonempty', 'concatenated']

export default {
  id: 'summarize-picks',
  description: '检索 runner.summarize：一轮多条助手消息时取哪一条当最终回答',
  judge: 'stdout 正则匹配 PICKS=last_nonempty 且无其他 PICKS 值',
  task: '在本仓库的 plugins/runner.js 里，summarize 函数在同一轮出现多条 assistant/message 时，'
    + '把哪一条当作最终回答？最终回答的最后一行只写：PICKS=<first|last|last_nonempty|concatenated>，'
    + '其中 last_nonempty 表示「取最后一条非空文本的消息，空文本不覆盖已有结果」。',

  async prepare({ repoRoot }) {
    return { cwd: repoRoot }
  },

  async grade({ stdout, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const answers = [...stdout.matchAll(/PICKS\s*=\s*([a-z_]+)/g)].map(m => m[1])
    const known = answers.filter(a => VALID.includes(a))
    const pass = exitCode === 0 && known.length > 0 && known.every(a => a === 'last_nonempty')
    return {
      pass,
      detail: pass
        ? 'PICKS=last_nonempty 且无杂音'
        : `PICKS 提取值=${JSON.stringify(answers)} exitCode=${exitCode}（期望恰好回答 last_nonempty 且退出码 0）`,
    }
  },
}
