/**
 * runner/startup 核心链路的无头测试：不起 agent、不调模型。
 *
 * 守护的是 CLI 的三条卖点行为：summarize 的事件汇总、缺核心服务时响亮报错
 * （区别于上游静默挂死）、退出码契约（0=完成有输出 / 3=完成零输出 / 1=其余）。
 *
 * 跑法：node test/test-runner.js（失败退出码 1）
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarize, exitCodeFor, internals, apply } from '../plugins/runner.js'

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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
