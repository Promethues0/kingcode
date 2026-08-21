/**
 * format() 与三个调用方的验收测试。跑法：npm test（即 node test.js）。
 * 这里的期望值是现网输出的金样例——调用方依赖的正是这些字节。
 */

import { format } from './format.js'
import { renderReport } from './report.js'
import { toCsv } from './csv-export.js'
import { summarize } from './summary.js'

let failed = 0
const eq = (got, want, label) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
}

// ---- format 本身 ----
eq(format(0), '0.00', '零补两位小数')
eq(format(1234.5), '1,234.50', '千分位逗号 + 补零')
eq(format(-9876543.21), '-9,876,543.21', '负数：负号在最前，千分位照分')
eq(format(3.14159), '3.14', '多余小数位四舍五入到两位')
eq(format('42'), '42.00', '数字字符串也接受')
eq(format(NaN), '—', 'NaN 显示为破折号')
eq(format('n/a'), '—', '转不成数字的输入显示为破折号')

// ---- 三个调用方 ----
eq(renderReport(), [
  'Keyboard        249.90        749.70',
  'Monitor       1,899.00      1,899.00',
  'Cable             4.50         54.00',
  'Refund         -129.99       -129.99',
  'Unknown              —             —',
  '------------------------------------',
  'TOTAL                       2,572.71',
].join('\n'), 'report.js：右对齐列宽不变')

eq(toCsv(), [
  'sku,qty,price,amount',
  'A-100,3,"249.90","749.70"',
  'B-220,1,"1,899.00","1,899.00"',
  'C-007,12,"4.50","54.00"',
  'R-001,1,"-129.99","-129.99"',
  'X-000,2,"—","—"',
].join('\n'), 'csv-export.js：引号内字节不变')

eq(summarize(), '249.90 | 1,899.00 | 4.50 | -129.99 | —', 'summary.js：format 直接作 map 回调')
eq(summarize([1, 2.5, 1000]), '1.00 | 2.50 | 1,000.00', 'summary.js：自定义数组同样走 map(format)')

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
