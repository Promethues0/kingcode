/**
 * 凭证桥的无头测试：不起服务、不写真凭证库。
 *
 * 守的是「这条缝不许被撑大」——插件的全部价值在于它窄，而窄是靠几条判断撑着的，
 * 判断写松了不会报错，只会安静地变成一个任意命名的密钥写入口。
 *
 * ① 白名单与 ref 形状：非 POSIX 标识符必须拒（写进去会让下次启动时凭证库解析失败、
 *    整个引擎起不来——上游 set() 自己不校验，这道闸只能我们把）；白名单外的名字必须拒。
 * ② 只写不读：get 的返回里**不能有任何看起来像值的东西**，只有 configured/writable/source。
 * ③ 未知 endpoint 必须抛（通道内部得自己 404，外面 fallback 是 SPA 首页，指望不上）。
 * ④ 审计：set/unset 要留一行日志，且**日志里不能出现 key 的值**。
 * ⑤ 插件契约：具名导出、inject 对、用的是 trusted-host 权威而不是别的。
 *
 * 跑法：node test/test-credential-bridge.js（失败退出码 1）
 */

import { CHANNEL, ALLOWED_REFS, refRejection, createHandler, name, inject, apply } from '../web-config/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (a, b, label) => check(a === b, label, a === b ? '' : `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)

// ── ① ref 校验 ─────────────────────────────────────────────────────────
eq(refRejection('DEEPSEEK_API_KEY'), undefined, '白名单内的合法 ref 放行')
for (const bad of ['', 'has-dash', '9LEADING_DIGIT', 'has space', 'has.dot', '../escape', 'a:b']) {
  check(refRejection(bad) !== undefined, `拒绝非法 ref ${JSON.stringify(bad)}`)
}
check(/POSIX/.test(refRejection('has-dash') ?? ''), '非法形状的拒绝理由说清后果（引擎起不来）')
check(refRejection('OPENAI_API_KEY') !== undefined, '拒绝白名单外的合法标识符')
check(/白名单/.test(refRejection('OPENAI_API_KEY') ?? ''), '白名单拒绝理由点明是白名单')
eq(ALLOWED_REFS.length, 1, '白名单只有一项（加项前请三思）')

// ── ② 只写不读 ─────────────────────────────────────────────────────────
const SECRET = 'sk-must-never-be-returned-0123456789'
function fakeCredentials(state = {}) {
  const store = { DEEPSEEK_API_KEY: undefined, ...state }
  return {
    calls: [],
    // 照上游真签名：describe(ref) 收**单个** ref、回**单个** CredentialInfo。
    // 这个假货最早写成「收数组、回映射」，于是把桥里同样的错误假设一起验绿了——
    // 真机上表现为「明明配了 key 还是显示未配置」。假货照着 d.ts 写，不照着实现写。
    async describe(ref) {
      if (typeof ref !== 'string') throw new TypeError(`describe 收单个 ref，拿到了 ${JSON.stringify(ref)}`)
      this.calls.push(['describe', ref])
      return store[ref] === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: 'file', writable: true }
    },
    async set(ref, value) { this.calls.push(['set', ref, value]); store[ref] = value },
    async unset(ref) { this.calls.push(['unset', ref]); delete store[ref] },
  }
}

const logs = []
const creds = fakeCredentials({ DEEPSEEK_API_KEY: SECRET })
const handle = createHandler(creds, (line) => logs.push(line))

const got = await handle('get', {})
const serialized = JSON.stringify(got)
check(!serialized.includes(SECRET), '**get 的返回里没有 key 的值**', serialized)
check(!/sk-/.test(serialized), 'get 的返回里没有任何 sk- 形状的东西')
eq(got.ok, true, 'get 回的是上游成功信封 { ok: true, value }')
eq(got.value.refs.DEEPSEEK_API_KEY.configured, true, 'get 如实报告 configured')
eq(got.value.refs.DEEPSEEK_API_KEY.writable, true, 'get 报告 writable')
check(Array.isArray(got.value.allowed) && got.value.allowed.includes('DEEPSEEK_API_KEY'),
  'get 回传白名单，UI 据此渲染')
check(creds.calls.some(c => c[0] === 'describe' && c[1] === 'DEEPSEEK_API_KEY'),
  '**describe 是拿单个 ref 字符串调的**——传数组进去不抛错，只会永远说「未配置」',
  JSON.stringify(creds.calls.filter(c => c[0] === 'describe')))

// writable=false（被启动环境的环境变量遮蔽）要如实传出去，否则用户会觉得「写了没反应」
const shadowed = createHandler({
  async describe(ref) {
    if (typeof ref !== 'string') throw new TypeError(`describe 收单个 ref，拿到了 ${JSON.stringify(ref)}`)
    return { configured: true, source: 'env', writable: false }
  },
})
const shadowGot = (await shadowed('get', {})).value
eq(shadowGot.refs.DEEPSEEK_API_KEY.writable, false, '被环境变量遮蔽时 writable=false 传得出去')
eq(shadowGot.refs.DEEPSEEK_API_KEY.source, 'env', 'source 也传得出去，UI 才能解释原因')

