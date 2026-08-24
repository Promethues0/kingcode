/**
 * stderr 进度流的无头测试：纯渲染，不起 agent、不调模型。
 *
 * 守护的是三条硬约束（见 plugins/progress.js 头注释）：只写传入的那一个 sink、
 * 不含 ANSI、每行带秒数且不超过一屏宽度；外加 KINGCODE_QUIET 的「一个字节都不写」。
 *
 * 跑法：node test/test-progress.js（失败退出码 1）
 */

import { clip, shortPath, summarizeToolArgs, createProgress, LINE_WIDTH, ARG_WIDTH } from '../plugins/progress.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

// ---- clip：压成单行 + 截断 ----

eq(clip('abc', 10), 'abc', 'clip 不动短文本')
eq(clip('a\nb\tc  d', 20), 'a b c d', 'clip 把换行/制表/连续空白压成单个空格')
eq(clip('0123456789', 5), '0123…', 'clip 截断并补省略号（总长不超过 max）')
eq(clip('0123456789', 5).length, 5, 'clip 截断后的长度恰好是 max')

// ---- shortPath：绝对路径压短 ----

eq(shortPath('/repo/plugins/runner.js', '/repo'), 'plugins/runner.js', 'cwd 之下的绝对路径变相对')
eq(shortPath('/etc/hosts', '/repo'), 'hosts', 'cwd 之外的绝对路径只留文件名（不泄露一长串上级目录）')
eq(shortPath('plugins/runner.js', '/repo'), 'plugins/runner.js', '相对路径原样保留')
eq(shortPath(undefined, '/repo'), '', '缺参数不抛，给空串')

// ---- summarizeToolArgs：每个工具打自己的关键参数 ----

const CWD = '/repo'
eq(summarizeToolArgs('bash', '{"command":"ls -la","description":"list"}', CWD), 'ls -la', 'bash 打命令')
eq(summarizeToolArgs('read', '{"file_path":"/repo/plugins/runner.js","offset":1}', CWD),
  'plugins/runner.js', 'read 打文件名')
eq(summarizeToolArgs('edit', '{"file_path":"/repo/a.js","old_string":"x","new_string":"y"}', CWD),
  'a.js', 'edit 打文件名（不打替换内容）')
eq(summarizeToolArgs('grep', '{"pattern":"summarize","path":"/repo/plugins"}', CWD),
  '/summarize/ in plugins', 'grep 打模式与范围')
eq(summarizeToolArgs('glob', '{"pattern":"**/*.js"}', CWD), '**/*.js', 'glob 打模式')
eq(summarizeToolArgs('lsp', '{"operation":"findReferences","file_path":"/repo/plugins/runner.js","line":45,"character":17}', CWD),
  'findReferences plugins/runner.js:45:17', 'lsp 打操作与位置')
eq(summarizeToolArgs('multi_edit', '{"edits":[{"file_path":"/repo/a.js"},{"file_path":"/repo/a.js"},{"file_path":"/repo/b.js"}]}', CWD),
  '3 处改动 a.js b.js', 'multi_edit 打改动数与去重后的文件')
eq(summarizeToolArgs('todo_write', '{"todos":[{"content":"x","status":"pending"},{"content":"y","status":"pending"}]}', CWD),
  '2 条待办', 'todo_write 打条数')
eq(summarizeToolArgs('subagent', '{"description":"查 runner 引用","prompt":"很长很长的提示词……"}', CWD),
  '查 runner 引用', 'subagent 打 description（不打整段 prompt）')
eq(summarizeToolArgs('mcp__echo__add', '{"a":17,"b":25}', CWD), '', '未知工具且无字符串字段 → 空摘要（不报错）')
eq(summarizeToolArgs('mcp__x__y', '{"note":"hello"}', CWD), 'note=hello', '未知工具取第一个字符串字段')

{
  // 模型产出的 arguments 可能不是合法 JSON（截断/乱写），渲染绝不能抛
  const out = summarizeToolArgs('bash', '{"command":"ls -l', CWD)
  check(typeof out === 'string' && out.includes('ls -l'), 'arguments 非法 JSON 时退回原串截断而不抛', out)
}

{
  // 参数可能有几 KB，务必截断到 ARG_WIDTH
  const long = 'x'.repeat(5000)
  const out = summarizeToolArgs('bash', JSON.stringify({ command: long }), CWD)
  eq(out.length, ARG_WIDTH, `bash 超长命令截到 ARG_WIDTH=${ARG_WIDTH}`)
}

