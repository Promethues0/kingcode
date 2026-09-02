/**
 * 品牌层的无头测试：不起浏览器、不起服务。
 *
 * 存在的理由是一次真实事故：给 BRAND_CSS（一个模板字符串）的注释里写了一对反引号，
 * 把模板从中间**截断**了——`node --check` 照样通过（截断后仍是合法 JS），
 * check:contrast 也通过（它只看调色板常量），于是残缺的 CSS 一路发到鸿蒙真机上，
 * 表现为「上游的 deepseek 鲸鱼、HARNESS 字标、『探索未至之境 预览版』全都露出来」，
 * 而**没有任何报错**。这类「语法合法但内容被截断」的失败，只有断言内容才拦得住。
 *
 * 守的是五件事：
 * ① BRAND_CSS 能被完整抽出来，且**留在 CSS 里的**那几类覆盖规则一条不少（截断必红）；
 * ② 三处品牌图形（侧栏字标、侧栏字样、首页标记）已经改走官方 slot，占位注册一处
 *    都不能少——它们从 CSS 挪走之后，原来那三条 `display: none` 断言就不再是判据了，
 *    换成断言 slot 名与占位组件（dsh 0.1.0-rc.8 的 `feat(client): compose deployment
 *    branding through slots`）；
 * ③ 覆盖上游图形的选择器**不锚 DOM 层级**——真机上同版本 dsh 的前端会被重打包，
 *    `button > svg` 这种直接子元素选择器会安静失效（这是第二次事故的成因）；
 * ④ CSS 大括号配平（截断最典型的形状就是括号不配）；
 * ⑤ 插件契约：具名导出 name/inject/apply，apply 真的注入了 style 元素、叠了 token 层。
 *
 * 跑法：node test/test-web-brand.js（失败退出码 1）
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../web-brand/client.js', import.meta.url)), 'utf8')

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}

// ── ① 模板字符串没被截断 ────────────────────────────────────────────────
const backticks = (SRC.match(/`/g) ?? []).length
check(backticks % 2 === 0, '反引号成对（奇数=某个模板字符串被截断）', `共 ${backticks} 个`)

const m = SRC.match(/const BRAND_CSS = `([\s\S]*?)`\n/)
check(m !== null, '能抽出 BRAND_CSS 模板')
const css = m ? m[1] : ''
// 门槛随着三条规则挪去 slot 而下调（旧值 1200 对应还有五类覆盖的年代）。
// 留着这条断言的意义不变：截断会让它骤减到几十字符。
check(css.length > 400, 'BRAND_CSS 长度合理（截断后会骤减）', `${css.length} 字符`)

// 留在 CSS 里的覆盖，一条都不能少。这三处上游没有开缝：_headlineText 与
// _previewBadge 是 EmptyHero 直接渲染的两个 span（文案走 locale，而 locale 只支持
// 注册新语言、不支持覆盖既有语言的词条），_heroGlow 里的蓝是写死在 SVG fill 上的。
const REQUIRED_CSS = [
  [/_previewBadge/, '首页「预览版」徽章'],
  [/_headline/, '首页标题（探索未至之境）'],
  [/_heroGlow/, '输入框光晕里硬编码的 DeepSeek 蓝'],
]
for (const [re, what] of REQUIRED_CSS) check(re.test(css), `覆盖规则在：${what}`)

// ── ② 三处改走 slot 的品牌图形 ─────────────────────────────────────────
// 这三条以前是 CSS 里的 `display: none !important` + ::before/::after。改走官方
// slot 之后，判据也得跟着换：占住 slot 就是整段替换（kind: 'single'），所以不再
// 需要藏上游的 fallback——反过来说，**注册没了就是上游品牌原样露出来**，和当年那次
// 真机事故是同一种无声失败，所以这里逐个断言。
const REQUIRED_SLOTS = [
  ['sidebar.brand.mark', '侧栏 K 字标（展开态与收起态 rail 共用同一个 slot）'],
  ['sidebar.brand.name', '侧栏 KingCode 字样'],
  ['conversation.hero.brand.mark', '首页 Hero 的标记（原鲸鱼）'],
]
for (const [slot, what] of REQUIRED_SLOTS) {
  check(SRC.includes(`ctx.slots.inject('${slot}'`), `等这个 slot 被声明：${slot}`)
  check(new RegExp(`register\\(\\{ name: '${slot.replace(/\./g, '\\.')}' \\}, \\w+\\)`).test(SRC),
    `占住 slot：${what}`)
}
check(/const inject = \['theme', 'slots'\]/.test(SRC), "inject 里有 slots（少了它 ctx.slots 是 undefined）")
check(/const React = require\('react'\)/.test(SRC), 'React 从模块表 require（占 slot 要交 React 组件）')
// 占位组件本身也可能被截断，且截断后仍是合法 JS——同一类无声失败。
check(/function KMark\(/.test(SRC) && /function KWordmark\(/.test(SRC), '两个占位组件都在')
check(/var\(--kingcode-mark-from\)/.test(SRC) && /var\(--kingcode-mark-to\)/.test(SRC),
  'K 字标的渐变读的是 token（亮暗切换靠它，不再烤死两份颜色）')
check(/'--kingcode-mark-from':/.test(SRC) && /'--kingcode-mark-to':/.test(SRC),
  '那两个 token 真的在 TOKENS 里定义了（只 var() 不定义就是透明的 K）')
check(/gradientUnits: 'userSpaceOnUse'/.test(SRC),
  "渐变用 userSpaceOnUse（默认的 objectBoundingBox 会让竖笔盒宽为零、K 退化成「<」）")
check(/React\.useId\(\)/.test(SRC), '渐变 id 每实例唯一（侧栏与首页同时挂着，id 是全文档作用域）')

// ── ② 不许锚 DOM 层级 ──────────────────────────────────────────────────
// 真机实测：同为 dsh 0.1.0-rc.6，全新 npm 安装解析到的子依赖更新、前端重打包后
// BrandWordmark 外面多了一层，`button > svg` 落空，上游字标安静地漏了出来。
// 选择器只能锚组件自身的稳定属性（viewBox、类名后缀）。
// 先把 CSS 注释整段剥掉再查——注释里会描述这个坑本身（「button > svg 落空」），
// 不剥的话测试会拿自己的说明文字当罪证，这正是第一版跑出来的假阳性。
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
const childCombinators = cssNoComments.split('\n')
  .filter(l => /[a-zA-Z\]"]\s*>\s*[a-zA-Z\[]/.test(l))
check(childCombinators.length === 0, '没有用直接子元素选择器（上游重打包会让它安静失效）',
  childCombinators[0]?.trim() ?? '')

// ── ③ 大括号配平 ───────────────────────────────────────────────────────
const opens = (css.match(/{/g) ?? []).length
const closes = (css.match(/}/g) ?? []).length
check(opens === closes, 'CSS 大括号配平', `{ ${opens} / } ${closes}`)
check(opens >= 6, '规则数量合理', `${opens} 条`)

// ── ④ 插件契约 ─────────────────────────────────────────────────────────
check(/exports\.name = name/.test(SRC), '具名导出 name（default export 会静默丢 inject）')
check(/exports\.inject = inject/.test(SRC), '具名导出 inject')
check(/exports\.apply = apply/.test(SRC), '具名导出 apply')
check(/document\.createElement\('style'\)/.test(SRC) && /style\.textContent = BRAND_CSS/.test(SRC),
  'apply 把 BRAND_CSS 注入成 style 元素')
check(/theme\.overrideTokens\(/.test(SRC), 'apply 叠了品牌 token 层')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
