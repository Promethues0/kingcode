/**
 * 跨机配置面的无头测试：不起浏览器、不起服务，把手写的 client bundle 真的执行一遍。
 *
 * 守的是四类**只会静默失败**的东西——这套接缝的坑全长这样：
 *
 * ① **槽位名打错 → 分区不出现，没有任何日志。** 上游的 ctx.slots.inject(name, cb)
 *    对未声明的槽位不报错，而是一直等下去。所以这里拿装好的上游包核对
 *    'settings.section' 确实被声明过（找不到 dsh 安装时明说跳过，不假装通过）。
 * ② **模板字符串被截断。** 品牌层栽过两次：注释里写了一对反引号，把模板从中间截断，
 *    node --check 照样过（截断后仍是合法 JS），发到真机才发现。
 * ③ **信封写错 → 服务端回 bad-request，UI 只显示一句没头没脑的错。** 上游要求
 *    请求体 method 必须等于 URL 上的 endpoint，且 content-type 必须是 application/json。
 * ④ **crypto.randomUUID。** 跨机 + 明文 HTTP 是不安全上下文，那个 API 是 undefined。
 *    整个鸿蒙部署踩过这个坑（insecure-context-shim 补的正是它），这里不许再用。
 *
 * 跑法：node test/test-web-config.js（失败退出码 1）
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { execFileSync } from 'node:child_process'

const CLIENT_PATH = fileURLToPath(new URL('../web-config/client.js', import.meta.url))
const SRC = readFileSync(CLIENT_PATH, 'utf8')
const HOST_SRC = readFileSync(fileURLToPath(new URL('../web-config/index.js', import.meta.url)), 'utf8')

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expected, label) =>
  check(Object.is(actual, expected), label, Object.is(actual, expected) ? '' : `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
const skip = (label, why) => { console.log(`跳过 ${label}  ${why}`) }

// ── ① 模板字符串没被截断 ────────────────────────────────────────────────
const backticks = (SRC.match(/`/g) ?? []).length
check(backticks % 2 === 0, '反引号成对（奇数=某个模板字符串被截断）', `共 ${backticks} 个`)

// ── ② 不许用 crypto.randomUUID ──────────────────────────────────────────
// 先剥注释再断言：本文件的头注释里就写着这个名字，不剥的话是稳定的假阳性
// （品牌层测试栽过同一形状：注释里描述 bug 的那句话把断言染红了）。
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check(CODE.length > SRC.length * 0.4, '剥注释后仍有主体代码（剥过头了这条会先红）',
  `${CODE.length} / ${SRC.length}`)
check(!/crypto\s*\.\s*randomUUID/.test(CODE),
  '**没有用 crypto.randomUUID**——跨机明文 HTTP 是不安全上下文，它是 undefined')

// ── ③ 把 bundle 真的执行一遍 ────────────────────────────────────────────
let captured = null
const priorWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
try {
  runInThisContext(SRC, { filename: CLIENT_PATH })
} finally {
  if (priorWindow === undefined) delete globalThis.window
  else globalThis.window = priorWindow
}
check(captured !== null, 'bundle 调用了 window.__ModuleLoader__.load')
eq(captured?.id, 'kingcode-web-config', 'load 的 id 与包名一致（bundle 路由按它 serve）')

const requested = []
const stubReact = { useState: () => {}, useEffect: () => {}, useCallback: (fn) => fn }
const fakeRequire = (spec) => {
  requested.push(spec)
  if (spec === 'react') return stubReact
  if (spec === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Button: () => null, Input: () => null }
  throw new Error(`bundle require 了模块表外的条目：${spec}`)
}
const mod = captured.factory(fakeRequire)

// 只能 require shell 静态外部表里的条目——手写 bundle 没有构建步骤，
// require 一个不在表里的包，症状是整个 bundle 加载失败、页面少一块。
const EXTERNALS = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
check(requested.every((s) => EXTERNALS.has(s)), 'require 的都是外部表里的条目', requested.join(', '))

// ── ④ 插件契约 ─────────────────────────────────────────────────────────
eq(mod.name, 'kingcode-web-config', '具名导出 name')
eq(JSON.stringify(mod.inject), JSON.stringify(['slots']), 'inject 是 slots')
check(typeof mod.apply === 'function', '具名导出 apply')

const registrations = []
const injections = []
const effects = []
mod.apply({
  effect: (fn) => { effects.push(fn) },
  slots: {
    inject: (slotName, cb) => { injections.push(slotName); cb() },
    register: (options, component) => { registrations.push({ options, component }) },
  },
})
eq(injections.length, 1, 'apply 只注入一个槽位')
eq(injections[0], 'settings.section', '注入的是 settings.section')
eq(registrations.length, 1, 'apply 只注册一个分区')
const opts = registrations[0].options
eq(opts.name, 'settings.section', '注册在 settings.section 上')
check(opts.id !== undefined && opts.id !== '', '**给了 options.id**——list 类槽位缺 id 上游直接抛', String(opts.id))
check(typeof opts.order === 'number' && opts.order > 20,
  'order 排在上游四个分区之后（general 0 / models 10 / plugins 15 / agent-presets 20）', String(opts.order))
check(typeof opts.label === 'string' && opts.label.length > 0, '有导航用的 label', String(opts.label))
check(typeof registrations[0].component === 'function', '注册的是个组件')

// ── ⑤ 通道名两侧一致 ───────────────────────────────────────────────────
const hostChannel = HOST_SRC.match(/export const CHANNEL = '([^']+)'/)?.[1]
eq(mod.CHANNEL, hostChannel, '客户端与节点端的 CHANNEL 一致（改一边不改另一边=404）')

// ── ⑥ 请求信封形状（服务端会校验，写错只回一句 bad-request）─────────────
const calls = []
const priorFetch = globalThis.fetch
const stubFetch = (body, { status = 200, contentType = 'application/json' } = {}) =>
  async (url, init) => {
    calls.push({ url, init })
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body,
    }
  }

try {
  globalThis.fetch = stubFetch({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { refs: {} } } })
  const value = await mod.callChannel('get', { a: 1 })
  eq(JSON.stringify(value), JSON.stringify({ refs: {} }), 'ok:true 时取出 result.value')

  const sent = calls[0]
  check(sent.url.endsWith(`${hostChannel}/get`), '打在 <通道>/<endpoint> 上', sent.url)
  eq(sent.init.method, 'POST', '**用 POST**——上游对 GET 一律 404')
  eq(sent.init.headers['content-type'], 'application/json',
    '**带 content-type: application/json**——上游少了这个回 415')
  const envelope = JSON.parse(sent.init.body)
  eq(envelope.type, 'client-request', '信封 type 是 client-request')
  eq(envelope.method, 'get',
    '**信封 method 等于 URL 上的 endpoint**——上游对不上就回 bad-request')
  check(typeof envelope.rpcId === 'string' && envelope.rpcId.length > 0, 'rpcId 是非空字符串')
  eq(JSON.stringify(envelope.payload), JSON.stringify({ a: 1 }), 'payload 原样带上')

  // 不能只验 get：把 method 写死成 'get' 时，get 这条照样绿，而真机上 set
  // 会带着 method:'get' 打到 /kingcode-credentials/set，被服务端判 bad-request。
  calls.length = 0
  globalThis.fetch = stubFetch({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { ref: 'DEEPSEEK_API_KEY' } } })
  await mod.callChannel('set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-x' })
  const setEnvelope = JSON.parse(calls[0].init.body)
  eq(setEnvelope.method, 'set', '**set 的信封 method 也跟着 endpoint 走**（写死成 get 时这条才红）')
  check(calls[0].url.endsWith('/set'), 'set 打在 /set 上', calls[0].url)

  // 两次调用的 rpcId 不能撞（同一毫秒内也不能）
  await mod.callChannel('get', {})
  check(JSON.parse(calls[0].init.body).rpcId !== JSON.parse(calls[1].init.body).rpcId,
    'rpcId 不重复（同毫秒内连发也不撞）')

  // 服务端的拒绝理由要原样透出来，否则用户只看见「没反应」
  globalThis.fetch = stubFetch({
    type: 'server-response', rpcId: 'x',
    result: { ok: false, error: { code: 'bad-request', message: 'value 必须是非空字符串', details: { issues: [] } } },
  })
  let err = null
  try { await mod.callChannel('set', {}) } catch (e) { err = e }
  check(err !== null && err.message.includes('value 必须是非空字符串'),
    'ok:false 时把服务端的理由原样抛给 UI', String(err?.message))

  // 403 = 信任栅栏。最常见成因是虚拟机 IP 漂了，提示必须说到「重启」，否则没人猜得到
  globalThis.fetch = stubFetch(null, { status: 403, contentType: 'text/plain' })
  err = null
  try { await mod.callChannel('get', {}) } catch (e) { err = e }
  check(err !== null && err.message.includes('403') && err.message.includes('重启'),
    '403 的提示指向「IP 变了、重启服务」这个真实成因', String(err?.message))

  // 桥没挂时路径落到 SPA fallback，拿到 200 + HTML。不看 content-type 就 json()
  // 的话，用户看到的是 "Unexpected token <"。
  globalThis.fetch = stubFetch(null, { status: 200, contentType: 'text/html' })
  err = null
  try { await mod.callChannel('get', {}) } catch (e) { err = e }
  check(err !== null && err.message.includes('KINGCODE_CREDENTIAL_BRIDGE'),
    '收到 HTML 时说清是「桥没挂」，并给出开关名', String(err?.message))
} finally {
  if (priorFetch === undefined) delete globalThis.fetch
  else globalThis.fetch = priorFetch
}

// ── ⑦ 槽位名确实被上游声明过 ───────────────────────────────────────────
// inject 一个不存在的槽位不会报错，会**永远等下去**——症状是分区不出现、零日志。
let dshLib = null
try {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const candidate = `${root}/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`
  if (existsSync(candidate)) dshLib = candidate
} catch { /* 没装 dsh，下面明说跳过 */ }

if (dshLib === null) {
  skip('settings.section 是上游声明过的槽位', '本机找不到 dsh 安装（CI 正常，开发机上应当能找到）')
} else {
  const upstream = readFileSync(dshLib, 'utf8')
  check(upstream.includes('"settings.section": {'),
    '**settings.section 确实被上游声明过**——名字打错只会静默等待，不报错', dshLib.replace(/.*node_modules\//, ''))
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