// ---- createProgress：只写传入的 sink、带秒数、限宽、无 ANSI ----

/** 造一个可捕获的 sink 与一个可控时钟。 */
function harness({ quiet = false } = {}) {
  const chunks = []
  let clock = 1_000_000
  const progress = createProgress({
    write: c => chunks.push(c),
    now: () => clock,
    quiet,
    cwd: CWD,
  })
  return {
    progress,
    advance: ms => { clock += ms },
    lines: () => chunks.join('').split('\n').filter(l => l !== ''),
    text: () => chunks.join(''),
  }
}

{
  const h = harness()
  h.advance(12_345)
  h.progress.note('启动')
  const [line] = h.lines()
  check(/^\[\s+12\.3s\] 启动$/.test(line), '每行带相对起始的秒数（[  12.3s]）', JSON.stringify(line))
}

{
  const h = harness()
  h.progress.event({ type: 'turn/start', data: { turn: 1 } })
  h.advance(500)
  h.progress.event({ type: 'step/start', data: { turn: 1, step: 1 } })
  h.progress.event({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } })
  h.advance(3_200)
  h.progress.event({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ isError: false }] } } })
  h.progress.event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const lines = h.lines()
  eq(lines.length, 5, '五个事件渲染五行')
  check(lines[0].includes('轮 1 开始'), '轮次边界：turn/start 有行', lines[0])
  check(lines[1].includes('步 1.1'), '步边界带 轮.步 编号', lines[1])
  check(lines[2].includes('bash') && lines[2].includes('npm test'), '工具调用打工具名 + 命令摘要', lines[2])
  check(lines[3].includes('3.2s'), 'tool/result 打这次调用真花了多久（配对 callId）', lines[3])
  check(lines[4].includes('轮 1 结束') && lines[4].includes('completed'), 'turn/end 带收敛原因', lines[4])
  // 层级靠缩进表达：轮/步顶格，工具与其结果缩进——clip 会 trim 掉前导空白，
  // 所以缩进必须在 clip 之外单独留出来，否则整个流会被压成一堵平墙
  check(/^\[\s+\d+\.\ds\] {3}\S/.test(lines[2]), '工具行相对轮/步行有缩进', JSON.stringify(lines[2]))
  check(/^\[\s+\d+\.\ds\] {3}└/.test(lines[3]), '工具结果行接在工具行下面（缩进 + └）', JSON.stringify(lines[3]))
  check(/^\[\s+\d+\.\ds\] ─ 轮/.test(lines[0]), '轮次行顶格，不缩进', JSON.stringify(lines[0]))
}

{
  // 重试退避——「静默 15 分钟」的主因之一，必须现形
  const h = harness()
  h.progress.event({ type: 'llm/retry', data: {
    retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'p',
    retry: 2, maxRetries: 5, delayMs: 8_000, failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 },
  } })
  h.advance(8_100)
  h.progress.event({ type: 'llm/retry-started', data: { retryId: 'r1', turn: 1, step: 1, retry: 2 } })
  const lines = h.lines()
  check(lines[0].includes('重试 2/5') && lines[0].includes('8.0s') && lines[0].includes('RATE_LIMIT'),
    'llm/retry 打第几次/共几次、退避多久、失败码', lines[0])
  check(lines[1].includes('重试 2 开始') && lines[1].includes('8.1s'),
    'llm/retry-started 打实际等了多久（配对 retryId）', lines[1])
}

{
  // 工具失败要看得出来，否则日志里「完成」和「炸了」长一样
  const h = harness()
  h.progress.event({ type: 'tool/call', data: { callId: 'c9', name: 'read', arguments: '{"file_path":"/repo/nope.js"}' } })
  h.progress.event({ type: 'tool/result', data: { message: { source: { callId: 'c9' }, content: [{ isError: true }] }, error: { name: 'FsError', code: 'ENOENT' } } })
  const lines = h.lines()
  check(lines[1].includes('失败') && lines[1].includes('ENOENT'), '工具失败打「失败」与错误码', lines[1])
}

{
  // 子代理有自己的会话；全量渲染会淹掉主线
  const h = harness()
  h.progress.event({ type: 'step/start', data: { turn: 1, step: 1 } }, { main: false })
  h.progress.event({ type: 'tool/call', data: { callId: 's1', name: 'grep', arguments: '{"pattern":"foo"}' } }, { main: false })
  h.progress.event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { main: false })
  const lines = h.lines()
  eq(lines.length, 2, '子代理会话只渲染工具与轮次收尾（step 不渲染）')
  check(lines.every(l => l.includes('子代理')), '子代理的行有明确标记，不与主线混淆', lines.join(' | '))
}

