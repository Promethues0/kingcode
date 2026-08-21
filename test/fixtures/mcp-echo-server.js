#!/usr/bin/env node
/**
 * 零依赖的 stdio MCP server 测试夹具：JSON-RPC 2.0，一行一条消息（与
 * @modelcontextprotocol/sdk 的 StdioClientTransport / ReadBuffer 的换行分帧一致）。
 *
 * 实现 initialize / notifications/initialized / ping / tools/list / tools/call，
 * 暴露两个工具：
 *   echo { text }   → 原样返回 text
 *   add  { a, b }   → 返回 a + b 的十进制字符串
 *
 * 协议版本：客户端要什么版本就回什么版本（只要在 SUPPORTED 内），否则回
 * 2024-11-05。dsh-mcp-client 所用 SDK 1.30 请求 2025-11-25，接受
 * 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07。
 *
 * 纪律：stdout 只写 JSON-RPC 行（多一个字节都会让客户端解析失败）；
 * 诊断一律 stderr。inputSchema 不带 $schema —— dsh-tools 的 schema 子集
 * 只认 type/oneOf/properties/required/additionalProperties/items/enum/const
 * + 注解，其它关键字会被拒绝注册。
 *
 * 被两处使用：test/test-mcp-echo-server.js（不经 dsh 直连）与 cordis.mcp.yml
 * （经 dsh-mcp-client 挂成 mcp__echo__echo / mcp__echo__add）。
 */

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export const SERVER_INFO = { name: 'kingcode-mcp-echo', version: '0.1.0' }
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
export const FALLBACK_PROTOCOL_VERSION = '2024-11-05'

export const TOOLS = [
  {
    name: 'echo',
    description: 'Return the given text unchanged.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum as decimal text.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend.' },
        b: { type: 'number', description: 'Second addend.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]

// JSON-RPC 2.0 标准错误码 + MCP 沿用
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const toolError = (s) => ({ content: [{ type: 'text', text: s }], isError: true })

/** 纯函数：一个工具调用 → CallToolResult；参数形状错返回 isError 结果而不是抛。 */
export function callTool(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'echo':
      if (typeof a.text !== 'string') return toolError('echo: "text" must be a string')
      return text(a.text)
    case 'add':
      if (typeof a.a !== 'number' || typeof a.b !== 'number') return toolError('add: "a" and "b" must be numbers')
      return text(String(a.a + a.b))
    default:
      return undefined
  }
}

/**
 * 纯函数：一条已解析的 JSON-RPC 消息 → 响应对象，或 undefined（通知不回、
 * 响应消息不回）。抽出来是为了让测试不必走子进程也能覆盖分支。
 */
export function handleMessage(msg) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid JSON-RPC 2.0 message' } }
  }
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== null
  if (typeof msg.method !== 'string') return undefined // 对端发来的响应/结果，本 server 不发请求，忽略
  if (!hasId) return undefined // 通知：notifications/initialized 等，按规范不回

  const { id, method, params } = msg
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : FALLBACK_PROTOCOL_VERSION
      return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      // 不分页：不回 nextCursor；带 cursor 来也只回同一份（只有一页）
      return ok({ tools: TOOLS })
    case 'tools/call': {
      if (typeof params?.name !== 'string') return fail(INVALID_PARAMS, 'tools/call: "name" is required')
      const result = callTool(params.name, params.arguments)
      if (result === undefined) return fail(INVALID_PARAMS, `tools/call: unknown tool "${params.name}"`)
      return ok(result)
    }
    default:
      return fail(METHOD_NOT_FOUND, `method not found: ${method}`)
  }
}

/** 一行原始文本 → 要写回的响应行（或 undefined）。 */
export function handleLine(line) {
  if (line.trim() === '') return undefined
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } })
  }
  const response = handleMessage(msg)
  return response === undefined ? undefined : JSON.stringify(response)
}

function serve() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const out = handleLine(line)
    if (out !== undefined) process.stdout.write(out + '\n')
  })
  // 客户端关 stdin 即会话结束：正常退出，别挂着等
  rl.on('close', () => process.exit(0))
  process.stderr.write(`${SERVER_INFO.name}: ready (pid ${process.pid})\n`)
}

// 作为脚本启动时才进入 stdio 循环；被 import 时只暴露纯函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve()