// ── ③ 写路径 ───────────────────────────────────────────────────────────
const setRes = await handle('set', { ref: 'DEEPSEEK_API_KEY', value: SECRET })
eq(setRes.ok, true, 'set 成功')
eq(setRes.value.ref, 'DEEPSEEK_API_KEY', 'set 回报改的是哪个 ref')
check(creds.calls.some(c => c[0] === 'set' && c[1] === 'DEEPSEEK_API_KEY' && c[2] === SECRET),
  'set 把值透传给了 credentials 服务')

// ── ④ 拒绝走信封，不走异常 ─────────────────────────────────────────────
// 抛异常的话传输层只回 500 + 纯文本，拒绝理由到不了 UI，用户只看见「写了没反应」。
for (const [label, payload] of [
  ['白名单外的 ref', { ref: 'EVIL_KEY', value: 'x' }],
  ['非法标识符的 ref', { ref: '2-bad', value: 'x' }],
  ['空 value', { ref: 'DEEPSEEK_API_KEY', value: '' }],
  ['缺 value', { ref: 'DEEPSEEK_API_KEY' }],
]) {
  let res = null
  let threw = null
  try { res = await handle('set', payload) } catch (e) { threw = e }
  check(threw === null, `${label}：不抛异常（抛了就只剩 500 纯文本）`, String(threw))
  eq(res?.ok, false, `${label}：被拒`)
  eq(res?.error?.code, 'bad-request', `${label}：用上游判别联合里存在的 code`)
  check(Array.isArray(res?.error?.details?.issues), `${label}：details.issues 是必填字段`)
  check(typeof res?.error?.message === 'string' && res.error.message.length > 0,
    `${label}：带得上人话理由`)
}

// 白名单外的 ref 一律不落到 credentials 服务上
check(!creds.calls.some(c => c[0] === 'set' && c[1] === 'EVIL_KEY'), '被拒的 ref 没有透传给 credentials')

// ── ⑤ 底层抛错时不许把值漏出去 ─────────────────────────────────────────
// credentials.set 失败时上游很可能把入参回显进 Error.message，那条 message 会同时
// 进引擎日志和错误信封——一次写盘失败就能把 key 明文写进 run/web.log。
const boomLogs = []
const boom = createHandler({
  async set(ref, value) { throw new Error(`ENOSPC: 写不进去，值是 ${value}`) },
}, (line) => boomLogs.push(line))
const boomRes = await boom('set', { ref: 'DEEPSEEK_API_KEY', value: SECRET })
eq(boomRes.ok, false, '底层抛错变成 ok:false 信封，不是 500')
check(!JSON.stringify(boomRes).includes(SECRET), '**底层抛错时，错误信封里没有 key 的值**', JSON.stringify(boomRes))
check(!boomLogs.join('\n').includes(SECRET), '**底层抛错时，引擎日志里没有 key 的值**', boomLogs.join(' | '))
check(boomLogs.join('\n').includes('ENOSPC'), '真正的失败原因还留在日志里，没被脱敏误伤')

// ── ⑥ 审计日志不许泄密 ─────────────────────────────────────────────────
check(logs.length > 0, 'set 留下了审计日志')
check(!logs.join('\n').includes(SECRET), '**审计日志里没有 key 的值**', logs.join(' | '))
check(logs.some(l => l.includes('DEEPSEEK_API_KEY')), '审计日志记了改的是哪个 ref')

// ── ⑦ 未知 endpoint ────────────────────────────────────────────────────
let unknown = null
try { unknown = await handle('describe', {}) } catch { /* 抛了就是下面那条失败 */ }
eq(unknown?.ok, false, '未知 endpoint 回 ok:false（通道内部必须自己报错）')

// ── ⑧ 插件契约 ─────────────────────────────────────────────────────────
eq(name, 'kingcode-credential-bridge', '具名导出 name')
eq(JSON.stringify(inject), JSON.stringify(['connection', 'credentials']), 'inject 是 connection + credentials')
check(/^\/[A-Za-z0-9._~-]+$/.test(CHANNEL), '通道名符合上游 CHANNEL_PATTERN（单段）', CHANNEL)
check(CHANNEL !== '/api', '通道名不是被保留的 /api')

const registered = []
apply({
  effect: (fn) => { fn() },
  credentials: fakeCredentials(),
  connection: { rpc: { handle: (ch, h, opts) => { registered.push({ ch, opts }) } } },
})
eq(registered.length, 1, 'apply 只挂一个通道')
eq(registered[0].ch, CHANNEL, '挂在约定的通道上')
eq(registered[0].opts.authority, 'trusted-host',
  '**用 trusted-host 权威**——webServer.register 那条路完全没有信任栅栏，实测伪造 Host 也 200')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
