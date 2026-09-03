/**
 * runner/startup 核心链路的无头测试：不起 agent、不调模型。
 *
 * 守护的是 CLI 的卖点行为：summarize 的事件汇总、缺核心服务时响亮报错
 * （区别于上游静默挂死）、退出码契约（0=完成有输出 / 3=完成零输出 / 1=其余，
 * 外加 4=deadline / 130=SIGINT / 143=SIGTERM），以及 runner 生命周期的三件事
 * ——stderr 进度流（stdout 一个字节都不许污染）、信号优雅收尾、全局 deadline。
 *
 * 生命周期那三件事用一棵**假组合树**跑真 run()：假 agents/sessions/事件总线，
 * 不起模型也不碰磁盘。这样测的是接线（进度进的是哪个流、取消有没有被调用、
 * 结果文件长什么样），而不是渲染细节——渲染细节归 test/test-progress.js。
 *
 * 跑法：node test/test-runner.js（失败退出码 1）
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarize, exitCodeFor, internals, apply,
  parseDeadlineMs, installSignalHandlers,
  DEADLINE_EXIT_CODE, SIGNAL_EXIT_CODES, MAX_DEADLINE_MS,
} from '../plugins/runner.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

// ---- summarize ----

const assistant = (seq, text) => ({
  seq,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

{
  // 序号过滤：firstSeq 之前的事件（含上一轮的回答）不算本轮
  const events = [
    { seq: 1, type: 'turn/start' },
    assistant(2, '上一轮的回答'),
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 4, type: 'turn/start' },
    assistant(5, '本轮的回答'),
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const outcome = summarize(events, 4)
  eq(outcome.text, '本轮的回答', 'summarize 只汇总 firstSeq 之后的事件')
  eq(outcome.reason?.kind, 'completed', 'summarize 提取收敛原因')
}

{
  // 多条 assistant/message 取最后一条非空文本；多 text 块拼接
  const events = [
    { seq: 10, type: 'turn/start' },
    assistant(11, '中间思考'),
    { seq: 12, type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: '最终' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: '回答' },
    ] } } },
    { seq: 13, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const outcome = summarize(events, 10)
  eq(outcome.text, '最终回答', 'summarize 取最后一条消息并拼接全部 text 块')
}

{
  // turn/start 之前的事件不算；error reason 原样透出
  const events = [
    assistant(20, '未开轮的杂音'),
    { seq: 21, type: 'turn/start' },
    { seq: 22, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'bad key' } } } },
  ]
  const outcome = summarize(events, 20)
  eq(outcome.text, '', 'turn/start 之前的助手消息不计入')
  eq(outcome.reason?.error?.code, 'AUTH', 'error reason 带 code 透出')
}

{
  // 上游两代读接口都要能读。dsh 0.1.2-alpha.4 删掉了 `Session.events` 这个数组
  // getter，换成 seq + eventAt()/snapshotEvents()；仓库现在钉 alpha.3（还有 events），
  // 升级时不该因为这个再炸一次。两种形状喂同一批事件，结果必须一致。
  const events = [
    { seq: 1, type: 'turn/start' },
    assistant(2, '同一个回答'),
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const alpha3 = { events }                                    // 老形状：数组 getter
  const alpha4 = { get seq() { return 4 }, snapshotEvents: () => events.slice() } // 新形状
  eq(summarize(alpha3, 1).text, '同一个回答', 'summarize 读得了 alpha.3 的 session.events')
  eq(summarize(alpha4, 1).text, '同一个回答', 'summarize 读得了 alpha.4 的 session.snapshotEvents()')
  eq(summarize(alpha4, 1).reason?.kind, 'completed', '新形状同样取得到收敛原因')
  // 两个都没有时不许抛——真炸在收尾处只会把已经拿到的回答一起丢掉
  eq(summarize({}, 0).text, '', '两代接口都没有时返回空结果而不是抛异常')
}

// ---- exitCodeFor ----

eq(exitCodeFor({ text: '回答', reason: { kind: 'completed' } }), 0, '完成且有输出 → 0')
eq(exitCodeFor({ text: '', reason: { kind: 'completed' } }), 3, '完成但零输出 → 3')
eq(exitCodeFor({ text: '', reason: { kind: 'error', error: { code: 'AUTH', message: 'x' } } }), 1, '错误 → 1')
eq(exitCodeFor({ text: '有文本也不行', reason: undefined }), 1, '无收敛原因 → 1')

// ---- 缺核心服务：响亮报错 + exit 1（卖点行为，上游是静默挂死） ----

/** 造一个可捕获的写入流。 */
function captureStream() {
  const chunks = []
  return { write: chunk => { chunks.push(chunk); return true }, text: () => chunks.join('') }
}

