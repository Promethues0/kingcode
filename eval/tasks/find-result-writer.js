/**
 * 代码检索类任务：问仓库一个确切事实——runner 里把机读结果写进
 * KINGCODE_RESULT_FILE 的那个私有函数叫什么名字（出处 plugins/runner.js）。
 *
 * ── 为什么 cwd 是仓库副本，而不是仓库本身（这一版的结构性改动）──────────────
 * 上一版 cwd 直接指仓库根，答案字面量就躺在 eval/README.md、eval/tasks/<id>.js、
 * eval/baseline.json 里，判分只能靠「工具调用参数里出现 eval/ 就 FAIL」的路径正则去**猜**
 * agent 用了哪种写法。那是检测不是防御：实测四种写法一起判绿——
 *   ① `grep -rn KINGCODE_RESULT_FILE eval`（目录名做位置参数，不带斜杠，正则要求分隔符）
 *   ② `cd eval && grep -rn … .`（斜杠落在 `.` 上）
 *   ③ bash 的 cwd 参数指到 eval，命令里只写 `.`
 *   ④ 仓库根一条 `grep -rn -A2 KINGCODE_RESULT_FILE .`（参数里连 eval 都没有，答案随
 *      **结果文本**回到上下文——守卫只看调用参数，根本看不见）
 * 黑名单再长也有下一种写法。
 *
 * 这一版改成：prepare 用 `git ls-files` 列出仓库的**跟踪文件**，去掉 eval/ 后逐个复制到
 * <runDir>/kingcode，agent 的 cwd 指这份副本。答案键根本不在场，上面四种写法一起失效，
 * 判分器也不必再猜任何写法。（跟踪文件天然不含 node_modules / .git / .kingcode /
 * eval/results / 各平台构建产物——它们都在 .gitignore 里。）
 *
 * ── 再加一道：本次答案是随机生成的 ────────────────────────────────────
 * 副本解决「cwd 里躺着答案」，解决不了「跳出 cwd 去原仓库偷看」（bash 没有沙箱）。
 * 所以 prepare 顺手把副本里那个函数改名成一个每次随机挑的、同样像仓库私有命名的名字
 * （候选 35 个，见 CANDIDATES）：**本次答案只存在于副本的 plugins/runner.js 这一个文件里**。
 * 原仓库的 eval/、git 历史、任何一次旧评测留下的会话 jsonl 里存的都是上一个名字，
 * 偷回来是错的。也就是说这道题不再有「答案键」可偷——唯一的真相源就是题目让它读的那个文件。
 *
 * ── fail-closed：核对不了就不判 ──────────────────────────────────────
 * prepare 复制完当场把整份副本读一遍并核验：原函数名必须 0 次出现（证明改名彻底，
 * 也证明没有第二处提到它），新名字必须**只**出现在 plugins/runner.js。任何一条不满足就抛
 * （harness-error），绝不带着一个自己核实不了的前提去判分；runner.js 里找不到那个函数
 * （源码漂移）同样抛，而不是继续拿一个可能已经过期的答案去判。
 *
 * ── 连带结论（副本方案的三个后果，逐条核实过）────────────────────────────
 * ① AGENTS.md 照常装载：dsh-agent-instructions 从 cwd 上溯找 .git 定项目根，副本里没有
 *    .git，findProjectRoot 回落到 cwd 本身（= 副本根），装载链与今天 cwd=仓库根时一样只有
 *    「项目根 = cwd」这一层；副本根有 AGENTS.md（跟踪文件），照常注入——已核实它不含答案
 *    （不出现函数名，也不描述 summarize 取哪条消息）。唯一会变的情形是副本的**祖先目录**
 *    里有 .git：项目根会跑到临时目录之上，装载链不可控——prepare 直接检查并抛。
 * ② 旧的 `git status --porcelain` 快照取证连同 KINGCODE_EVAL_SKIP_CLEAN_CHECK 开关一起删了：
 *    它防的是「agent 改了仓库」，而现在 agent 的 cwd 是临时副本，改也只改到副本；判分不读
 *    副本（本次答案在 prepare 时就定死并交给 grade），没有引入新的可写面。
 * ③ 复制成本：跟踪文件去掉 eval/ 后 50 个文件、约 640 KB，复制 + 全量扫描都在几十毫秒量级。
 *
 * 判分（零 LLM）：stdout 含本次随机函数名（\b 边界）、不含任何别的候选名（堵「列一串候选
 * 两头押注」）、退出码 0。
 *
 * 会话取证（纵深防御的第二道，不再是唯一一道）：cwd 里已经没有可偷的东西，剩下的唯一偷法
 * 是跳出 cwd 去原仓库。所以谓词换成一句判分器**真能核实**的话：父会话或任一子代理会话的
 * 工具调用参数里出现原仓库绝对路径即 FAIL。它抓不住不写路径的全盘搜索（`find / -name …`
 * 之类）——这条边界就写在这里，detail 里也只说它真查过的那一句。判分器说一句自己核实不了
 * 的话，比漏判更糟。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { listFiles, runOracle, toolCallsDeep } from '../lib/guards.js'

/** 副本目录名：让 persona 里的 {{cwd}} 看起来仍像这个仓库 */
const COPY_DIR = 'kingcode'

/** 仓库里那个函数的现名——只用来做「改名前后」的核验，不是本次答案 */
const ORIGINAL = 'writeResultFile'
/** 现名在 runner.js 里的出现次数下限（当前 6 次：1 处定义 + 5 处调用）。低于它 = 源码漂移，抛 */
const MIN_HITS = 3

