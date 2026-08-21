/**
 * add-tests 的变异体规格（隐藏判分资产，agent 看不到）。
 *
 * 每个变异体 = 夹具原件 duration.js 做**一处**文本替换，引入一个 bug。
 * mutants/ 下的文件由本文件生成（`node eval/oracles/add-tests/mutants.js --write`），
 * 判分前还会把磁盘文件与「原件 + 规格」重新比对，漂移即 harness-error——
 * 变异体只有一份真相源，不会因为谁改了原件而悄悄失效。
 * 变异体文件本身不带头注释（见 mutate 与 README.md），免得留文本指纹。
 *
 * 难度有梯度（任何像样的测试都能杀前几个，后几个要真去测边界），杀灭线 4/6：
 *
 * | id                       | 改了什么                                        | 什么用例能杀 |
 * |--------------------------|-------------------------------------------------|------------------------------|
 * | day-constant-typo        | 天的秒数 86_400 敲成 84_600（数字位置对调）     | 任何含 d 的解析/格式化用例   |
 * | negative-sign-dropped    | 前导 "-" 被吃掉但忘了置 negative（符号丢失）     | 负时长：parse('-5m') 应为 -300 |
 * | empty-input-accepted     | 删掉空串检查分支：''/'   '/'-' 返回 0 而非抛错  | 空输入应抛 RangeError        |
 * | trailing-char-off-by-one | 完整消费检查 `pos !== len` 写成 `pos < len - 1`：正好一个尾随杂字符被放过 | 合法 token 后紧跟单个杂字符：'1h!'、'1hh'、'30s5' |
 * | duplicate-unit-allowed   | 删掉重复单位检查分支：'1h1h' 算 7200 而非抛错   | 重复单位应抛 RangeError      |
 * | format-zero-branch-missing | 删掉 formatDuration 的 0 特判：format(0) 返回 '' | formatDuration(0) === '0s'  |
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ORIGINAL = join(HERE, '..', '..', 'fixtures', 'add-tests', 'duration.js')
export const MUTANTS_DIR = join(HERE, 'mutants')

export const MUTANTS = [
  {
    id: 'day-constant-typo',
    change: '天的秒数 86_400 敲成 84_600',
    search: 'd: 86_400',
    replace: 'd: 84_600',
    killer: { fn: 'parseDuration', arg: '1d' },
  },
  {
    id: 'negative-sign-dropped',
    change: '前导 "-" 被吃掉但忘了置 negative，负时长变正',
    search: '    negative = true\n',
    replace: '',
    killer: { fn: 'parseDuration', arg: '-5m' },
  },
  {
    id: 'empty-input-accepted',
    change: '删掉空串检查：空输入返回 0 而不是抛 RangeError',
    search: "  if (rest === '') throw new RangeError('时长不能为空')\n",
    replace: '',
    killer: { fn: 'parseDuration', arg: '' },
  },
  {
    id: 'trailing-char-off-by-one',
    change: '完整消费检查 pos !== rest.length 写成 pos < rest.length - 1，放过一个尾随杂字符',
    search: 'if (pos !== rest.length)',
    replace: 'if (pos < rest.length - 1)',
    killer: { fn: 'parseDuration', arg: '1h!' },
  },
  {
    id: 'duplicate-unit-allowed',
    change: '删掉重复单位检查：同一单位出现两次不再抛错',
    search: '    if (seen.has(unit)) throw new RangeError(`单位 ${unit} 重复出现：${JSON.stringify(text)}`)\n',
    replace: '',
    killer: { fn: 'parseDuration', arg: '1h1h' },
  },
  {
    id: 'format-zero-branch-missing',
    change: '删掉 formatDuration 的 0 特判：format(0) 返回空串',
    search: "  if (seconds === 0) return '0s'\n",
    replace: '',
    killer: { fn: 'formatDuration', arg: 0 },
  },
]

export const mutantFile = (m) => join(MUTANTS_DIR, `${m.id}.js`)

/**
 * 规格应用到原件源码；search 必须恰好命中一次，否则规格与原件脱节，抛错。
 * 产物**不带任何头注释/标记**：变异体与原件只差那一处 bug。曾有测试 readFileSync 源码、
 * 断言「不含 '变异体'」就 6/6 全灭——说明性文字一律留在本文件与 README.md，不进变异体。
 */
export function mutate(originalSrc, m) {
  const first = originalSrc.indexOf(m.search)
  if (first < 0) throw new Error(`变异体 ${m.id}：原件里找不到 ${JSON.stringify(m.search)}`)
  if (originalSrc.indexOf(m.search, first + 1) >= 0) throw new Error(`变异体 ${m.id}：${JSON.stringify(m.search)} 在原件里命中多次`)
  return originalSrc.slice(0, first) + m.replace + originalSrc.slice(first + m.search.length)
}

/**
 * 读磁盘上的变异体，并与「原件 + 规格」现算结果逐字比对。
 * 不一致抛错（判分里即 harness-error）——宁可炸也不用过期的变异体打分。
 */
export function loadMutants(originalSrc = readFileSync(ORIGINAL, 'utf8')) {
  return MUTANTS.map(m => {
    const expected = mutate(originalSrc, m)
    const file = mutantFile(m)
    if (!existsSync(file)) throw new Error(`变异体文件缺失：${file}（跑 node eval/oracles/add-tests/mutants.js --write）`)
    const onDisk = readFileSync(file, 'utf8')
    if (onDisk !== expected) throw new Error(`变异体 ${m.id} 与规格/原件漂移：${file}（重新 --write）`)
    return { ...m, file, source: onDisk }
  })
}

// 直接运行：--write 生成/刷新 mutants/ 下的文件
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes('--write')) {
    console.log('用法：node eval/oracles/add-tests/mutants.js --write   # 按规格生成 mutants/*.js')
    process.exit(2)
  }
  const src = readFileSync(ORIGINAL, 'utf8')
  mkdirSync(MUTANTS_DIR, { recursive: true })
  for (const m of MUTANTS) {
    writeFileSync(mutantFile(m), mutate(src, m))
    console.log(`写入 ${mutantFile(m)}`)
  }
}