async function checkMissingServices() {
  const stdout = captureStream()
  const stderr = captureStream()
  const savedOut = internals.stdout
  const savedErr = internals.stderr
  internals.stdout = stdout
  internals.stderr = stderr
  let exitCode
  const exited = new Promise(resolve => {
    const fakeCtx = {
      get: name => {
        if (name === 'appExit') return code => { exitCode = code; resolve() }
        return undefined // loader/agents/agentDefaultModel/sessions 全缺
      },
    }
    apply(fakeCtx, { task: '任意任务' })
  })
  await exited
  internals.stdout = savedOut
  internals.stderr = savedErr
  eq(exitCode, 1, '缺核心服务 → exit 1')
  check(stderr.text().includes('若上方有插件挂载失败'),
    '缺服务的报错指向真因（插件挂载失败才是病因，服务缺席只是后果）')
  check(stderr.text().includes('组合树缺少核心服务'), '缺核心服务时 stderr 响亮报错', stderr.text().trim())
  check(stderr.text().includes('agents') && stderr.text().includes('sessions'), '报错点名缺了哪些服务')
  eq(stdout.text(), '', '缺核心服务时 stdout 保持纯净')
}

// ---- KINGCODE_RESULT_FILE 未设时不写文件 ----

async function checkNoResultFileByDefault() {
  const dir = mkdtempSync(join(tmpdir(), 'kingcode-runner-'))
  const marker = join(dir, 'result.json')
  delete process.env['KINGCODE_RESULT_FILE']
  // 缺服务路径同样走 exit，不应产生任何结果文件
  const exited = new Promise(resolve => {
    apply({ get: name => (name === 'appExit' ? () => resolve() : undefined) }, { task: 'x' })
  })
  await exited
  check(!existsSync(marker), 'KINGCODE_RESULT_FILE 未设时无文件写入')
  rmSync(dir, { recursive: true, force: true })
}

const savedErrForNoise = internals.stderr
internals.stderr = { write: () => true } // 第二次 apply 的报错不用重复打给人看
await checkMissingServices()
await checkNoResultFileByDefault()
internals.stderr = savedErrForNoise


// ---- parseDeadlineMs：护栏宁可拒收也不静默忽略 ----

