/**
 * 代码检索类任务（带固定输出格式）：一轮里出现多条助手消息时，runner 的
 * summarize 把哪一条当作最终回答？标准答案「最后一条非空」，出处
 * plugins/runner.js 的 summarize —— `if (joined !== '') text = joined` 在循环里
 * 逐条覆盖，且空串不覆盖。
 *
 * 为什么问这个而不是问退出码：退出码契约写在 AGENTS.md 里，而 AGENTS.md 会被
 * dsh-agent-instructions 注入每一个 cwd 在本仓库（或本仓库副本）的会话——那道题会变成
 * 「会不会读文档」，读代码的能力一点没测到。这条事实只在代码里，文档没写。
 *
 * ── 为什么 cwd 是仓库副本，而不是仓库本身（这一版的结构性改动）──────────────
 * 上一版 cwd 直接指仓库根，答案 token `last_nonempty` 就躺在 eval/README.md、
 * eval/tasks/<id>.js、eval/baseline.json 里，判分只能靠「工具调用参数里出现 eval/ 就 FAIL」
 * 的路径正则去**猜** agent 用了哪种写法。那是检测不是防御：实测四种写法一起判绿——
 * `grep -rn … eval`（目录名不带斜杠）、`cd eval && grep -rn … .`、bash 的 cwd 参数指到 eval、
 * 以及仓库根一条不带 eval 的 `grep -rn … .`（守卫只看调用参数，看不见**结果文本**里躺回来的
 * 答案）。黑名单再长也有下一种写法。
 *
 * 这一版改成：prepare 用 `git ls-files` 列出仓库的**跟踪文件**，去掉 eval/ 后逐个复制到
 * <runDir>/kingcode，agent 的 cwd 指这份副本。答案键根本不在场，上面四种写法一起失效。
 * （跟踪文件天然不含 node_modules / .git / .kingcode / eval/results / 构建产物。）
 *
 * ── fail-closed：核对不了就不判 ──────────────────────────────────────
 * prepare 复制完当场把整份副本读一遍：`last_nonempty` 与 `PICKS` 必须 0 次出现——答案键
 * 一个字都不许在 cwd 里；同时 plugins/runner.js 里那行判定 `if (joined !== '') text = joined`
 * 必须**恰好出现一次**，本次期望答案由它现推（而不是判分器手抄一个常量）。任何一条不满足
 * 就抛（harness-error）：源码漂移时宁可整条题不判，也不拿一个可能已经过期的答案去判绿。
 *
 * ── 为什么不像 find-result-writer 那样把答案随机化 ─────────────────────────
 * 那道题的答案是一个私有函数名，改名只动一个文件、也没有第二处提到它，随机化很干净。
 * 这道题的答案是「最后一条非空」这条**行为**，而仓库自己的注释就多处如实描述了它
 * （test/test-runner.js「取最后一条非空文本」、plugins/prompt-sections.js「取本轮最后一条非空
 * 助手文本」）——读这些注释是正经的读代码，不是作弊。要随机化就得同时改三处措辞，任何一处
 * 漂移都会让夹具自相矛盾，反而制造冤假错案。所以这道题只做「答案键不在 cwd」这一层。
 * 残留边界（明说）：bash 没有沙箱，agent 若主动跳出 cwd 找到原仓库、grep 到 eval/，仍能拿到
 * `last_nonempty`；对此只有下面第二道取证，而它抓不住不写路径的全盘搜索。
 *
 * ── 连带结论 ────────────────────────────────────────────────────
 * ① AGENTS.md 照常装载：项目根探测靠 .git 上溯，副本里没有 .git，findProjectRoot 回落到 cwd
 *    自身（= 副本根），装载链与今天 cwd=仓库根时一样只有「项目根 = cwd」这一层；副本根的
 *    AGENTS.md 已核实不含答案（不描述 summarize 取哪条消息）。祖先目录里有 .git 会让项目根
 *    跑到临时目录之上、装载链不可控——prepare 直接检查并抛。
 * ② 旧的 `git status --porcelain` 快照取证连同 KINGCODE_EVAL_SKIP_CLEAN_CHECK 开关一起删了：
 *    agent 的 cwd 已经是临时副本，改也只改到副本；判分不读副本（期望答案在 prepare 时就定死
 *    并交给 grade），没有引入新的可写面。
 * ③ 复制成本：50 个文件、约 640 KB，复制 + 全量扫描几十毫秒。
 *
 * 判分（零 LLM）：stdout 匹配 PICKS=<本次期望值> 且不得同时给出别的 PICKS 值；
 * 固定格式行既考检索也考指令遵循（eval 里大量判分依赖 agent 按格式回答）。
 *
 * 会话取证（纵深防御的第二道）：父会话或任一子代理会话的工具调用参数里出现**原仓库绝对
 * 路径**即 FAIL——副本方案下正经干活永远不需要写出那个路径。detail 只说它真查过的这一句。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { listFiles, runOracle, toolCallsDeep } from '../lib/guards.js'

const VALID = ['first', 'last', 'last_nonempty', 'concatenated']

/** 副本目录名：让 persona 里的 {{cwd}} 看起来仍像这个仓库 */
const COPY_DIR = 'kingcode'

