/**
 * 陌生代码检索（大海捞针）：夹具是一个 24 文件 / ~1600 行的 webhook 转发小库
 * （eval/fixtures/needle-haystack，零依赖 ESM，自带能跑的测试）。问题：不传任何
 * 选项、也没设环境变量时，createDispatcher() 内部那个共享限流器的滑动窗口默认是
 * 多少毫秒。
 *
 * 答案藏在三跳之外：dispatcher.js 建 Throttle → throttle.js 里
 * `windowMs ?? tuning('throttle').span` → settings.js 的 baseline ← env ← configure
 * 三层叠加 → 出厂值在 src/internal/baseline.js。沿途没有一个函数名带 window/limit/
 * default 字样；config/staging.example.json 里有一个 span: 10000 的覆盖样例、
 * 测试里有显式 windowMs: 200 / 50 ——都是读代码时必须分辨的「不是默认值」。
 * 数值本身奇特（猜不中），所以答对即证明真去读了代码。
 *
 * 判分（零 LLM）：
 * ① 期望值不手抄——判分器用 eval/oracles/needle-haystack/probe.js 对夹具**原件**
 *    真实执行 createDispatcher() 读出生效窗口（oracles/ 不复制进 runDir，agent 看不到）；
 * ② stdout 里所有 ANSWER= 取值必须恰好等于期望值（纯数字、不带单位），出现任何
 *    别的取值（列候选、两头押注）即 FAIL；至少出现一次；退出码 0；
 * ③ agent 在夹具副本里干活，原件不受污染；改不改副本不影响判分（问的是行为）。
 */

import { join } from 'node:path'
import { copyDir, runOracle } from '../lib/guards.js'

const FIXTURE = ['eval', 'fixtures', 'needle-haystack']
const PROBE = ['eval', 'oracles', 'needle-haystack', 'probe.js']

/** 对夹具原件跑探针，独立复算期望值；探针失败是 harness 的病，直接抛。 */
function expectedWindowMs(repoRoot) {
  const probe = runOracle(process.execPath, [join(repoRoot, ...PROBE), join(repoRoot, ...FIXTURE)], {
    cwd: repoRoot,
    timeoutMs: 30_000,
  })
  if (probe.timedOut) throw new Error('探针超时：夹具原件起不来')
  if (probe.status !== 0) throw new Error(`探针失败（退出码 ${probe.status}）：${probe.stderr.trim() || probe.error}`)
  const value = probe.stdout.trim()
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`探针输出不是正整数：${JSON.stringify(value)}`)
  return value
}

export default {
  id: 'needle-haystack',
  description: '陌生代码检索：24 文件小库里三跳之外的限流器默认窗口（毫秒）',
  judge: '探针对夹具原件真实执行取期望值；stdout 的 ANSWER= 取值须全部恰好等于它且至少一次，退出码 0',
  task: '我刚接手这个项目（hookrelay），还没摸熟。想确认一件事：调用 createDispatcher() 时什么选项都不传、'
    + '环境里也没有任何 HOOKRELAY_ 变量，它内部那个所有 endpoint 共用的限流器，滑动窗口默认是多少毫秒？'
    + '请以代码实际生效的值为准，不要凭印象猜。'
    + '最终回答的最后一行只写：ANSWER=<整数毫秒数>，纯数字、不带单位，也不要在别处再写别的 ANSWER= 取值。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, ...FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ repoRoot, stdout, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const expected = expectedWindowMs(repoRoot)

    // 取值允许是任意非空白串：这样 "ANSWER=7243ms" / "ANSWER=~7000" 这类不守格式的
    // 回答会作为「别的取值」被抓出来，而不是被正则漏掉后误判通过
    const answers = [...stdout.matchAll(/ANSWER\s*[=:：]\s*(\S+)/g)].map(m => m[1].replace(/[*`_]+$/g, ''))
    const wrong = answers.filter(a => a !== expected)
    const pass = exitCode === 0 && answers.length > 0 && wrong.length === 0

    const lastLine = stdout.trim().split('\n').at(-1)?.trim() ?? ''
    const lastLineClean = lastLine === `ANSWER=${expected}`
    return {
      pass,
      detail: pass
        ? `ANSWER=${expected} 唯一且正确${lastLineClean ? '，且在最后一行' : '（不在最后一行，仅记录）'}`
        : `期望 ANSWER=${expected}；提取到 ${JSON.stringify(answers)}，其中错值 ${JSON.stringify(wrong)}；exitCode=${exitCode}`,
    }
  },
}
