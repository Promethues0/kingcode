/**
 * 代码修复类任务：fixture 里 slugify 缺 toLowerCase，npm test 五项全挂。
 * agent 在 fixture 的**副本**上干活（prepare 每次全量复制，原件永不被污染）。
 *
 * 判分（零 LLM）三件事，缺一不可：
 * ① test.js 必须与夹具原件逐字节一致——改测试不算修复（金样例纪律）；
 * ② 判分器自己在副本里复跑 `node test.js`，退出码 0；
 * ③ 隐藏用例全过：eval/oracles/fix-slug/hidden-test.mjs 在 grade 时才复制进副本、
 *    与 slug.js 同级跑。它覆盖 test.js 没有的输入（空串、纯符号、首尾/连续分隔符、
 *    非 ASCII、别的大小写形态）——对着 test.js 的 5 个输入硬编码返回值的「查表法」
 *    过得了 ②、过不了 ③。oracles/ 不在 prepare 的复制范围内，agent 看不到。
 */

import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import { assertFrozen, copyDir, runOracle } from '../lib/guards.js'

const FIXTURE = 'fix-slug'
const FROZEN = ['test.js']
const HIDDEN_TEST = 'hidden-test.mjs'
// 复制进副本时用的文件名：刻意生僻，不跟 agent 可能新建的文件撞名
const HIDDEN_TEST_IN_CWD = '__eval_hidden_slug_test.mjs'

/** 从判分输出里摘 FAIL 行，给 detail 用。 */
const failLines = (stdout) => stdout.split('\n').filter(l => l.startsWith('FAIL'))

export default {
  id: 'fix-slug',
  description: '修复 slugify 缺小写导致的 5 项测试失败（禁改 test.js；另有隐藏用例防查表）',
  judge: 'test.js 与原件逐字节比对 + 复跑 node test.js 退出码 + 隐藏用例（oracles/fix-slug）复制进副本复跑',
  task: '这个项目的测试挂了。请先运行 npm test 看失败原因，然后修复源码让全部测试通过。'
    + '不要修改 test.js（判分会校验它与原件一致）。修好后再跑一次测试确认，最后简要说明你改了什么。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, 'eval', 'fixtures', FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }

    const originDir = join(repoRoot, 'eval', 'fixtures', FIXTURE)

    // ① 冻结文件逐字节一致
    const frozen = assertFrozen(cwd, originDir, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }

    // ② 复跑夹具自带测试（子进程 + 超时；agent 的代码可能死循环）
    const rerun = runOracle(process.execPath, ['test.js'], { cwd, timeoutMs: 30_000 })
    if (rerun.timedOut) return { pass: false, detail: '复跑 test.js 超时（30s）' }
    if (rerun.status !== 0) {
      return {
        pass: false,
        detail: `复跑 test.js 仍失败（退出码 ${rerun.status}）：${failLines(rerun.stdout).join('；') || rerun.stderr.trim().split('\n').slice(-1)[0] || '无 FAIL 行'}`,
      }
    }

    // ③ 隐藏用例：此刻才复制进副本（agent 已经退出，看不到），与 slug.js 同级跑
    copyFileSync(join(repoRoot, 'eval', 'oracles', FIXTURE, HIDDEN_TEST), join(cwd, HIDDEN_TEST_IN_CWD))
    const hidden = runOracle(process.execPath, [HIDDEN_TEST_IN_CWD], { cwd, timeoutMs: 30_000 })
    if (hidden.timedOut) return { pass: false, detail: '隐藏用例超时（30s）' }
    if (hidden.status !== 0) {
      const fails = failLines(hidden.stdout)
      return {
        pass: false,
        detail: `test.js 过了但隐藏用例失败（退出码 ${hidden.status}，${fails.length} 项）：${fails.slice(0, 4).join('；') || hidden.stderr.trim().split('\n').slice(-1)[0] || '无 FAIL 行'}`,
      }
    }

    const okHidden = hidden.stdout.split('\n').filter(l => l.startsWith('OK')).length
    return { pass: true, detail: `复跑 test.js 通过；隐藏用例 ${okHidden} 项全过；agent 退出码 ${exitCode}` }
  },
}