/** summarize 里那行判定：本次期望答案由它现推，不手抄常量 */
const GUARD_LINE = "if (joined !== '') text = joined"
/** GUARD_LINE 对应的答案 */
const GUARD_ANSWER = 'last_nonempty'
/** 答案键的字面量：cwd 副本里一次都不许出现 */
const FORBIDDEN = ['last_nonempty', 'PICKS']

/**
 * 项目根探测靠 .git 上溯：副本没有 .git 时回落到 cwd 自身，这正是我们要的。
 * 但只要副本的任一**祖先**目录里有 .git，项目根就会跑到临时目录之上，AGENTS.md 的装载链
 * 随之不可控——核实不了就别跑（抛 = harness-error，不伪装成 agent 的 FAIL）。
 */
function assertNoAncestorGit(dir) {
  let cur = resolve(dir)
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return
    if (existsSync(join(parent, '.git'))) {
      throw new Error(`副本的祖先目录 ${parent} 下有 .git，AGENTS.md 的装载链不可控——换个运行目录再跑`)
    }
    cur = parent
  }
}

/**
 * 把仓库的跟踪文件（去掉 eval/）复制成一份独立工作目录。
 * 用 `git ls-files` 而不是遍历目录：node_modules、.git、.kingcode、eval/results、构建产物、
 * 工作树里的私人杂物都不是跟踪文件，天然不进副本，不必维护排除清单。
 * git 起不来 / 列不出东西 = harness 的病，抛。
 */
