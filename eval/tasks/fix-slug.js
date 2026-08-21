/**
 * 代码修复类任务：fixture 里 slugify 缺 toLowerCase，npm test 五项全挂。
 * agent 在 fixture 的**副本**上干活（prepare 每次全量复制，原件永不被污染）。
 *
 * 判分（零 LLM）：
 * ① 判分器自己在副本里跑 `node test.js`，退出码 0 才算修好；
 * ② test.js 必须与夹具原件逐字节一致——改测试不算修复（金样例纪律）。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'fix-slug',
  description: '修复 slugify 缺小写导致的 5 项测试失败（禁改 test.js）',
  judge: '判分器复跑 node test.js 看退出码 + test.js 与原件逐字节比对',
  task: '这个项目的测试挂了。请先运行 npm test 看失败原因，然后修复源码让全部测试通过。'
    + '不要修改 test.js（判分会校验它与原件一致）。修好后再跑一次测试确认，最后简要说明你改了什么。',

  async prepare({ runDir, repoRoot }) {
    const cwd = join(runDir, 'workdir')
    mkdirSync(cwd, { recursive: true })
    cpSync(join(repoRoot, 'eval', 'fixtures', 'fix-slug'), cwd, { recursive: true })
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }

    const original = readFileSync(join(repoRoot, 'eval', 'fixtures', 'fix-slug', 'test.js'), 'utf8')
    const after = readFileSync(join(cwd, 'test.js'), 'utf8')
    if (after !== original) {
      return { pass: false, detail: 'test.js 被改动——改测试不算修复' }
    }

    const rerun = spawnSync(process.execPath, ['test.js'], { cwd, encoding: 'utf8', timeout: 30_000 })
    const testsPass = rerun.status === 0
    return {
      pass: testsPass,
      detail: testsPass
        ? `复跑测试通过；agent 退出码 ${exitCode}`
        : `复跑测试仍失败（退出码 ${rerun.status}）：${(rerun.stdout ?? '').split('\n').filter(l => l.startsWith('FAIL')).join('；') || '无 FAIL 行'}`,
    }
  },
}
