/**
 * 品牌层的无头测试：不起浏览器、不起服务。
 *
 * 存在的理由是一次真实事故：给 BRAND_CSS（一个模板字符串）的注释里写了一对反引号，
 * 把模板从中间**截断**了——`node --check` 照样通过（截断后仍是合法 JS），
 * check:contrast 也通过（它只看调色板常量），于是残缺的 CSS 一路发到鸿蒙真机上，
 * 表现为「上游的 deepseek 鲸鱼、HARNESS 字标、『探索未至之境 预览版』全都露出来」，
 * 而**没有任何报错**。这类「语法合法但内容被截断」的失败，只有断言内容才拦得住。
 *
 * 守的是四件事：
 * ① BRAND_CSS 能被完整抽出来，且四类品牌覆盖规则一条不少（截断必红）；
 * ② 覆盖上游图形的选择器**不锚 DOM 层级**——真机上同版本 dsh 的前端会被重打包，
 *    `button > svg` 这种直接子元素选择器会安静失效（这是第二次事故的成因）；
 * ③ CSS 大括号配平（截断最典型的形状就是括号不配）；
 * ④ 插件契约：具名导出 name/inject/apply，且 apply 真的注入了 style 元素。
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
check(css.length > 1200, 'BRAND_CSS 长度合理（截断后会骤减）', `${css.length} 字符`)

// 四类品牌覆盖，一条都不能少——每条都对应一处上游硬编码的品牌图形
const REQUIRED = [
  // 不再断言具体 viewBox：新版 BrandWordmark 的 includeMark 开关会让宽高比在
  // 182:24 与 156:24 之间切换，钉死数值的选择器会再次落空（真机上复发过一次）。
  [/button\[class\*="_brand"\] svg \{ display: none/, '侧栏 wordmark 遮罩（deepseek + HARNESS 字标）'],
  [/_railFish/, '收起态的鲸鱼单标'],
  [/_fishHitbox/, '首页鲸鱼'],
  [/_previewBadge/, '首页「预览版」徽章'],
  [/_headline/, '首页标题（探索未至之境）'],
  [/_heroGlow/, '输入框光晕里硬编码的 DeepSeek 蓝'],
]
for (const [re, what] of REQUIRED) check(re.test(css), `覆盖规则在：${what}`)

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
