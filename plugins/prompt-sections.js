/**
 * KingCode 的系统提示词补充段 —— 工作纪律不写进 persona，写在这里。
 *
 * 两个原因：
 * ① `deployment:persona` 这个 section 名被 agent-spine 的 config 占死（重名注册
 *    会抛），身份句只能留在 YAML；而 persona 有三份副本（cordis.yml、
 *    eval/cordis.eval.yml、profile/cordis.patch.yml），纪律堆在那儿必然漂移。
 * ② section 有 order，能插在上游工具指导段（100-105）之后仲裁它们——persona
 *    在 order 0，永远排在工具段前面，说不了「这些工具之间怎么选」。
 *
 * Loader 插件必须具名导出（default export 会静默丢 inject）。
 */

export const name = 'kingcode-prompt-sections'

export const inject = ['systemPrompt']

/**
 * 一次性会话契约（order 1，紧跟 persona）。
 *
 * 这段挡的是一个真实的静默失败：runner 取本轮最后一条非空助手文本当 stdout，
 * 所以模型以「你想改哪个文件？」收尾时，reason 是 completed、文本非空 ——
 * 退出码 0，CI 认为成功，而任务其实一件没做。树里没有 ask-user 工具，
 * 提问就是死路，必须在提示词层面堵掉。
 */
export const SESSION_CONTRACT = `This session is one-shot and non-interactive. There is no channel to ask the user anything and no second turn: never end your turn with a clarifying question. When a requirement is ambiguous, choose the most reasonable interpretation, state that assumption in one line, and complete the task.

Your final assistant message is the entire deliverable — it is the only thing printed to stdout, and everything else (tool calls, intermediate notes) is discarded. Always finish with one self-contained message that names the files you changed, the exact command you ran to verify, and what that command reported. Never end a turn with tool calls and no closing text.`

/**
 * 工作纪律（order 5）。三条都必须是可检验的——「要仔细」这类话不写。
 */
export const DISCIPLINE = `Verification means you ran something and read the output. Re-reading your own diff is not verification. Run the project's tests or the specific command that exercises your change; if you could not verify, say so plainly in the final message instead of implying success.

Read a file before you edit it, and look for an existing call site before using a project API — match the conventions already in the codebase rather than importing habits from elsewhere.

Do exactly what was asked. Do not add unrequested README files, comments, error handling, abstractions, or refactors; a change that is larger than the request is harder to review and more likely to break something.`

/**
 * 工具取舍（order 199）—— 必须排在上游 100-105 的各工具指导段之后，
 * 才谈得上仲裁「这几个工具之间怎么选」。
 */
export const TOOL_ROUTING = `Choosing among the tools above:

- Use grep and glob to find code. They are faster than shell equivalents, and they avoid the quoting and escaping mistakes that bash -c invites. Reach for bash for running things, not for searching.
- Use todo_write only when the task genuinely has three or more distinct steps worth tracking. For a single edit or a lookup it is pure overhead.
- Delegate only self-contained investigations whose conclusion is all you need back; delegates cannot nest and return text, not edits — make the edits yourself. Use explore (read-only: read/glob/grep only) when the investigation must not touch the tree; use subagent when the child needs bash or the web.
- When an answer depends on facts that may have changed since your training — current API signatures, package versions, release notes — verify with web_fetch or web_search instead of answering from memory. For code in this repository, read the code; the web tools are for the world outside it.
- Shell commands time out after 120s by default (cap 600s). Pass timeoutMs explicitly for builds, installs, or test suites that legitimately run longer.`

/**
 * 注册三段。order 见各常量注释；1/5/199 都在空闲频段
 * （上游占用：-100 identity、0 persona、100-105 各工具、116.5 subagent）。
 * @param ctx - 插件上下文（需 systemPrompt 服务）。
 */
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'kingcode:session-contract', order: 1, text: SESSION_CONTRACT })
  ctx.systemPrompt.section({ name: 'kingcode:discipline', order: 5, text: DISCIPLINE })
  ctx.systemPrompt.section({ name: 'kingcode:tool-routing', order: 199, text: TOOL_ROUTING })
}
