/**
 * 不安全上下文垫片的无头测试：不起浏览器、不起服务。
 *
 * 守四件事：
 * ① 注入点在所有应用代码之前（上游入口是 module 脚本，defer 到解析后才跑，
 *    经典内联脚本插在 <head> 里一定更早）；
 * ② 幂等——tapIndex 的 transform 每个 index 响应各跑一次，重复注入会掩盖「挂了两遍」；
 * ③ 找不到 <head> 要**抛**，不能静默原样返回（静默不注入 = 把「工作区永远转圈」
 *    这个症状原封不动还回去，那正是本插件要消灭的东西）；
 * ④ **注入的那段脚本自己是对的**——把它真的跑起来：不安全上下文里补出合法的
 *    RFC 4122 v4 UUID，安全上下文里一个字节都不改。只验字符串包含关系是不够的，
 *    垫片写错了照样「注入成功」。
 *
 * 跑法：node test/test-insecure-context-shim.js（失败退出码 1）
 */

import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { injectShim, MARKER, SHIM_TAG, apply, name, inject } from '../plugins/insecure-context-shim.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

// 上游 dsh-web-frontend/dist/index.html 的真实形状（2026-08，dsh 0.1.0-rc.6）：
// 入口是 head 里的 module 脚本，没有 CSP meta（有的话内联脚本会被拦）。
const UPSTREAM_INDEX = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>DeepSeek Harness</title>
    <script type="module" crossorigin src="/assets/index-Dqw48FrP.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

// ── ① 注入位置 ──────────────────────────────────────────────────────────────

const injected = injectShim(UPSTREAM_INDEX)
check(injected !== UPSTREAM_INDEX, '真的改了 html，不是原样返回')
check(injected.includes(MARKER), `注入后能找到标记 ${MARKER}`)
check(injected.indexOf(MARKER) < injected.indexOf('type="module"'),
  '垫片排在 module 入口之前（经典脚本立即执行，module 一律 defer）')
check(injected.indexOf(MARKER) < injected.indexOf('<title>'),
  '垫片紧跟 <head>，排在 head 里其余一切之前')
