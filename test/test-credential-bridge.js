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

import { CHANNEL, ALLOWED_REFS, refRejection, createHandler, name, inject, apply } from '../plugins/credential-bridge.js'

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
    async describe(refs) {
      this.calls.push(['describe', refs])
      const out = {}
      for (const r of refs) {
        out[r] = store[r] === undefined
          ? { configured: false, writable: true }
          : { configured: true, source: 'file', writable: true }
      }
      return out
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
eq(got.refs.DEEPSEEK_API_KEY.configured, true, 'get 如实报告 configured')
eq(got.refs.DEEPSEEK_API_KEY.writable, true, 'get 报告 writable')
check(Array.isArray(got.allowed) && got.allowed.includes('DEEPSEEK_API_KEY'), 'get 回传白名单，UI 据此渲染')

// writable=false（被启动环境的环境变量遮蔽）要如实传出去，否则用户会觉得「写了没反应」
const shadowed = createHandler({
  async describe(refs) { return Object.fromEntries(refs.map(r => [r, { configured: true, source: 'env', writable: false }])) },
})
const shadowGot = await shadowed('get', {})
eq(shadowGot.refs.DEEPSEEK_API_KEY.writable, false, '被环境变量遮蔽时 writable=false 传得出去')
eq(shadowGot.refs.DEEPSEEK_API_KEY.source, 'env', 'source 也传得出去，UI 才能解释原因')

// ── ③ 写路径 ───────────────────────────────────────────────────────────
const setRes = await handle('set', { ref: 'DEEPSEEK_API_KEY', value: SECRET })
eq(setRes.ok, true, 'set 成功')
check(creds.calls.some(c => c[0] === 'set' && c[1] === 'DEEPSEEK_API_KEY' && c[2] === SECRET), 'set 把值透传给了 credentials 服务')

let threw = null
try { await handle('set', { ref: 'EVIL_KEY', value: 'x' }) } catch (e) { threw = e }
check(threw !== null, '白名单外的 ref 在 set 时被拒')
threw = null
try { await handle('set', { ref: 'DEEPSEEK_API_KEY', value: '' }) } catch (e) { threw = e }
check(threw !== null, '空 value 被拒')
threw = null
try { await handle('set', { ref: 'DEEPSEEK_API_KEY' }) } catch (e) { threw = e }
check(threw !== null, '缺 value 被拒')

// ── ④ 审计日志不许泄密 ─────────────────────────────────────────────────
check(logs.length > 0, 'set 留下了审计日志')
check(!logs.join('\n').includes(SECRET), '**审计日志里没有 key 的值**', logs.join(' | '))
check(logs.some(l => l.includes('DEEPSEEK_API_KEY')), '审计日志记了改的是哪个 ref')

// ── ⑤ 未知 endpoint ────────────────────────────────────────────────────
threw = null
try { await handle('describe', {}) } catch (e) { threw = e }
check(threw !== null, '未知 endpoint 抛错（通道内部必须自己 404）')

// ── ⑥ 插件契约 ─────────────────────────────────────────────────────────
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
