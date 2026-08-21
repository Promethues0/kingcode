/**
 * needle-haystack 的隐藏判分探针：对**夹具原件**（不是 agent 动过的副本）
 * 真实执行 createDispatcher()，把限流器实际生效的窗口长度打印出来。
 *
 * 期望值由此独立复算，不在判分器里手抄常量——夹具以后重调数值，判分自动跟着走。
 * 用法：node probe.js <fixtureDir>
 * 退出码：0 = 打印了一个正整数；1 = 取不到/不是正整数（→ 判分器抛 harness-error）。
 *
 * 环境里任何 HOOKRELAY_* 变量都会改写默认值，这里先清掉，问的是「不传选项、无环境
 * 变量」时的出厂行为。
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const fixtureDir = process.argv[2]
if (!fixtureDir) {
  process.stderr.write('用法：node probe.js <fixtureDir>\n')
  process.exit(1)
}
for (const name of Object.keys(process.env)) {
  if (name.startsWith('HOOKRELAY_')) delete process.env[name]
}

const { createDispatcher } = await import(pathToFileURL(resolve(fixtureDir, 'src', 'index.js')).href)
const windowMs = createDispatcher().inspect().pacer.windowMs
if (!Number.isInteger(windowMs) || windowMs <= 0) {
  process.stderr.write(`探针取到的窗口长度不是正整数：${JSON.stringify(windowMs)}\n`)
  process.exit(1)
}
process.stdout.write(String(windowMs))
