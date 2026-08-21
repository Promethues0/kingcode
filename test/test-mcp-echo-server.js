/**
 * MCP echo 夹具（test/fixtures/mcp-echo-server.js）的无头测试：不经 dsh、不调模型，
 * 直接起子进程走一遍 JSON-RPC over stdio 的 initialize → notifications/initialized
 * → tools/list → tools/call。
 *
 * 守的是四件事：
 *   ① 握手：回客户端请求的协议版本（SDK 1.30 请求 2025-11-25），不认识的版本回 2024-11-05，
 *      serverInfo/capabilities.tools 齐全；通知（无 id）不产生任何响应行。
 *   ② 工具表：恰好 echo/add 两个，inputSchema 落在 dsh-tools 的关键字子集内
 *      （无 $schema，对象节点显式 additionalProperties）。
 *   ③ 调用：add(17,25) 的文本是独立算出的 "42"；echo 原样；参数错 → isError 结果，
 *      未知工具/方法 → JSON-RPC error（-32602 / -32601），坏 JSON → -32700。
 *   ④ 纪律：stdout 只有 JSON 行、每条响应 id 与请求一一对应；关 stdin 后进程以 0 退出。
 *
 * 跑法：node test/test-mcp-echo-server.js（失败退出码 1）
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { handleMessage, handleLine, callTool, TOOLS, SUPPORTED_PROTOCOL_VERSIONS, FALLBACK_PROTOCOL_VERSION } from './fixtures/mcp-echo-server.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

const SERVER = fileURLToPath(new URL('./fixtures/mcp-echo-server.js', import.meta.url))
// dsh-tools 接受的 JSON Schema 关键字子集（lib/index.js checkSchemaNode 的报错文案）
const SCHEMA_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default'])

// ---- 纯函数层：不起进程 ----

{
  const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  eq(r.id, 1, 'initialize 响应 id 对应')
  eq(r.result?.protocolVersion, '2025-11-25', 'initialize 回客户端请求的版本（SDK 1.30 发 2025-11-25）')
  check(typeof r.result?.serverInfo?.name === 'string' && typeof r.result?.serverInfo?.version === 'string', 'serverInfo 含 name/version')
  check(r.result?.capabilities && typeof r.result.capabilities.tools === 'object', 'capabilities 声明 tools')
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const rr = handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: v } })
    eq(rr.result?.protocolVersion, v, `支持的版本原样回：${v}`)
  }
  const old = handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  eq(old.result?.protocolVersion, FALLBACK_PROTOCOL_VERSION, '不认识的版本回落 2024-11-05')
}

{
  eq(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, '通知（无 id）不回')
  eq(handleMessage({ jsonrpc: '2.0', id: 9, result: {} }), undefined, '对端的响应消息不回')
  const bad = handleMessage({ id: 1, method: 'ping' })
  eq(bad.error?.code, -32600, '缺 jsonrpc 字段 → -32600')
  const nf = handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' })
  eq(nf.error?.code, -32601, '未实现方法 → -32601')
  eq(JSON.parse(handleLine('{not json')).error.code, -32700, '坏 JSON → -32700')
  eq(handleLine(''), undefined, '空行忽略')
  eq(handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }).result && Object.keys(handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }).result).length, 0, 'ping → {}')
}

{
  const names = TOOLS.map(t => t.name).sort()
  eq(JSON.stringify(names), JSON.stringify(['add', 'echo']), '工具表恰好 echo/add')
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    for (const k of Object.keys(node)) {
      check(SCHEMA_KEYWORDS.has(k), `schema 关键字在 dsh-tools 子集内：${path}.${k}`)
    }
    if (node.type === 'object') check(typeof node.additionalProperties === 'boolean', `对象节点显式 additionalProperties：${path}`)
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.properties.${k}`)
    if (node.items) walk(node.items, `${path}.items`)
  }
  for (const t of TOOLS) walk(t.inputSchema, t.name)
  check(!/[^A-Za-z0-9_-]/.test(names.join('')), '工具名只含 [A-Za-z0-9_-]（公开名 mcp__echo__<name> 才不会被哈希改写）')
}

{
  // 期望值独立复算：不从 add 的实现推导
  const a = 17, b = 25
  const expected = String(a + b)
  eq(callTool('add', { a, b }).content[0].text, expected, 'add(17,25) 文本 = 独立复算的 42')
  eq(callTool('echo', { text: 'héllo 世界' }).content[0].text, 'héllo 世界', 'echo 原样（含非 ASCII）')
  eq(callTool('add', { a: '17', b: 25 }).isError, true, 'add 参数类型错 → isError 结果')
  eq(callTool('echo', {}).isError, true, 'echo 缺 text → isError 结果')
  eq(callTool('nope', {}), undefined, '未知工具 → undefined（由 handleMessage 转成 -32602）')
  const r = handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } })
  eq(r.error?.code, -32602, 'tools/call 未知工具 → -32602')
}

// ---- 子进程层：真走 stdio，像 MCP SDK 那样按换行分帧 ----

async function withServer(fn) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', d => stderr.push(String(d)))
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const lines = []
  const waiters = []
  rl.on('line', line => {
    lines.push(line)
    const w = waiters.shift()
    if (w) w(line)
  })
  const nextLine = (ms = 5000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待响应超时 ${ms}ms`)), ms)
    waiters.push(l => { clearTimeout(t); resolve(l) })
  })
  let nextId = 1
  const request = async (method, params) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    const line = await nextLine()
    const msg = JSON.parse(line)
    eq(msg.id, id, `响应 id 与请求一致：${method}`)
    eq(msg.jsonrpc, '2.0', `响应带 jsonrpc 2.0：${method}`)
    return msg
  }
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n')
  }
  const exit = new Promise(resolve => child.on('close', code => resolve(code)))
  try {
    await fn({ request, notify, lines, stderr, child })
  } finally {
    child.stdin.end()
  }
  const code = await Promise.race([exit, new Promise(r => setTimeout(() => r('timeout'), 5000))])
  if (code === 'timeout') child.kill('SIGKILL')
  return { code, lines, stderr: stderr.join('') }
}

const { code, lines, stderr } = await withServer(async ({ request, notify, lines }) => {
  // ① 握手，按 SDK 1.30 的顺序与载荷
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-client', version: '0.0.1' } })
  eq(init.result?.protocolVersion, '2025-11-25', '子进程：initialize 回 2025-11-25')
  notify('notifications/initialized')

  // ② 工具表
  const list = await request('tools/list')
  eq(lines.length, 2, '通知没有产生响应行（initialize + tools/list 共两行）')
  eq(list.result?.tools?.length, 2, '子进程：tools/list 两个工具')
  eq(list.result?.nextCursor, undefined, '不分页：无 nextCursor')
  const add = list.result.tools.find(t => t.name === 'add')
  eq(JSON.stringify(add?.inputSchema?.required), JSON.stringify(['a', 'b']), 'add 的 required 为 [a, b]')

  // ③ 调用——与 dsh-mcp-client 一样在 params.name 放原始名、params.arguments 放参数
  const sum = await request('tools/call', { name: 'add', arguments: { a: 17, b: 25 } })
  eq(sum.result?.content?.[0]?.type, 'text', 'add 结果是 text 块')
  eq(sum.result?.content?.[0]?.text, String(17 + 25), '子进程：add(17,25) = 42')
  eq(sum.result?.isError, undefined, '成功结果不带 isError')
  const echo = await request('tools/call', { name: 'echo', arguments: { text: 'ping' } })
  eq(echo.result?.content?.[0]?.text, 'ping', '子进程：echo 原样')
  const badArgs = await request('tools/call', { name: 'add', arguments: { a: 1 } })
  eq(badArgs.result?.isError, true, '子进程：参数错 → isError 结果（不是 JSON-RPC error）')
  const unknown = await request('tools/call', { name: 'nope' })
  eq(unknown.error?.code, -32602, '子进程：未知工具 → -32602')
  const ping = await request('ping')
  check(ping.result && Object.keys(ping.result).length === 0, '子进程：ping → {}')
})

// ④ 纪律
eq(code, 0, '关 stdin 后进程以 0 退出')
check(lines.every(l => { try { JSON.parse(l); return true } catch { return false } }), 'stdout 每一行都是合法 JSON', `共 ${lines.length} 行`)
check(stderr.includes('ready'), 'stderr 有 ready 诊断（stdout 不能有）')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
