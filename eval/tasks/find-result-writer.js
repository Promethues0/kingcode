/**
 * 代码检索类任务：问仓库一个确切事实——runner 里写 KINGCODE_RESULT_FILE
 * 机读结果的函数名（plugins/runner.js 的 writeResultFile）。
 *
 * 判分（零 LLM）：stdout 正则匹配标准答案 + 退出码 0（完成且有回答）。
 * 答案是仓库私有命名，不猜不出来，只能真去读代码——正则的区分度靠这一点。
 */

export default {
  id: 'find-result-writer',
  description: '检索 plugins/runner.js：写机读结果文件的函数叫什么名字',
  judge: 'stdout 正则匹配 \\bwriteResultFile\\b 且退出码为 0',
  task: '在本仓库的 plugins/runner.js 中，进程退出前把机读结果写入 KINGCODE_RESULT_FILE '
    + '指定路径的那个函数叫什么名字？回答必须包含确切的函数名。',

  async prepare({ repoRoot }) {
    return { cwd: repoRoot } // 检索类：直接在仓库根跑，不写文件
  },

  async grade({ stdout, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const named = /\bwriteResultFile\b/.test(stdout)
    const pass = named && exitCode === 0
    return {
      pass,
      detail: pass
        ? '答案含 writeResultFile 且退出码 0'
        : `named=${named} exitCode=${exitCode}（期望含 writeResultFile 且退出码 0）`,
    }
  },
}