check(injected.includes('<head>' + SHIM_TAG), '插入点正是 <head> 之后，中间没有夹别的东西')
check(injected.replace(SHIM_TAG, '') === UPSTREAM_INDEX, '除了那一段，原文一个字节都没动')
check(!/<script[^>]*type=["']module["'][^>]*data-kingcode/.test(injected),
  '注入的是经典脚本，没有被写成 module（写成 module 就会跟着 defer，垫片就晚了）')

// ── ② 幂等 ─────────────────────────────────────────────────────────────────

eq(injectShim(injected), injected, '第二次注入原样返回（幂等）')
eq((injected.match(new RegExp(MARKER, 'g')) ?? []).length, 1, '标记只出现一次')

// ── ③ 缺 <head> 要抛 ───────────────────────────────────────────────────────

let threw = null
try { injectShim('<!doctype html><html><body></body></html>') } catch (error) { threw = error }
check(threw !== null, '找不到 <head> 时抛错，不静默')
check(threw !== null && threw.message.includes(MARKER), '错误信息里点名是哪个插件', threw?.message ?? '')
check(threw !== null && /dsh/.test(threw.message), '错误信息给出排查方向（上游前端换形状了）')

// ── ④ 把注入的脚本真的跑起来 ────────────────────────────────────────────────

/** 从注入片段里抠出脚本正文（测的是真正会送到浏览器的那份，不是另抄一份）。 */
const source = SHIM_TAG.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
check(source.length > 0 && !source.includes('<script'), '能从 SHIM_TAG 里抠出纯脚本正文')

/** 不安全上下文：有 getRandomValues，没有 randomUUID（浏览器给 [SecureContext] 打的门）。 */
function insecureCrypto() {
  return { getRandomValues: (u8) => webcrypto.getRandomValues(u8) }
}

const insecure = { crypto: insecureCrypto(), Uint8Array, Object }
insecure.globalThis = insecure
runInNewContext(source, insecure)

check(typeof insecure.crypto.randomUUID === 'function', '不安全上下文里补上了 randomUUID')

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sample = Array.from({ length: 500 }, () => insecure.crypto.randomUUID())
check(sample.every(u => V4.test(u)), 'produced UUID 全部符合 RFC 4122 v4 形状（version=4、variant=10xx）',
  sample.find(u => !V4.test(u)) ?? '')
eq(new Set(sample).size, sample.length, '500 个不重样（随机源真的接上了，不是常量）')
check(sample.every(u => u.length === 36), '长度都是 36')

// 随机性抽查：v4 里 4 与 variant 两位是固定的，其余十六进制位应当铺开。
const freeNibbles = sample.map(u => u.replace(/-/g, '').slice(0, 12)).join('')
eq(new Set(freeNibbles).size, 16, '自由位上 16 个十六进制字符全都出现过（不是只用了一小段）')

/** 安全上下文：randomUUID 已经在了，垫片必须整段跳过。 */
const native = () => 'native-uuid'
const secure = { crypto: { getRandomValues: (u8) => webcrypto.getRandomValues(u8), randomUUID: native }, Uint8Array, Object }
secure.globalThis = secure
runInNewContext(source, secure)
eq(secure.crypto.randomUUID, native, '安全上下文里不覆盖原生实现（Mac/Win 与 localhost 访问零影响）')

/** 连 getRandomValues 都没有的怪环境：不装、也不抛。 */
const barren = { crypto: {}, Uint8Array, Object }
barren.globalThis = barren
let barrenThrew = null
try { runInNewContext(source, barren) } catch (error) { barrenThrew = error }
check(barrenThrew === null, '没有 getRandomValues 时不抛（垫片把页面搞崩比缺 randomUUID 更糟）')
check(barren.crypto.randomUUID === undefined, '没有合格随机源时不硬造一个假的')

/**
 * 读 `crypto.randomUUID` 就抛的怪环境（被改坏的 polyfill、扩展注入的代理对象）。
 * 这一条专门覆盖垫片最外层那圈 try/catch——内层的早退守卫会把所有"温和"的异常环境
 * 先挡掉，所以不构造一个在**属性读取**上就炸的 crypto，那圈 catch 就是零覆盖的。
 * （构造在 crypto 对象自己身上，不要构造在沙箱全局上：vm 的全局是代理过的，
 *  在那儿定义抛异常的 getter 到不了脚本。这一点我用变异体验证过。）
 */
const hostileCrypto = { getRandomValues: (u8) => webcrypto.getRandomValues(u8) }
Object.defineProperty(hostileCrypto, 'randomUUID', {
  get() { throw new TypeError('randomUUID 的 getter 坏了') },
  configurable: true,
})
const hostile = { crypto: hostileCrypto, Uint8Array, Object }
hostile.globalThis = hostile
let hostileThrew = null
try { runInNewContext(source, hostile) } catch (error) { hostileThrew = error }
check(hostileThrew === null, '读 crypto.randomUUID 就抛的环境里，垫片自己不抛（外层 catch 真的兜住了）',
  hostileThrew?.message ?? '')

/** 连 crypto 全局都没有：同样不能抛。 */
const nothing = { Uint8Array, Object }
nothing.globalThis = nothing
let nothingThrew = null
try { runInNewContext(source, nothing) } catch (error) { nothingThrew = error }
check(nothingThrew === null, '没有 crypto 全局时也不抛')

/** crypto 是冻结对象（直接赋值会失败）：走 defineProperty 那条回退路。 */
const frozenProto = { getRandomValues: (u8) => webcrypto.getRandomValues(u8) }
const frozen = { crypto: Object.freeze(Object.create(frozenProto)), Uint8Array, Object }
frozen.globalThis = frozen
let frozenThrew = null
try { runInNewContext(source, frozen) } catch (error) { frozenThrew = error }
check(frozenThrew === null, 'crypto 实例被冻结时不抛')
check(typeof frozen.crypto.randomUUID === 'function', '冻结实例上走原型链回退，仍然补上了 randomUUID')
check(frozenThrew === null && V4.test(frozen.crypto.randomUUID()), '回退路径产出的 UUID 同样合法')

// ── 插件契约 ───────────────────────────────────────────────────────────────

eq(name, MARKER, '具名导出 name（default export 会静默丢 inject）')
eq(JSON.stringify(inject), JSON.stringify(['webServer']), 'inject 声明的是 webServer')

const taps = []
apply({ effect: (fn) => { fn() }, webServer: { tapIndex: (t) => { taps.push(t) } } })
eq(taps.length, 1, 'apply 只挂一个 index 变换')
eq(taps[0], injectShim, '挂上去的就是导出的那个纯函数（可单测的那份，不是另一个闭包）')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
