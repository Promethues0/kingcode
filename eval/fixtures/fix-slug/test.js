/**
 * slugify 的验收测试。跑法：npm test（即 node test.js）。
 * 评测判分会校验本文件与夹具原件逐字节一致——改测试不算修复。
 */

import { slugify } from './slug.js'

let failed = 0
const eq = (got, want, label) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}

eq(slugify('Hello World'), 'hello-world', '空格转连字符且小写')
eq(slugify('  Multiple   Spaces  '), 'multiple-spaces', '首尾空白与连续空格折叠')
eq(slugify('Already-Slugged'), 'already-slugged', '已含连字符时仅小写')
eq(slugify('C++ & Rust!'), 'c-rust', '符号折叠成单个连字符')
eq(slugify('2026 Roadmap (Draft)'), '2026-roadmap-draft', '数字保留、括号剔除')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
