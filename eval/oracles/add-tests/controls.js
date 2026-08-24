/**
 * add-tests 的**阴性对照**（negative control，隐藏判分资产，agent 看不到）。
 *
 * 变异体回答「测试杀不杀得死 bug」，阴性对照回答另一个问题：**测试测的到底是行为，
 * 还是源码文本 / 运行环境**。对照是一份与夹具原件**行为完全一致、只是写法不同**的
 * duration.js。它和变异体走完全相同的通道（原地换掉 cwd 里的 duration.js、跑同一套测试），
 * 于是：
 *
 * - 真去调函数、断言返回值与抛错的测试，在对照上**必然全过**（行为没变）；
 * - 靠源码文本判真伪的伪测试——读文件、隐式/显式 toString 指纹、Error.stack 行号、
 *   字面量拼写——会把对照也「杀死」，当场现形。
 *
 * 判据（见 eval/tasks/add-tests.js）：**杀死任何一个阴性对照 = FAIL**，不管它杀了几个
 * 真变异体。这是结构性的，不是黑名单：对照与原件属于同一个行为等价类，能把它们分开的
 * 判据一定不是行为。
 *
 * 三个对照，文本发散程度递增：
 *
 * | id                | 是什么 | 抓什么 |
 * |-------------------|--------|--------|
 * | identical         | 原件逐字节副本 | 不稳定 / 依赖运行环境（跑第几次、进程状态）的测试 |
 * | cosmetic-rename   | 同一套算法，去掉头注释、内部标识符全改名、字面量改拼写（86_400→86400）、结构重排、行号错位 | 源码指纹（含 `m[k] + ''` 这类别名化隐式 toString）、Error.stack 行号指纹、字面量子串断言 |
 * | rewritten-scanner | 换了一套实现：手写字符扫描替代粘性正则、字符串拼接替代模板串 | 上面全部，外加「先把源码规范化再指纹」的写法 |
 *
 * **等价性不是靠嘴说的**：`loadControls()` 在**判分时现算**——把原件与每个对照都 import
 * 进来，在一份系统用例 + 确定性 fuzz（见 `equivalenceCases`，数千条）上逐例比对返回值
 * （`Object.is`，-0 也分得清）、抛错的构造函数名与 message 逐字、导出集合 / 函数名 / 形参个数。
 * 任何一条不同就抛错 → harness-error。所以：
 *
 * - 有人改了夹具 duration.js 而没同步对照 → 直接炸，不会拿过期对照去误判 agent；
 * - 对照写错了（不是真的等价）→ 直接炸，不会把合法测试冤成作弊。
 *
 * 自检见 selfcheck.js（含「源码指纹伪测试确实会误杀对照」的正面验证）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ORIGINAL } from './mutants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CONTROLS_DIR = join(HERE, 'controls')

export const CONTROLS = [
  {
    id: 'identical',
    file: ORIGINAL,
    what: '原件逐字节副本',
    catches: '不稳定或依赖运行环境（跑第几次 / 进程状态）的测试',
  },
  {
    id: 'cosmetic-rename',
    file: join(CONTROLS_DIR, 'cosmetic-rename.js'),
    what: '同一套算法，改名 / 重排 / 换字面量拼写 / 换掉头注释 / 行号错位',
    catches: '源码指纹（含隐式 toString）、Error.stack 行号指纹、字面量子串断言',
  },
  {
    id: 'rewritten-scanner',
    file: join(CONTROLS_DIR, 'rewritten-scanner.js'),
    what: '换一套实现：手写字符扫描替代粘性正则、拼接替代模板串',
    catches: '上面全部，外加先规范化源码再指纹的写法',
  },
]

/** 确定性伪随机（LCG），fuzz 语料每次跑都一模一样——判分不能靠运气。 */
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const PARSE_FIXED = [
  '', ' ', '   ', '\t', '\n', '-', '- ', '--', '--5m', '-  5m', '- ',
  '0', '1', '90', '007', '-0', '-90', '  90  ', '1e3', '0x10', '+5', '1,000',
  '9007199254740993', '9'.repeat(20), '9'.repeat(400) + 'd',
  '1d', '1h', '1m', '1s', '0d', '0h', '0m', '0s', '12h', '24h', '60s', '3600s',
  '1h30m', '1h30m15s', '1d2h3m4s', '30m1h', '1s1m', '4s3m2h1d', '1d1s',
  '1 h', '1h 30m', ' 1h  30 m ', '1h\t30m', '1  h  30  m', '  1d  ',
  '1h1h', '1h30m1h', '1d1d', '1s1s', '1h30m30m',
  '1h!', '1hh', '30s5', '1h 3', '1h-', 'x1h', '1h!!', 'h', 'd', '1', '1x',
  '1.5h', '1,5h', '1H', '1D', 'abc', '1h2z', '1h 2', '1h2', '-1h!',
  '1h ', ' 1h', '1 h', '１ｈ', '1h​', '﻿1h', '1h ',
  ' ', '　', '1d　', '1h\r\n',
]