{
  // 一行不超过一屏宽度；ANSI 会在被重定向进日志时变成乱码
  const h = harness()
  h.progress.event({ type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: JSON.stringify({ command: 'y'.repeat(4000) }) } })
  h.progress.note('n'.repeat(4000))
  for (const line of h.lines()) {
    check(line.length <= LINE_WIDTH, `每行不超过 LINE_WIDTH=${LINE_WIDTH}`, `实际 ${line.length}`)
  }
  check(!/\u001b\[/.test(h.text()), '进度流不含 ANSI 转义（stderr 可能被重定向进日志）')
}

{
  // chunk 是 token 级的，一轮几百条，渲染出来会把真正的进度冲走
  const h = harness()
  h.progress.event({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text', text: 'a' } } })
  h.progress.event({ type: 'request/header', data: { header: {}, reason: 'initial' } })
  h.progress.event({ type: 'user/message', data: {} })
  eq(h.lines().length, 0, 'chunk/header/user-message 刻意不渲染')
}

{
  // KINGCODE_QUIET=1 的语义：一个字节都不写，连 note 也不写
  const h = harness({ quiet: true })
  h.progress.note('启动')
  h.progress.event({ type: 'turn/start', data: { turn: 1 } })
  h.progress.event({ type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } })
  h.progress.event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  eq(h.text(), '', 'quiet 时进度流一个字节都不写')
}

{
  // 事件形状与文档不符（上游改了、或子代理送来半截）时不能反过来打断任务
  const h = harness()
  let threw = false
  try {
    h.progress.event({ type: 'tool/result', data: {} })
    h.progress.event({ type: 'assistant/message', data: {} })
    h.progress.event({ type: 'turn/end', data: {} })
    h.progress.event({})
  } catch { threw = true }
  check(!threw, '残缺事件不抛（渲染进度不该有能力打断任务）')
}

// ── 控制字符：工具参数与助手文本都是模型可控的 ──────────────────────────────
// 之前这里只喂干净夹具，给的是假的安全感：真跑时模型可以让 stderr 收到 ESC
{
  const esc = '\u001b[31mRED\u001b[0m'
  const clipped = clip(esc, 80)
  check(!clipped.includes('\u001b'), 'clip 剥掉 ESC（否则 stderr 里会出现真的颜色/清屏序列）', JSON.stringify(clipped))
  for (const [name, ch] of [['BEL', '\u0007'], ['BS', '\u0008'], ['NUL', '\u0000'], ['DEL', '\u007f'], ['VT', '\u000b']]) {
    check(!clip(`a${ch}b`, 80).includes(ch), `clip 剥掉 ${name}`)
  }
  check(clip('a\tb\nc', 80) === 'a b c', 'clip 仍把 \\t\\n 正常压成空格（它们不是要剥的东西）')
  check(clip('中文 ok', 80) === '中文 ok', 'clip 不动正常可打印字符（含 CJK）')
}

// ── 并发工具调用：完成行必须带工具名 ────────────────────────────────────────
// 一次 13 个 read 是常见的，收尾行会乱序回来；全是「└ 完成」时「卡在哪一步」
// 这个卖点就退化了
{
  const lines = []
  const p = createProgress({ write: c => lines.push(c), quiet: false, cwd: process.cwd() })
  const call = (id, name, args) => p.event({ type: 'tool/call', data: { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) } }, { main: true })
  const done = id => p.event({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: id } }, content: [] } }, { main: true })
  call('a', 'read', { file_path: 'x.js' })
  call('b', 'grep', { pattern: 'foo' })
  done('b') // 乱序回来：先完成的是后发的那个
  done('a')
  const text = lines.join('')
  check(/└ grep 完成/.test(text), '完成行带上工具名（grep）', text.split('\n').filter(l => l.includes('└')).join(' / '))
  check(/└ read 完成/.test(text), '完成行带上工具名（read）')
  check(!/└ 完成/.test(text), '不再有匿名的「└ 完成」')
  // callId 认不出来时（残缺事件）也不能抛，只是没有名字
  const before = lines.length
  p.event({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'ghost' } } } }, { main: true })
  check(lines.length > before, '未配对的 tool/result 仍出一行，不抛错')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
