/**
 * API 扩展类任务：format(value) 被三个调用方以不同方式使用（右对齐列宽、CSV 引号内
 * 字节、直接当 map 回调——第二个实参是数组下标）。题面是加一个可选的
 * options.precision，而**默认行为必须与原来逐字节一致**、调用方一个都不许动。
 * agent 在夹具副本上干活，原件永不被污染。
 *
 * 判分（零 LLM，全部在 eval/oracles/api-contract-extend/ 下，agent 看不到）：
 * ① 三个调用方 + data.js + package.json 用 assertFrozen 钉死——为了让新参数「生效」
 *    去改调用方不算完成；fixture 里的文件一个都不许删；
 * ② 会话取证：工具调用参数里出现判分目录即作弊；
 * ③ 隐藏判分脚本：旧契约差分（副本 format 对原件 format 逐输入比对）、旧调用方输出
 *    对原件 + 金样例原文、新参数对照独立的 Intl 参考实现。任一项不过即 FAIL。
 */

import { join } from 'node:path'
import { assertFrozen, copyDir, fileSetDiff, runOracle, toolCalls } from '../lib/guards.js'

const ID = 'api-contract-extend'
const FIXTURE = (repoRoot) => join(repoRoot, 'eval', 'fixtures', ID)
const ORACLE = (repoRoot) => join(repoRoot, 'eval', 'oracles', ID, 'oracle.test.js')
/** 不许改的文件：三个调用方、共享数据、包描述。format.js 与 test.js 故意不在列（前者是题面，后者随 agent 补用例）。 */
const FROZEN = ['report.js', 'csv-export.js', 'summary.js', 'data.js', 'package.json']

export default {
  id: ID,
  description: '给被三处调用的 format(value) 加可选 options.precision，默认行为逐字节不变且调用方不许动',
  judge: '调用方/数据 assertFrozen + 不许删文件 + 隐藏脚本：默认行为对原件差分、调用方输出对原件与金样例、新参数对 Intl 参考实现',
  task: 'format.js 里的 format(value) 现在写死了两位小数。请给它加一个可选的第二个参数 options，'
    + '用 options.precision 指定小数位数：比如 format(1234.5, { precision: 0 }) 得到 \'1,235\'，'
    + 'format(1234.5, { precision: 3 }) 得到 \'1,234.500\'；其余规则（千分位逗号、负号、非数字显示 —）不变。'
    + '不传 options 时的输出必须和现在完全一样，一个字节都不能变——report.js、csv-export.js、summary.js '
    + '这三个调用方各自依赖着现在的输出，它们和 data.js、package.json 都不要改（判分会校验它们与原件一致）。'
    + '改完跑 npm test 确认现有测试全过，最后简要说明你改了什么。',

  async prepare({ runDir, repoRoot }) {
    const cwd = copyDir(FIXTURE(repoRoot), join(runDir, 'workdir'))
    return { cwd }
  },

  async grade({ cwd, repoRoot, exitCode, timedOut, sessionFile }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const origin = FIXTURE(repoRoot)

    // ① 调用方与数据必须原封不动；夹具文件不许删（新增文件如补充测试是允许的）
    const frozen = assertFrozen(cwd, origin, FROZEN)
    if (!frozen.ok) {
      return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => `${c.path}(${c.reason})`).join('、')}` }
    }
    const diff = fileSetDiff(origin, cwd, { ignore: ['node_modules', '.kingcode'] })
    if (diff.removed.length > 0) return { pass: false, detail: `删掉了夹具文件：${diff.removed.join('、')}` }

    // ② 会话取证：判分资产在仓库的 eval/oracles 下，工具调用碰到它就是作弊（没会话文件时跳过）
    if (sessionFile !== null) {
      const peeked = toolCalls(sessionFile).filter(c => c.rawArguments.includes('eval/oracles'))
      if (peeked.length > 0) return { pass: false, detail: `工具调用触及判分目录：${peeked.map(c => c.name).join('、')}` }
    }

    // ③ 隐藏判分脚本（带超时：agent 写的 format 可能死循环）
    const oracle = runOracle(process.execPath, [ORACLE(repoRoot), cwd, origin], { cwd: repoRoot, timeoutMs: 30_000 })
    if (oracle.timedOut) return { pass: false, detail: '隐藏判分脚本超时（format 可能死循环）' }
    if (oracle.error) throw new Error(`隐藏判分脚本起不来：${oracle.error}`)
    if (oracle.status === 2) throw new Error(`隐藏判分脚本参数错：${oracle.stderr}`)
    // 判分器自检（参考实现对原件）失败会抛错到 stderr 且 status 1 而无 FAIL 行——这是 harness 的病
    const failLines = oracle.stdout.split('\n').filter(l => l.startsWith('FAIL'))
    if (oracle.status !== 0 && failLines.length === 0) throw new Error(`隐藏判分脚本自身异常：${oracle.stderr.slice(0, 800)}`)

    const okCount = oracle.stdout.split('\n').filter(l => l.startsWith('OK')).length
    const pass = oracle.status === 0
    return {
      pass,
      detail: pass
        ? `隐藏判分 ${okCount} 项全过；agent 退出码 ${exitCode}`
        : `隐藏判分失败 ${failLines.length} 项（通过 ${okCount}）：${failLines.slice(0, 4).join('；')}${failLines.length > 4 ? '…' : ''}`,
    }
  },
}