const PARSE_NON_STRING = [0, 1, -1, 1.5, NaN, Infinity, null, undefined, true, false, [], {}, ['1h'], new Date(0)]

const FORMAT_FIXED = [
  0, -0, 1, -1, 2, 59, 60, 61, -61, 3599, 3600, 3601, 86399, 86400, 86401,
  90061, -90061, 5415, -5415, 300, -300, 100000, 1e6, -1e6,
  Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1e21, -1e21,
  1.5, -0.5, 0.1, NaN, Infinity, -Infinity, '5', '0', null, undefined, true, false, [], {}, [5],
]

const FUZZ_ALPHABET = ['0', '1', '2', '5', '9', 'd', 'h', 'm', 's', ' ', '\t', '-', '!', 'x', '.', ' ', 'H', '+']

/**
 * 等价性语料：系统用例 + 确定性 fuzz。返回 [fnName, arg] 列表。
 * 覆盖两个方向都要够密——对照上任何一条与原件不同，都会在 loadControls 里炸出来。
 */
export function equivalenceCases({ fuzz = 3000 } = {}) {
  const cases = []
  for (const s of PARSE_FIXED) cases.push(['parseDuration', s])
  for (const v of PARSE_NON_STRING) cases.push(['parseDuration', v])
  for (const n of FORMAT_FIXED) cases.push(['formatDuration', n])

  const rand = lcg(0x5eed1234)
  for (let i = 0; i < fuzz; i += 1) {
    const len = Math.floor(rand() * 9)
    let s = ''
    for (let k = 0; k < len; k += 1) s += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)]
    cases.push(['parseDuration', s])
  }
  const rand2 = lcg(0xc0ffee)
  for (let i = 0; i < Math.floor(fuzz / 3); i += 1) {
    const mag = Math.floor(rand2() * 3_000_000) - 1_500_000
    cases.push(['formatDuration', mag])
    // 顺带覆盖 format(parse(...)) 的往返：格式化结果再解析回去，两边必须一致
    cases.push(['roundTrip', mag])
  }
  return cases
}

/** 把「返回值」与「抛错」编码成可逐字比对的字符串：Object.is 语义（-0 分得清）+ 错误类型 + message 原文。 */
export function outcome(mod, fn, arg) {
  try {
    if (fn === 'roundTrip') {
      const text = mod.formatDuration(arg)
      return `ret:string:${text}|${mod.parseDuration(text)}`
    }
    const v = mod[fn](arg)
    return `ret:${typeof v}:${Object.is(v, -0) ? '-0' : String(v)}`
  } catch (e) {
    const name = e === null || e === undefined ? String(e) : (e.constructor?.name ?? typeof e)
    return `throw:${name}:${e?.message}`
  }
}

/** 模块的静态形状：导出了什么、函数叫什么、几个形参。对照必须与原件完全一致。 */
export function moduleShape(mod) {
  return Object.keys(mod).sort().map(k => {
    const v = mod[k]
    return typeof v === 'function' ? `${k}:function:${v.name}:${v.length}` : `${k}:${typeof v}`
  }).join(',')
}

/**
 * 载入全部阴性对照，并在语料上**现算**等价性。
 * 任何一条与原件不同 / 文件缺失 / 形状不同 → 抛错（判分里即 harness-error）。
 * 返回 [{ id, file, source, what, catches }]。
 */
export async function loadControls(originalSrc = readFileSync(ORIGINAL, 'utf8'), { fuzz } = {}) {
  const cases = equivalenceCases({ fuzz })
  const original = await import(`${pathToFileURL(ORIGINAL).href}?control=origin`)
  const originalShape = moduleShape(original)
  const expected = cases.map(([fn, arg]) => outcome(original, fn, arg))

  const out = []
  for (const c of CONTROLS) {
    if (!existsSync(c.file)) throw new Error(`阴性对照文件缺失：${c.file}`)
    const source = readFileSync(c.file, 'utf8')
    if (c.id === 'identical') {
      if (source !== originalSrc) throw new Error(`阴性对照 identical 与原件不逐字节相同：${c.file}`)
      out.push({ ...c, source })
      continue
    }
    if (source === originalSrc) throw new Error(`阴性对照 ${c.id} 与原件逐字相同，起不到「换了写法」的作用：${c.file}`)
    const mod = await import(`${pathToFileURL(c.file).href}?control=${c.id}`)
    const shape = moduleShape(mod)
    if (shape !== originalShape) {
      throw new Error(`阴性对照 ${c.id} 的模块形状与原件不同：${shape} ≠ ${originalShape}`)
    }
    for (let i = 0; i < cases.length; i += 1) {
      const [fn, arg] = cases[i]
      const got = outcome(mod, fn, arg)
      if (got !== expected[i]) {
        throw new Error(
          `阴性对照 ${c.id} 与原件行为不同（它必须完全等价，否则会冤枉合法测试）：`
          + `${fn}(${JSON.stringify(arg)}) 原件 ${expected[i]} / 对照 ${got}；文件 ${c.file}`,
        )
      }
    }
    out.push({ ...c, source })
  }
  return out
}