/**
 * 本次答案的候选池：运行时生成，**不是写死的清单**。
 *
 * 写死的池子让随机化可以被反查：读一遍这个文件拿到全部候选，再在副本里逐个 grep，
 * 恰好命中一个就是本次答案——全程不理解一行代码。实证过。名字带一段每次都变的
 * 后缀之后，池子不再是「读得到就能穷举」的有限集合。
 * 其余候选仍用来堵押注式回答（stdout 里出现多个候选即 FAIL）。
 */
function makeCandidates() {
  const tag = Math.random().toString(36).slice(2, 6) // 每次不同的 4 位后缀
  return ['write', 'emit', 'dump', 'flush', 'persist', 'record']
    .flatMap(verb => ['ResultFile', 'RunResult', 'MachineResult', 'ResultRecord', 'ExitRecord', 'OutcomeFile']
      .map(noun => verb + noun + tag.charAt(0).toUpperCase() + tag.slice(1)))
    .filter(name => name !== ORIGINAL)
}

/** 洗牌（Fisher–Yates）：候选的挑选顺序每次都不同 */
function shuffled(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 项目根探测靠 .git 上溯：副本没有 .git 时会回落到 cwd 自身，这正是我们要的。
 * 但只要副本的任一**祖先**目录里有 .git，项目根就会跑到临时目录之上，AGENTS.md 的装载链
 * 随之变得不可控——核实不了就别跑（抛 = harness-error，不伪装成 agent 的 FAIL）。
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
 * 用 `git ls-files` 而不是遍历目录：node_modules、.git、.kingcode、eval/results、
 * 各平台构建产物、以及工作树里的私人杂物都不是跟踪文件，天然不进副本，不必维护排除清单。
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

/** 把副本整个读进内存（约 640 KB），供改名与核验用 */
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
  id: 'find-result-writer',
  description: '检索 plugins/runner.js：写机读结果文件的函数叫什么名字',
  judge: 'cwd 是仓库跟踪文件的副本（不含 eval/），副本里那个函数被改名成本次随机生成的私有名——'
    + '答案只存在于副本的 plugins/runner.js。stdout 须含该名、不含任何其他候选名、退出码 0；'
    + '父会话或任一子代理会话的工具调用参数出现原仓库绝对路径即 FAIL',
  task: '在本仓库的 plugins/runner.js 中，进程退出前把机读结果写入 KINGCODE_RESULT_FILE '
    + '指定路径的那个函数叫什么名字？回答必须包含确切的函数名。',

  async prepare({ runDir, repoRoot }) {
    const cwd = join(runDir, COPY_DIR)
    mkdirSync(cwd, { recursive: true })
    assertNoAncestorGit(cwd)
    const files = copyTrackedRepo(repoRoot, cwd)

    const copy = readAll(cwd)
    // 本次答案：挑一个副本里还完全不存在的候选名，免得改名后撞上别处的既有标识符
    const candidates = makeCandidates()
    const answer = shuffled(candidates).find(name => copy.every(f => !f.text.includes(name)))
    if (answer === undefined) throw new Error('候选函数名在副本里全都撞了名，选不出本次答案')

    const runnerRel = 'plugins/runner.js'
    const runner = copy.find(f => f.rel === runnerRel)
    if (runner === undefined) throw new Error(`副本里没有 ${runnerRel}，这道题问的文件不在了`)
    const hits = runner.text.split(ORIGINAL).length - 1
    if (hits < MIN_HITS) {
      throw new Error(`${runnerRel} 里 ${ORIGINAL} 只出现 ${hits} 次（期望 ≥ ${MIN_HITS}）：源码漂移，`
        + '先确认这道题问的还是不是同一个函数，再改这里的 ORIGINAL')
    }
    runner.text = runner.text.split(ORIGINAL).join(answer)
    writeFileSync(join(cwd, runnerRel), runner.text)

    // fail-closed 核验：原名在副本里必须绝迹；本次答案只许出现在 plugins/runner.js
    const leftover = copy.filter(f => f.text.includes(ORIGINAL)).map(f => f.rel)
    if (leftover.length > 0) throw new Error(`副本里还留着原函数名 ${ORIGINAL}：${leftover.join('、')}`)
    const carriers = copy.filter(f => f.text.includes(answer)).map(f => f.rel)
    if (carriers.length !== 1 || carriers[0] !== runnerRel) {
      throw new Error(`本次答案 ${answer} 在副本里出现于 ${JSON.stringify(carriers)}，只该出现在 ${runnerRel}`)
    }

    return { cwd, answer, candidates, files, repoRoot }
  },

  async grade({ stdout, exitCode, timedOut, sessionFile, sessionsRoot, sessionId, prepared }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    // 本次答案由 prepare 定死；拿不到就没法核实，抛（harness-error），绝不猜一个默认值
    const answer = prepared?.answer
    if (typeof answer !== 'string' || answer === '') throw new Error('prepare 没交出本次答案名，判分无从核实')
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

    // ② 答案：只认本次随机名，出现任何别的候选名即算押注
    const named = new RegExp(`\\b${answer}\\b`).test(stdout)
    const others = (prepared.candidates ?? []).filter(name => name !== answer && new RegExp(`\\b${name}\\b`).test(stdout))
    const pass = named && others.length === 0 && exitCode === 0
    return {
      pass,
      detail: pass
        ? `答案含本次随机函数名 ${answer} 且退出码 0（该名只存在于副本的 plugins/runner.js，`
          + `prepare 已逐文件核验；cwd 副本不含 eval/）；工具调用参数未出现原仓库绝对路径`
        : `named=${named} 其他候选=${JSON.stringify(others)} exitCode=${exitCode}（期望只含 ${answer} 且退出码 0）`,
    }
  },
}
