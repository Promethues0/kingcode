/**
 * fix-slug 的隐藏验收测试（agent 看不到：prepare 只复制 fixtures/，本目录绝不进 runDir）。
 *
 * 为什么要有它：夹具自带的 test.js 只有 5 条用例，agent 理论上可以「查表」——对着那
 * 5 个输入硬编码返回值就能让复跑通过。这里换一批 test.js 里没有的输入覆盖边界：
 * 空串 / 全空白 / 纯符号 / 首尾分隔符 / 连续混合分隔符 / 大小写 / 控制字符 / 非 ASCII。
 *
 * 期望值不是手算的：由夹具 slug.js 补上 toLowerCase 后（两种合理位置——trim 之后
 * 或整串末尾——结果逐例相同）实跑得出。非 ASCII 三条（Café / 你好 / 🌍）钉住的是
 * 原件 `[^A-Za-z0-9]+` 的既有语义：非 ASCII 字母与符号一律当分隔符剔除，修 bug 不该
 * 顺手改这条约定。
 *
 * 跑法：判分器把本文件复制到 agent 工作目录副本里，与 slug.js 同级，`node <本文件>`。
 * 用 .mjs 后缀，不依赖副本里 package.json 的 "type" 字段没被动过。
 */

import { slugify } from './slug.js'

let failed = 0
const eq = (got, want, label) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}

// 空与纯分隔符：全部归约为空串
eq(slugify(''), '', '空串')
eq(slugify('   '), '', '全空白')
eq(slugify('!!!'), '', '纯符号')
eq(slugify('---'), '', '纯连字符')
eq(slugify('  ---  '), '', '空白包着的纯连字符')
eq(slugify('ÀÉÎ'), '', '纯非 ASCII 字母')

// 首尾分隔符剔除
eq(slugify('--Leading And Trailing--'), 'leading-and-trailing', '首尾连字符')
eq(slugify('...Dots And Dashes...'), 'dots-and-dashes', '首尾句点')

// 连续、混合分隔符折叠为单个连字符
eq(slugify('a -- b ++ c'), 'a-b-c', '空格夹符号的连续分隔符')
eq(slugify('Tabs\tand\nNewlines'), 'tabs-and-newlines', '制表符与换行当分隔符')
eq(slugify('v2.0.1 Release'), 'v2-0-1-release', '版本号里的句点')

// 大小写：这正是原 bug 所在，换几个 test.js 没有的形态
eq(slugify('A'), 'a', '单个大写字母')
eq(slugify('ALL CAPS TITLE'), 'all-caps-title', '全大写')
eq(slugify('MiXeD CaSe 42'), 'mixed-case-42', '交错大小写带数字')

// 非 ASCII：按原件约定剔除，不转写
eq(slugify('Hello 🌍 World'), 'hello-world', 'emoji 当分隔符')
eq(slugify('Café Olé'), 'caf-ol', '重音字母剔除（不转写）')
eq(slugify('你好 World'), 'world', 'CJK 剔除')

console.log(failed === 0 ? '\n隐藏用例全部通过' : `\n隐藏用例失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
