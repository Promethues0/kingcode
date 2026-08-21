/**
 * 构建修复类任务：一个四文件 ESM 小项目，`npm run build` = 逐文件 node --check +
 * 跑入口冒烟。夹具里埋了两处病：inventory.js 少一个右括号（--check 阶段就炸），
 * report.js import 了 format.js 里不存在的导出名（语法过了、跑入口才炸）。
 * agent 得修完第一处才看得到第二处。
 *
 * 判分（零 LLM）：
 * ① package.json 与入口 src/index.js 必须与原件逐字节一致——改构建脚本 / 删冒烟不算修；
 * ② 不许新建或删除文件（node_modules、package-lock.json、.kingcode* 不计）；
 * ③ 判分器自己在副本里 `npm run build`，退出 0；
 * ④ 隐藏 oracle（eval/oracles/build-break/oracle.js，不复制进 runDir）换一组数据复算，
 *    堵「把金样例硬编码进 renderReport」的绕法。导出侧改名或导入侧改名都算修好。
 */

import { join } from 'node:path'
import { assertFrozen, copyDir, fileSetDiff, runOracle } from '../lib/guards.js'

const FIXTURE = ['eval', 'fixtures', 'build-break']
const ORACLE = ['eval', 'oracles', 'build-break', 'oracle.js']
const FROZEN = ['package.json', 'src/index.js']
// 这些路径不算「新建文件」：agent 顺手 npm install / 评测树自己的 spill 目录
const DIFF_IGNORE = ['node_modules', 'package-lock.json', '.kingcode', '.kingcode-eval']
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** 取命令输出里最像报错的几行塞进 detail：优先带 Error 的行（跳过堆栈 at 行），没有就取尾部 */
const tail = (text, n = 3) => {
  const lines = (text ?? '').split('\n').map(l => l.trimEnd()).filter(Boolean)
  const errs = lines.filter(l => /error/i.test(l) && !/^\s*at /.test(l))
  return (errs.length ? errs : lines).slice(-n).join(' | ')
}

export default {
  id: 'build-break',
  description: '修复让 npm run build 挂掉的语法错误 + 不存在的导出名（禁改构建脚本与入口）',
  judge: '副本里复跑 npm run build 退出 0 + 隐藏 oracle 换数据复算 + package.json/src/index.js 与原件逐字节比对 + 不许新建/删文件',
  task: '这个项目 npm run build 挂了，帮我修好。先跑一下看报错，改源码让构建通过。'
    + '不要动 package.json 里的 build 脚本，也不要改 src/index.js（那是构建入口，判分会校验这两个文件与原件一致），'
    + '也别新建文件。修完再跑一次 npm run build 确认通过，最后简要说明你改了什么。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(join(repoRoot, ...FIXTURE), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const origin = join(repoRoot, ...FIXTURE)

    // ① 不许改的文件
    const frozen = assertFrozen(cwd, origin, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }

    // ② 文件清单不许变
    const diff = fileSetDiff(origin, cwd, { ignore: DIFF_IGNORE })
    if (!diff.same) {
      const parts = []
      if (diff.added.length) parts.push(`新建 ${diff.added.join('、')}`)
      if (diff.removed.length) parts.push(`删除 ${diff.removed.join('、')}`)
      return { pass: false, detail: `文件清单被改：${parts.join('；')}` }
    }

    // ③ 判分器自己跑构建（agent 写的代码可能死循环，必须带超时）
    const build = runOracle(NPM, ['run', 'build'], { cwd, timeoutMs: 60_000 })
    if (build.timedOut) return { pass: false, detail: '复跑 npm run build 超时' }
    if (build.error) throw new Error(`npm 起不来：${build.error}`) // 判分环境问题 → harness-error
    if (build.status !== 0) {
      return { pass: false, detail: `复跑 npm run build 退出码 ${build.status}：${tail(build.stderr) || tail(build.stdout) || '无输出'}` }
    }

    // ④ 隐藏 oracle 换数据复算
    const oracle = runOracle(process.execPath, [join(repoRoot, ...ORACLE), cwd], { cwd, timeoutMs: 30_000 })
    if (oracle.timedOut) return { pass: false, detail: '隐藏 oracle 超时' }
    if (oracle.error) throw new Error(`隐藏 oracle 起不来：${oracle.error}`)
    if (oracle.status !== 0) {
      const fails = oracle.stdout.split('\n').filter(l => l.startsWith('FAIL')).join('；')
      return { pass: false, detail: `构建过了但隐藏 oracle 不过（退出码 ${oracle.status}）：${fails || tail(oracle.stderr) || '无 FAIL 行'}` }
    }

    return { pass: true, detail: `复跑 npm run build 通过，隐藏 oracle 通过；agent 退出码 ${exitCode}` }
  },
}