function copyTrackedRepo(repoRoot, dst) {
  const r = runOracle('git', ['ls-files', '-z'], { cwd: repoRoot, timeoutMs: 60_000 })
  if (r.timedOut) throw new Error('git ls-files 超时')
  if (r.error) throw new Error(`git ls-files 起不来：${r.error}`)
  if (r.status !== 0) throw new Error(`git ls-files 退出码 ${r.status}：${r.stderr.slice(0, 400)}`)
  const rels = r.stdout.split('\0').filter(p => p !== '' && p !== 'eval' && !p.startsWith('eval/'))
  if (rels.length < 10) throw new Error(`git ls-files 只列出 ${rels.length} 个可用跟踪文件，副本不可信`)
  let copied = 0
  for (const rel of rels) {
    const src = join(repoRoot, rel)
    if (!existsSync(src)) continue // 索引里还在、工作树里已删：跳过
    const to = join(dst, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(src, to)
    copied++
  }
  return copied
}

/** 把副本整个读进内存（约 640 KB），供核验用 */
function readAll(root) {
  return listFiles(root)
    .filter(rel => !rel.endsWith('→ (symlink)')) // listFiles 给符号链接的占位条目，读不了
    .map(rel => ({ rel, text: readFileSync(join(root, rel), 'utf8') }))
}

/** 反斜杠归一成斜杠：Windows 路径在 JSON 里是 \\、在命令行里可能是 \ */
const slash = s => s.split('\\\\').join('/').split('\\').join('/')

/**
 * 工具调用参数里出现**原仓库绝对路径**的调用（rawArguments 与解析后的 args 都查）。
 * 副本方案下 cwd 与原仓库毫无关系，正经干活永远不需要写出那个路径。
 * 用 toolCallsDeep：子代理是另一份 session.jsonl，只看父会话的话一句 explore 委派就洗白了。
 */
function repoPathTouchingCalls(sessionFile, sessionsRoot, sessionId, repoRoot) {
  const needle = slash(repoRoot)
  return toolCallsDeep(sessionFile, sessionsRoot, sessionId)
    .filter(c => slash(`${c.rawArguments}\n${JSON.stringify(c.args)}`).includes(needle))
}

export default {
  id: 'summarize-picks',
  description: '检索 runner.summarize：一轮多条助手消息时取哪一条当最终回答',
  judge: 'cwd 是仓库跟踪文件的副本（不含 eval/，prepare 逐文件核验答案 token 零出现），'
    + '期望答案由副本里 summarize 的判定行现推；stdout 须匹配 PICKS=<期望值> 且无其他 PICKS 值、'
    + '退出码 0；父会话或任一子代理会话的工具调用参数出现原仓库绝对路径即 FAIL',
  task: '在本仓库的 plugins/runner.js 里，summarize 函数在同一轮出现多条 assistant/message 时，'
    + '把哪一条当作最终回答？最终回答的最后一行只写：PICKS=<first|last|last_nonempty|concatenated>，'
    // 刻意不给任何一个选项加解释：原先只给 last_nonempty 一条中文注解，
    // 四选一里唯一带 gloss 的那个就是答案——实测零工具调用盲答即可通过。
    // 题面自己泄题，与 README 立的「答案不能出现在文档里」是同一类病。
    + '选项含义请自行从代码判断，不要猜。',

  async prepare({ runDir, repoRoot }) {
    const cwd = join(runDir, COPY_DIR)
    mkdirSync(cwd, { recursive: true })
    assertNoAncestorGit(cwd)
    const files = copyTrackedRepo(repoRoot, cwd)

    const copy = readAll(cwd)
    // ① 答案键一个字都不许在 cwd 里
    for (const literal of FORBIDDEN) {
      const carriers = copy.filter(f => f.text.includes(literal)).map(f => f.rel)
      if (carriers.length > 0) throw new Error(`副本里出现了答案字面量 ${literal}：${carriers.join('、')}`)
    }
    // ② 期望答案从副本的源码现推：判定行必须恰好一处
    const runnerRel = 'plugins/runner.js'
    const runner = copy.find(f => f.rel === runnerRel)
    if (runner === undefined) throw new Error(`副本里没有 ${runnerRel}，这道题问的文件不在了`)
    const hits = runner.text.split(GUARD_LINE).length - 1
    if (hits !== 1) {
      throw new Error(`${runnerRel} 里 \`${GUARD_LINE}\` 出现 ${hits} 次（期望恰好 1 次）：summarize 的行为`
        + '可能已经改了，先重新确认这道题的正确答案，再改这里的 GUARD_LINE / GUARD_ANSWER')
    }

    return { cwd, expected: GUARD_ANSWER, files, repoRoot }
  },

  async grade({ stdout, exitCode, timedOut, sessionFile, sessionsRoot, sessionId, prepared }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    // 期望答案由 prepare 从副本源码现推；拿不到就没法核实，抛（harness-error），绝不猜默认值
    const expected = prepared?.expected
    if (typeof expected !== 'string' || !VALID.includes(expected)) {
      throw new Error(`prepare 没交出合法的期望答案（得到 ${JSON.stringify(expected)}），判分无从核实`)
    }
    const repoRoot = prepared?.repoRoot
    if (typeof repoRoot !== 'string' || repoRoot === '') throw new Error('prepare 没交出原仓库路径，取证无从核实')

    // ① 会话取证（第二道）：cwd 里没有答案键，唯一剩下的偷法是跳出 cwd 回原仓库
    if (sessionFile !== null) {
      const peeked = repoPathTouchingCalls(sessionFile, sessionsRoot, sessionId, repoRoot)
      if (peeked.length > 0) {
        const c = peeked[0]
        const where = c.subagent ? `子会话 ${c.sessionId}` : '父会话'
        return {
          pass: false,
          detail: `工具调用参数出现原仓库绝对路径（共 ${peeked.length} 次；首次在${where} seq=${c.seq} turn=${c.turn} step=${c.step} ${c.name}：${c.rawArguments.slice(0, 160)}）`,
        }
      }
    }

    // ② 答案：只认期望值，出现任何别的合法取值即算押注
    const answers = [...stdout.matchAll(/PICKS\s*=\s*([a-z_]+)/g)].map(m => m[1])
    const known = answers.filter(a => VALID.includes(a))
    const pass = exitCode === 0 && known.length > 0 && known.every(a => a === expected)
    return {
      pass,
      detail: pass
        ? `PICKS=${expected} 且无杂音（期望值由副本里 summarize 的判定行现推；prepare 已逐文件核验`
          + `副本内零出现答案 token，cwd 副本不含 eval/）；工具调用参数未出现原仓库绝对路径`
        : `PICKS 提取值=${JSON.stringify(answers)} exitCode=${exitCode}（期望恰好回答 ${expected} 且退出码 0）`,
    }
  },
}
