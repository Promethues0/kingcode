/**
 * 破坏性命令闸门 —— 拦下「做完就回不去」的那几条 shell 命令。
 *
 * ## 为什么要自己写
 *
 * 这棵树对 bash 原本只有一条约束：60 秒超时。而 KingCode 的常态是**无人值守**
 * 跑任务与 eval，出事时没有人在旁边按 Ctrl-C——`git reset --hard` 执行完，用户
 * 还没提交的改动就没了，退出码却是 0。
 *
 * 生态里有三个现成插件干这件事（dsh-barricade / worktree-mgr / dsh-permission-rules），
 * 都实测过，**在本仓库这棵 headless 树上都跑不起来**：
 *   - dsh-barricade   ：读了 ctx.approval 却没声明 inject，挂载期直接 fail loud
 *   - worktree-mgr    ：注册的 wtm_begin 工具 schema 是 `type: null`，
 *                       整个工具目录被污染，**每一次模型请求**都 INVALID_REQUEST
 *   - dsh-permission-rules：能挂上，但每轮在首次模型请求之前就把会话 abort 掉
 * 三个都需要 web/TUI 那半边的服务（approval / commands），headless 树没有。
 * 结论是这类闸门得自己写——反正规则集才是全部内容，代码没多少。
 *
 * ## 这不是沙箱，是护栏
 *
 * 判定就是拿命令原文过一遍正则，**不做 shell 解析**。一个存心要绕的模型能绕开
 * （变量拼接、别名、base64 解码再执行），这一点必须说清楚，不要让人以为装了它
 * 就可以放心 `danger-full-access`。它防的是**手滑**：模型在修不好测试时顺手来一下
 * 「重置一下再说」，而那一下删掉的是用户的东西。防手滑用正则就够了。
 *
 * ## 为什么是 deny 而不是 ask
 *
 * headless 下没有人在旁边答确认，ask 等于挂死。命中就让这次工具调用失败，把原因
 * 交回给模型——它看得懂，会换个做法继续，整轮任务不受影响。
 *
 * 关掉：`KINGCODE_GUARD=0`（与 KINGCODE_LSP 同一套逃生口径）。
 */

export const name = 'kingcode-command-guard'
export const inject = ['tools']

/** 会执行 shell 命令的工具名。tool-bash 注册的是 `bash`，Windows 侧是 `pwsh`。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell'])

/**
 * 规则集。**刻意只收不可逆的**——一份动不动就挡路的策略最后一定会被整个关掉，
 * 那就等于没有。每条都要能回答「这条命令做完，用户能不能自己恢复」。
 *
 * @type {Array<{ id: string, test: RegExp, reason: string }>}
 */
const RULES = [
  {
    id: 'rm-root',
    // 删根：`rm -rf /`、`rm -rf ~`、`rm -rf $HOME`。任何正当任务都不需要这么做。
    test: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+(\/(\s|$|\*)|~|\$HOME|"\$HOME"|'\$HOME')/,
    reason: '删根级 rm 被拦下。要清理请给出工作区内的具体相对路径；不确定删了什么就先 ls 一遍。',
  },
  {
    id: 'git-hard-reset',
    // 丢弃未提交改动的三大来源。模型「重置一下再说」时，重置掉的可能是用户的活。
    test: /\bgit\s+(reset\s+--hard|checkout\s+--\s+\.|restore\s+(--staged\s+--worktree|--worktree\s+--staged))/,
    reason: 'git 硬重置会丢掉未提交的改动。要回退请只针对你自己改过的那几个文件，或先 git stash 留个后路。',
  },
  {
    id: 'git-clean',
    // git clean 删的是未跟踪文件：.env、本地脚本、spill 落盘全在里面。
    test: /\bgit\s+clean\s+(-[a-zA-Z]*f|--force)/,
    reason: 'git clean 会删掉未跟踪文件（.env、本地脚本、.kingcode/spill 都算）。先 git clean -n 看清单，再逐个删。',
  },
  {
    id: 'git-force-push',
    // 改写远端历史，影响的是别人。
    test: /\bgit\s+push\b[^\n]*(--force(?!-with-lease)|\s-f\b)/,
    reason: '强推会改写远端历史，影响的是别人。普通 push 即可；确实要强推，交给人来做。',
  },
  {
    id: 'curl-pipe-shell',
    // 把远端此刻返回的内容直接交给 shell 执行——无人值守时等于把控制权交出去。
    test: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
    reason: '不允许把下载内容直接管道给 shell。先把脚本存成文件、读一遍，再决定要不要执行。',
  },
  {
    id: 'history-rewrite',
    // filter-branch / filter-repo 会重写整个仓库历史，且没有 undo。
    test: /\bgit\s+(filter-branch|filter-repo)\b/,
    reason: '重写整个仓库历史没有 undo。这类操作请由人来做，并且先备份。',
  },
]

/**
 * 从工具入参里取出命令原文。
 * 不同 shell 工具的参数名不一样（command / cmd / script），取到哪个算哪个。
 */
function commandOf(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args[key] === 'string') return args[key]
  }
  return null
}

/** 把带引号的片段挖空。`echo "git reset --hard 很危险"` 里那句是**文本**不是命令。 */
function stripQuoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
}

/** 命令里有没有「把字符串当命令执行」的入口。有的话引号里的东西也算命令。 */
const SHELL_INVOKER = /\b(ba|z|k)?sh\s+-c\b|\beval\s|\bxargs\b/

/**
 * 判定一条命令。命中返回规则，否则 null。
 *
 * **先挖掉引号里的内容再判**，否则 `echo "git reset --hard 很危险" >> NOTES.md`
 * 和 `grep -rn "rm -rf" docs/` 都会被拦——这类误拦最伤：模型只是在写文档或搜代码，
 * 却被闸门挡住，几次之后人就会把整个闸门关掉。
 *
 * 例外是 `bash -c "..."` / `eval` / `xargs` 这类**把字符串当命令执行**的入口：
 * 那里引号里的就是真命令，所以原文也要过一遍。
 *
 * @param {string} command
 */
export function judge(command) {
  const stripped = stripQuoted(command)
  const alsoRaw = SHELL_INVOKER.test(stripped) || SHELL_INVOKER.test(command)
  for (const rule of RULES) {
    if (rule.test.test(stripped)) return rule
    if (alsoRaw && rule.test.test(command)) return rule
  }
  return null
}

/**
 * @param {object} ctx - dsh 插件上下文。
 * @param {object} [config]
 * @param {string[]} [config.disable] - 要关掉的规则 id（逐条豁免，别整个关）。
 */
export function apply(ctx, config = {}) {
  if (process.env['KINGCODE_GUARD'] === '0') return

  const disabled = new Set(config.disable ?? [])

  ctx.on('tools/execute', async (exec, next) => {
    if (!SHELL_TOOLS.has(exec.name)) return next()
    const command = commandOf(exec.arguments)
    if (command === null) return next()

    const rule = judge(command)
    if (rule === null || disabled.has(rule.id)) return next()

    // 返回规范形态的错误结果（而不是抛异常）：registry 会按 value/content
    // 重新投影给模型，原因就是模型看到的那句话。
    const text = `已被 KingCode 命令闸门拦下（规则 ${rule.id}）：${rule.reason}`
    ctx.logger?.warn?.(`command-guard 拦下 ${rule.id}: ${command.slice(0, 120)}`)
    return {
      isError: true,
      error: { message: text },
      content: [{ type: 'text', text }],
    }
  })
}