eq(parseDeadlineMs(undefined), undefined, 'KINGCODE_DEADLINE_MS 未设 → undefined（无限制）')
eq(parseDeadlineMs(''), undefined, '空串 → undefined（无限制）')
eq(parseDeadlineMs('  '), undefined, '纯空白 → undefined（无限制）')
eq(parseDeadlineMs('8000'), 8000, '正整数毫秒原样解析')
eq(parseDeadlineMs('0'), null, '0 → null（拒收）')
eq(parseDeadlineMs('-1'), null, '负数 → null（拒收）')
eq(parseDeadlineMs('1.5'), null, '小数 → null（拒收）')
eq(parseDeadlineMs('八千'), null, '非数字 → null（拒收）')
eq(parseDeadlineMs('Infinity'), null, 'Infinity → null（拒收）')
// 上界：setTimeout 超过 32 位会被 Node 钳成 1ms，于是「设 1000 天等于不限时」
// 会变成「每次调用 0.0s 就退 4」——护栏不是失灵，是反过来咬人，必须拒收
eq(parseDeadlineMs(String(MAX_DEADLINE_MS)), MAX_DEADLINE_MS, '正好 32 位上限 → 收下')
eq(parseDeadlineMs(String(MAX_DEADLINE_MS + 1)), null, '超过 32 位上限 → 拒收（否则会被钳成 1ms）')
eq(parseDeadlineMs('86400000000'), null, '「1000 天」这种想表达无限的写法 → 拒收')
// 严格十进制：Number() 会悄悄收下这些，让人以为设的是别的数
eq(parseDeadlineMs('0x10'), null, '十六进制 → 拒收')
eq(parseDeadlineMs('1e3'), null, '科学计数 → 拒收')
eq(parseDeadlineMs('+5'), null, '带正号 → 拒收')
eq(parseDeadlineMs(' 12 '), 12, '两侧空白仍按十进制收下')

// ---- 退出码常量：Unix 惯例 128 + 信号号 ----

eq(DEADLINE_EXIT_CODE, 4, 'deadline 专用退出码是 4')
eq(SIGNAL_EXIT_CODES.SIGINT, 130, 'SIGINT → 130（128+2）')
eq(SIGNAL_EXIT_CODES.SIGTERM, 143, 'SIGTERM → 143（128+15）')
check(![0, 3, 1].includes(DEADLINE_EXIT_CODE)
  && ![0, 3, 1].includes(SIGNAL_EXIT_CODES.SIGINT)
  && ![0, 3, 1].includes(SIGNAL_EXIT_CODES.SIGTERM),
  '三个新码与既有 0/3/1 不重叠（否则 CI 分不出「答完了」和「被砍了」）')

// exitCodeFor 保持纯函数：截断类结局不该从它这里出来
{
  const codes = new Set([
    exitCodeFor({ text: 'x', reason: { kind: 'completed' } }),
    exitCodeFor({ text: '', reason: { kind: 'completed' } }),
    exitCodeFor({ text: '', reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    exitCodeFor({ text: '', reason: undefined }),
  ])
  check(!codes.has(4) && !codes.has(130) && !codes.has(143),
    'exitCodeFor 永远不产出 4/130/143（截断走另一条路径，纯函数不碰进程状态）',
    [...codes].join(','))
  eq(exitCodeFor({ text: '半截回答', reason: { kind: 'aborted', reason: { kind: 'user' } } }), 1,
    '被取消的轮次（aborted）走 1，不是 0')
}

// ---- installSignalHandlers：第一次优雅，第二次同信号硬退 ----

{
  // 假 process：只要有 on/off 就够，不用真发信号
  const registered = new Map()
  const proc = {
    on: (sig, fn) => { registered.set(sig, [...(registered.get(sig) ?? []), fn]) },
    off: (sig, fn) => { registered.set(sig, (registered.get(sig) ?? []).filter(f => f !== fn)) },
  }
  const calls = []
  const off = installSignalHandlers(proc, {
    graceful: (sig, code) => calls.push(`graceful:${sig}:${code}`),
    hard: (sig, code) => calls.push(`hard:${sig}:${code}`),
  })
  eq(registered.get('SIGINT')?.length, 1, 'SIGINT 处理器装上了')
  eq(registered.get('SIGTERM')?.length, 1, 'SIGTERM 处理器装上了')

  registered.get('SIGTERM')[0]()
  registered.get('SIGTERM')[0]()
  registered.get('SIGINT')[0]()
  eq(calls.join(' | '),
    'graceful:SIGTERM:143 | hard:SIGTERM:143 | graceful:SIGINT:130',
    '首次同信号走 graceful、再次走 hard；两个信号各记各的')

  off()
  eq(registered.get('SIGINT')?.length, 0, '卸载函数摘干净 SIGINT')
  eq(registered.get('SIGTERM')?.length, 0, '卸载函数摘干净 SIGTERM')
}

// ---- 假组合树：跑真 run()，验进度流去向 / QUIET / deadline / 信号收尾 ----

/**
 * 造一棵最小可跑的假树。
 * @param options.hang - true 则 followup 之后的 whenIdle 永不 resolve（模拟卡死）。
 * @param options.onFollowup - followup 时同步回调 { emit, push }，用来在
 *   「run() 等静默」之前把本轮事件推进会话与总线——事后再推就来不及了，
 *   非 hang 的 whenIdle 是立刻 resolve 的。
 * @returns 假树把手。
 */
function fakeTree({ hang = false, onFollowup } = {}) {
  const stdout = captureStream()
  const stderr = captureStream()
  const calls = { cancel: [], flush: 0 }
  let listener = null
  let idleCount = 0

  // 假 session 按 **alpha.4 的形状**造：`seq` + `eventAt()` / `snapshotEvents()`，
  // 刻意**不提供**已被上游删掉的 `events` 数组 getter。这样 run() 全程走的是新读
  // 接口——上一版这个假对象把 events 伪造成普通数组，于是 alpha.4 删掉真 getter 时
  // 整套测试照样全绿，而带钥运行会在收尾处 TypeError。这类「上游删 API」只有让假
  // 对象跟着上游的形状走才拦得住。
  const log = []
  const session = {
    id: undefined, // agents.create 时回填
    get seq() { return log.length },
    // 真 Session 按 seq 索引；测试里 seq 与下标一致，但按字段找更耐得住乱序
    eventAt: (seq) => log.find(event => event.seq === seq),
    snapshotEvents: () => log.slice(),
    push: (...events) => log.push(...events), // 只给测试用，真 Session 没有这个
  }
  const agent = {
    session,
    whenIdle: () => {
      idleCount++
      // 第一次（建 agent 后）立刻 resolve；第二次（followup 之后）视 hang 而定
      return idleCount === 1 || !hang ? Promise.resolve() : new Promise(() => {})
    },
    followup: () => {
      onFollowup?.({
        push: (...events) => session.push(...events),
        emit: (event, sess = session) => listener?.(sess, event),
      })
    },
    cancel: (cause) => { calls.cancel.push(cause?.kind) },
  }
  const services = {
    loader: { await: () => Promise.resolve() },
    agents: { create: async (opts) => { session.id = opts.sessionId; return { agent } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    sessions: { flush: async () => { calls.flush++ } },
    appExit: (code) => { calls.exitCode = code; calls.resolveExit?.() },
  }
  const ctx = {
    get: (nameToGet) => services[nameToGet],
    on: (event, fn) => {
      if (event === 'session/event') listener = fn
      return () => { listener = null }
    },
  }
  const exited = new Promise(resolve => { calls.resolveExit = resolve })
  return {
    ctx, stdout, stderr, calls, exited, session,
    /** run() 是否已经订上事件总线（hang 用例要等它就位再发信号）。 */
    hasListener: () => listener !== null,
  }
}

/** 在替换掉 internals 流的前提下跑一次 apply，跑完还原。 */
async function withFakeTree(tree, body) {
  const savedOut = internals.stdout
  const savedErr = internals.stderr
  internals.stdout = tree.stdout
  internals.stderr = tree.stderr
  try {
    await body()
  } finally {
    internals.stdout = savedOut
    internals.stderr = savedErr
  }
}

const savedEnv = {
  quiet: process.env['KINGCODE_QUIET'],
  deadline: process.env['KINGCODE_DEADLINE_MS'],
  resultFile: process.env['KINGCODE_RESULT_FILE'],
}
/** 还原本测试改过的三个环境变量（别把污染带给后面的用例）。 */
function restoreEnv() {
  for (const [key, value] of [['KINGCODE_QUIET', savedEnv.quiet],
    ['KINGCODE_DEADLINE_MS', savedEnv.deadline], ['KINGCODE_RESULT_FILE', savedEnv.resultFile]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// 进度流必须写 stderr，stdout 只许有最终回答
async function checkProgressGoesToStderr() {
  delete process.env['KINGCODE_QUIET']
  delete process.env['KINGCODE_DEADLINE_MS']
  delete process.env['KINGCODE_RESULT_FILE']
  const tree = fakeTree({
    onFollowup: ({ push, emit }) => {
      const events = [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终回答' }] } } },
        { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      push(...events)
      for (const event of events) emit(event)
    },
  })
  await withFakeTree(tree, async () => {
    apply(tree.ctx, { task: '任意任务' })
    await tree.exited
  })
  eq(tree.calls.exitCode, 0, '假树跑通 → 退出码 0')
  eq(tree.stdout.text(), '最终回答\n', 'stdout 只有最终回答，进度一个字节都没漏进去')
  const err = tree.stderr.text()
  check(err.includes('轮 1 开始'), '轮次边界打在 stderr', '')
  check(err.includes('bash') && err.includes('npm test'), '工具调用打在 stderr')
  check(/\[\s*\d+\.\d s?\]|\[\s*\d+\.\ds\]/.test(err), '每行带相对起始的秒数', JSON.stringify(err.split('\n')[0]))
  check(err.includes('完成：'), '收尾摘要（耗时/收敛原因/退出码）打在 stderr')
}

// KINGCODE_QUIET=1：进度流一个字节都不写；stdout 依旧只有回答
async function checkQuietSilence() {
  process.env['KINGCODE_QUIET'] = '1'
  delete process.env['KINGCODE_DEADLINE_MS']
  delete process.env['KINGCODE_RESULT_FILE']
  const tree = fakeTree({
    onFollowup: ({ push, emit }) => {
      const events = [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } },
        { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      push(...events)
      for (const event of events) emit(event)
    },
  })
  await withFakeTree(tree, async () => {
    apply(tree.ctx, { task: '任意任务' })
    await tree.exited
  })
  eq(tree.stderr.text(), '', 'KINGCODE_QUIET=1 时 stderr 完全静默')
  eq(tree.stdout.text(), '回答\n', 'QUIET 不影响 stdout 的最终回答')
  delete process.env['KINGCODE_QUIET']
}

// deadline：到点取消 agent、flush、以 4 收场，stdout 保持空
async function checkDeadline() {
  delete process.env['KINGCODE_QUIET']
  process.env['KINGCODE_DEADLINE_MS'] = '30'
  const dir = mkdtempSync(join(tmpdir(), 'kingcode-deadline-'))
  const resultFile = join(dir, 'result.json')
  process.env['KINGCODE_RESULT_FILE'] = resultFile
  const tree = fakeTree({ hang: true })
  await withFakeTree(tree, async () => {
    apply(tree.ctx, { task: '一个跑不完的任务' })
    for (let i = 0; i < 20 && !tree.hasListener(); i++) await new Promise(r => setImmediate(r))
    tree.session.push({ seq: 0, type: 'turn/start', data: { turn: 1 } })
    await tree.exited
  })
  eq(tree.calls.exitCode, DEADLINE_EXIT_CODE, 'deadline 到点 → 退出码 4')
  eq(tree.calls.cancel.join(','), 'user', 'deadline 到点先取消 agent')
  check(tree.calls.flush >= 1, 'deadline 到点 flush 了会话（jsonl 尾部不丢）', `flush=${tree.calls.flush}`)
  eq(tree.stdout.text(), '', 'deadline 收场时 stdout 一个字节都不写（这次没有「回答」）')
  check(tree.stderr.text().includes('deadline'), 'stderr 说清是 deadline 截断的', '')
  const record = JSON.parse(readFileSync(resultFile, 'utf8'))
  eq(record.exitCode, 4, '机读结果的 exitCode 是 4')
  eq(record.termination, 'deadline', '机读结果的 termination 是 deadline')
  eq(record.signal, null, 'deadline 结局的 signal 是 null')
  eq(record.sessionId, tree.session.id, '机读结果带会话 id（能翻到 jsonl）')
  rmSync(dir, { recursive: true, force: true })
  delete process.env['KINGCODE_DEADLINE_MS']
  delete process.env['KINGCODE_RESULT_FILE']
}

// 非法 deadline：响亮拒收，不静默把护栏当没设
async function checkBadDeadline() {
  delete process.env['KINGCODE_QUIET']
  process.env['KINGCODE_DEADLINE_MS'] = '一会儿'
  const tree = fakeTree()
  await withFakeTree(tree, async () => {
    apply(tree.ctx, { task: 'x' })
    await tree.exited
  })
  eq(tree.calls.exitCode, 1, '非法 KINGCODE_DEADLINE_MS → 退出码 1')
  check(tree.stderr.text().includes('KINGCODE_DEADLINE_MS'), '非法 deadline 的报错点名了这个环境变量')
  eq(tree.stdout.text(), '', '参数错时 stdout 保持纯净')
  delete process.env['KINGCODE_DEADLINE_MS']
}

// 信号：真在 process 上装了处理器，触发后取消 + flush + 按 143 收场
async function checkSignalWindDown() {
  delete process.env['KINGCODE_QUIET']
  delete process.env['KINGCODE_DEADLINE_MS']
  const dir = mkdtempSync(join(tmpdir(), 'kingcode-signal-'))
  const resultFile = join(dir, 'result.json')
  process.env['KINGCODE_RESULT_FILE'] = resultFile
  const before = process.listenerCount('SIGTERM')
  const tree = fakeTree({ hang: true })
  await withFakeTree(tree, async () => {
    apply(tree.ctx, { task: '一个跑不完的任务' })
    for (let i = 0; i < 20 && !tree.hasListener(); i++) await new Promise(r => setImmediate(r))
    // 等 run() 装上信号处理器
    for (let i = 0; i < 20 && process.listenerCount('SIGTERM') === before; i++) await new Promise(r => setImmediate(r))
    check(process.listenerCount('SIGTERM') === before + 1, 'run() 在真 process 上装了 SIGTERM 处理器',
      `before=${before} after=${process.listenerCount('SIGTERM')}`)
    check(process.listenerCount('SIGINT') >= 1, 'run() 在真 process 上装了 SIGINT 处理器')
    tree.session.push(
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    )
    process.emit('SIGTERM') // 合成事件：不是真信号，不会杀掉本测试进程
    await tree.exited
  })
  eq(tree.calls.exitCode, SIGNAL_EXIT_CODES.SIGTERM, 'SIGTERM → 退出码 143')
  eq(tree.calls.cancel.join(','), 'user', 'SIGTERM 先取消 agent')
  check(tree.calls.flush >= 1, 'SIGTERM 收尾 flush 了会话', `flush=${tree.calls.flush}`)
  eq(tree.stdout.text(), '', 'SIGTERM 收场时 stdout 一个字节都不写')
  const record = JSON.parse(readFileSync(resultFile, 'utf8'))
  eq(record.termination, 'signal', '机读结果的 termination 是 signal')
  eq(record.signal, 'SIGTERM', '机读结果记下是哪个信号')
  eq(record.reasonKind, 'aborted', '机读结果保留轮次的 aborted 收敛原因')
  eq(process.listenerCount('SIGTERM'), before, '收尾结束后摘掉了自己装的 SIGTERM 处理器')
  rmSync(dir, { recursive: true, force: true })
  delete process.env['KINGCODE_RESULT_FILE']
}

await checkProgressGoesToStderr()
await checkQuietSilence()
await checkDeadline()
await checkBadDeadline()
await checkSignalWindDown()
restoreEnv()

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
