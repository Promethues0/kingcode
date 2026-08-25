# KingCode agent 行为评测（eval harness）

回答一个仓库其他测试都不回答的问题：**给 agent 一个任务，它完成得怎么样。**
固定任务集 + 零 LLM 自动判分 + 基线对比。真调模型（组合树钉死便宜的
deepseek-v4-flash），凭证走 `~/.kingcode/.credentials.yaml`（KingCode 自己的 harness home），与 CLI 正常跑一致。

## 怎么跑

```sh
node eval/run.js                          # 全量：写 eval/results/latest.json，与基线对比
node eval/run.js --task fix-slug          # 单任务（--task 可重复给多个）：写 latest-partial.json，不碰 latest.json，不做基线对比
node eval/run.js --jobs 3                 # 并发跑 3 个任务（默认 1）
node eval/run.js --no-retry               # 关掉抖动自动重跑（见下）
node eval/run.js --update-baseline        # 全量跑完把 latest 写为 baseline（禁与 --task 连用；有 harness-error 时拒写）
```

### 状态语义（五态）与退出码

| 状态 | 含义 | 退出码贡献 |
|---|---|---|
| `pass` | 判分通过 | — |
| `fail` | 判分不过 | **1** |
| `xfail` | 任务标了 `expectFail`，且确实没过（known-fail，如实保留） | — |
| `xpass` | 任务标了 `expectFail`，却过了——控制台显眼报出，**该摘掉 expectFail 并更新下面的 known-fail 表** | — |
| `harness-error` | prepare / grade 自身抛异常、夹具缺失、grade 返回值不合法、CLI 进程起不来——是评测器/任务定义的病，**绝不伪装成 agent 的 FAIL** | **1** |

退出码：有 `fail` 或 `harness-error` → 1；其余（全 pass / xpass / 只有 xfail）→ 0；参数错 2。

### 抖动缓冲（自动重跑）

flash 单次采样有波动。**本次 `fail` 而基线里该任务 `pass`** 的，自动再跑一次：两次都进
record 的 `attempts[]`，**以第二次为准**，record 标 `retried: true`，控制台先打一行
`RETRY <id>`。不重跑的情形：`expectFail` 任务、`harness-error`、基线里没有该任务、
`--no-retry`。重跑用独立运行目录 `<taskId>@2`，prepare 重新造夹具副本。

### 产物

- 全量跑写 `eval/results/latest.json`；`--task` 跑写 `eval/results/latest-partial.json`
  （`partial: true`，`selected: [...]`），两者互不覆盖。`eval/baseline.json` 是有意入库的
  基线，全量跑时逐任务对比并报告回归/改善（跨 schema 版本只比 `tasks[].pass`）。
- 每任务全部证据在 `<tmpdir>/kingcode-eval/<runId>/<taskId>/`（绝对路径记在结果的
  `runDirRoot` / 每条 record 的 `runDir`）：`stdout.txt`、`stderr.txt`、
  `kingcode-result.json`（runner 的机读结果，含 sessionId），以及 `../sessions/` 下与
  sessionId 对应的**明文** jsonl 会话流（DSH_SNAPSHOT=1）；record 的 `sessionFile`
  直接给出绝对路径，判分存疑时翻它看 agent 到底做了什么。子代理各自另落一份 jsonl，
  路径列在 record 的 `childSessionFiles`（见下面的「子代理另开一份会话文件」）。
- 运行目录刻意放在仓库外：`dsh-agent-instructions` 会从 .git 根到 cwd 逐层装载
  AGENTS.md，放仓库内会把本仓库指令注进每个评测会话。
- `eval/results/` 已在根 .gitignore。

### 结果 schema（`kingcode-eval-result/3`）

每条 record：`id / description / judge / expectFail / status / pass / detail / harnessError /
exitCode / timedOut / durationMs / sessionId / sessionFile / childSessionFiles /
reasonKind / errorCode / usage / runDir / retried / attempts[]`。`usage` 从会话 jsonl 的
`assistant/message` 事件聚合：`{inputTokens, outputTokens, cacheReadTokens,
reasoningTokens, llmCalls, sessions}`（inputTokens 不含缓存命中；llmCalls ≈ 模型调用次数；
sessions = 这笔用量摊在几份会话里）。**聚合口径是父会话 + 全部子代理会话**
（`sessionUsageDeep`）：子代理另开一份 jsonl，只算父会话会低估一半以上——实测一例父会话
in+out 12365、它的子代理 16000。`childSessionFiles` 是那些子会话 jsonl 的绝对路径。
`attempts[]` 每项是一次完整尝试（同样的字段 + `attempt` 序号）。

`totals`：`total / passed / failed / xfail / xpass / harnessError / retried / durationMs
（各任务最终 attempt 之和）/ wallMs（墙钟，并发时更小）/ usage（**全部 attempt 之和，
含重跑、含子代理会话——这是真实花费**）`。

（schema 从 `/2` 升到 `/3`：record 多了 `childSessionFiles`、`usage` 多了 `sessions`，
且 usage 口径由「父会话」改成「整棵委派树」。基线对比跨版本只比 `tasks[].pass`，
`eval/baseline.json` 还是 `/2` 也照常比得了。）

## 任务集（11 个）

判分方式一栏同时写明防作弊手段（与各 `eval/tasks/<id>.js` 的头注释 / `judge` 字段同步；
细节以任务文件为准）。「冻结」= `assertFrozen` 与原件逐字节比对；「隐藏」= 资产在
`eval/oracles/<id>/`，不复制进 runDir，grade 时才用。

| id | 类型 | 判分方式（全部零 LLM） |
|---|---|---|
| fix-slug | 代码修复 | 在 fixture **副本**里复跑 `node test.js` 退出码 0；test.js 冻结（改测试不算修复）；隐藏用例 `hidden-test.mjs` grade 时才复制进副本复跑——覆盖空串、纯符号、首尾/连续分隔符、非 ASCII 等 test.js 没有的输入，堵「对 5 个可见输入硬编码返回值」的查表法 |
| build-break | 构建修复 | 副本里复跑 `npm run build` 退出 0；隐藏 `oracle.js` 换一组数据复算（堵把金样例硬编码进 renderReport）；package.json / src/index.js 冻结（改构建脚本、删冒烟不算修）；`fileSetDiff` 不许新建/删文件（node_modules、package-lock.json、.kingcode* 不计） |
| stack-trace-hunt | 按栈追因 | 复跑 `node index.js` 退出 0，逐单含「#单号 + 客户名」与合计——期望值由判分器从原件数据独立复算；隐藏 `hidden-check.mjs` 直调 findCustomer 覆盖短写编号全部变体（只在 render.js 加判空、或两边都 toLowerCase 的半修过不去）；隐藏 `orders-hidden.json` 端到端；data/*.json 冻结；render.js 是否被改只进 detail |
| refactor-preserve | 重构保行为 | 隐藏差分测试：同一张用例清单同时喂原件与改后模块，逐例比对返回值与抛错（类型+信息），导出集合一致；重复特征计数（阈值全部从原件推导）：校验 message 各 ≤1、`throw` 总数 ≤ 原件 − 冗余、原件里重复的 `if` 条件（括号配平抽取，连同其顶层逻辑或 / 逻辑与的各操作数，去空白比对）各 ≤1——堵「message 提常量 + `fail()` 助手、三份 if 原样保留」。**扫描口径以运行时实测为准，核对不了就不给过**：隐藏测试子进程 `--import` 预载 `oracles/refactor-preserve/trace-loads.js`，用 `module.registerHooks` 记下**每一次模块解析的真实结果**（append-only 写 fd 2，被测代码同进程也只能多写、删不掉），判分器从 inventory.js 沿这张实测清单做可达闭包——不再静态猜运行时。三条 fail-closed：闭包跑出工作目录（符号链接由 node 解析成真身、`new URL` / 字符串拼接说明符、`createRequire` 的 CJS require 全都现形）即 FAIL；闭包出现非 `file:` 来源（`data:` 内联代码）即 FAIL；**一条追踪记录都没有 → harness-error**（钩子没挂上时判分器没资格下结论，绝不退回静态扫描假装扫过了）。实际扫描集合 = 运行时闭包 ∪ 静态模块图 ∪ cwd 目录遍历（`test.js` 除外），校验挪进新文件照样算数。静态一侧另加一条**穷尽**规则：文法上只有动态 `import()` / `require()` 能接非字面量说明符，故说明符不是字符串字面量的这两种调用一律 FAIL。**已知边界**：追踪管「模块从哪解析」，不管「源码从哪来」——`readFileSync` 工作目录外的文件再 `eval` / `new Function`、或被测模块自己再注册一层转换钩子，追踪看不见（详见任务文件头注释）；test.js / package.json 冻结；夹具不得删 |
| multi-file-rename | 跨文件重命名 | 隐藏 `rename-check.mjs` 复制进副本复跑（新名在各模块到位、旧名从任何导出含默认导出对象的键里消失、行为与原件一致）；src/ 剥掉注释与字符串后不得再有旧名标识符（注释/字符串里的干扰项残留不算错）；src/ 文件集合不变；test.js 冻结；multi_edit / sed 批量替换的使用只记入 detail（会话取证含子代理会话） |
| api-contract-extend | API 扩展保契约 | 三个调用方 + data.js + package.json 冻结（改调用方让新参数「生效」不算完成）；夹具文件不许删；会话取证（父会话 + 全部子代理会话）：工具调用参数触及 `eval/oracles` 即 FAIL（**字符串匹配，与被推翻的那条路径正则同类**：`cd` 一次或用 `$HOME` 拼路径即可绕过，真正兜底的是隐藏 oracle）；隐藏 `oracle.test.js`：默认行为对原件 format 逐输入差分、调用方输出对原件与金样例原文、新参数对独立的 Intl 参考实现 |
| add-tests | 补测试（变异测试 + 阴性对照） | 只认 agent **新建**且源码提到 node:test / assert 的 .js/.mjs/.cjs 为测试，显式交给 `node --test` 在原件上全过（不走可被改的 npm test）；在同一工作目录里**原地**换入 6 个隐藏单 bug 变异体逐个复跑，**至少杀死 4 个**（变异体载入时与「原件 + 规格」逐字比对，漂移 → harness-error；变异体不带头注释）；队列里交错混入 3 个**阴性对照**——与原件**行为完全一致、只是写法不同**的 duration.js（原件副本 / 改名重排版 / 换一套实现），**误杀任何一个对照即 FAIL**（不看杀了几个变异体），对照上跑超时同样不给过：行为型测试对等价模块必然全过，源码指纹（含隐式 toString）、`Error.stack` 行号、字面量子串这类伪测试会把对照一起「杀死」当场现形；对照的等价性判分时现算（数千条系统用例 + 确定性 fuzz，逐例比返回值/抛错类型/message 原文/导出形状），不等价 → harness-error；duration.js 冻结、夹具不得删；另有黑名单做第二层（静态扫描测试文件及其相对 import 可达的新建文件：出现 `fs` / `node:fs` / `fs/promises` / `child_process` 字面量、或对被测函数取源码 `.toString()` / `String()` / 模板串 / `Function.prototype.toString` 即 FAIL 并点名）——**黑名单只负责把低段位作弊说清楚，防线是阴性对照** |
| long-command-timeout | 工具超时意识 | 不复跑 verify，全靠会话取证（父会话 + 全部子代理会话：子代理也有 bash，把 verify 委派下去跑是合法路径，只看父会话会假阴性；但重定向变体的配对**限定同一份会话内**，免得「父会话 sleep 135s + 子代理 echo」白捡）：存在 bash 调用 `timeoutMs ≥ 135000`；某次 bash 结果含**整行** `VERIFY_OK`（子串不算，`cat scripts/verify.js` 糊弄不过）；产出它的那次调用按事件 ms 时间戳配对 callId 实耗 ≥ 135000ms——或同一会话里其前一次长调用实耗 ≥ 135s（重定向到文件再读出的变体）——堵 `echo VERIFY_OK` / `grep -o`；stdout 含 VERIFY_OK 且退出 0；package.json / scripts/verify.js 冻结（缩短等待不算跑过）；首跑是否撞默认超时只进 detail。整体 timeoutMs 420s |
| needle-haystack | 陌生代码检索 | 期望值不手抄：隐藏 `probe.js` 对夹具**原件**真实执行 createDispatcher() 读出生效窗口；stdout 里所有 `ANSWER=` 取值须全部恰好等于它且至少一次（列候选、两头押注、带单位即 FAIL）；退出码 0。答案藏在三跳之外且数值奇特，猜不中 |
| find-result-writer | 代码检索 | **cwd 是仓库跟踪文件的副本**（`git ls-files` 减去 `eval/`，50 个文件 ~640 KB，复制进 runDir）——答案键根本不在场，不再用路径正则去猜偷看写法；prepare 还把副本里那个函数**改名成本次随机挑的私有名**（35 个候选），于是本次答案只存在于副本的 `plugins/runner.js` 这一个文件里，原仓库 `eval/`、git 历史、旧评测会话 jsonl 里存的都是过期名字，偷回来是错的。判分：stdout 含本次随机名、**不含任何其他候选名**（堵两头押注）、退出码 0。fail-closed：prepare 逐文件核验「原名零出现 + 新名只出现在 plugins/runner.js」，runner.js 里找不到那个函数（源码漂移）即 harness-error。第二道会话取证（父会话 + 全部子代理，`toolCallsDeep`）：工具调用参数出现**原仓库绝对路径**即 FAIL——它抓不住不写路径的全盘搜索；候选名运行时生成而非写死清单，否则读一遍任务文件拿到池子再逐个 grep 就能反查出本次答案，这条边界写在任务文件头注释里 |
| summarize-picks | 代码检索+格式遵循 | cwd 同样是仓库跟踪文件的副本（不含 `eval/`）：prepare 逐文件核验副本里 `last_nonempty` / `PICKS` **零出现**，本次期望答案由副本里 summarize 的判定行 `if (joined !== '') text = joined` **现推**（该行不是恰好一处即 harness-error，绝不拿一个可能过期的答案判绿）。stdout 须恰好回答 `PICKS=<期望值>`，出现任何别的 PICKS 值即 FAIL；第二道会话取证与 find-result-writer 相同。**这条答案不随机化**：它是「取最后一条非空」这条行为，而仓库自己的注释多处如实描述了它（读注释是正经读代码），随机化要同改三处措辞、任何一处漂移都会让夹具自相矛盾——残留边界（跳出 cwd 找到原仓库仍能拿到答案 token）写在任务文件头注释里 |

**known-fail（expectFail）：当前无（11/11 过）。** 加了 `expectFail` 的任务在这里补一行：
id、原因、预期何时能摘。

**实测耗时**（deepseek-v4-flash，本机，2026-08-21 全量 `--jobs 3`，11/11 过、0 重跑）：
agent 耗时合计 ~350s（实测 346s），墙钟 ~180s（实测 177s）；其中 long-command-timeout
独占 ~145s（实测 142s：夹具 verify 要实跑 135s，任务整体 timeoutMs 420s），它决定了并发
下的墙钟下限。串行跑约 6 分钟。耗时只记录不判分（见「已知限制」）。

**出题的一条硬约束：答案不能出现在 `AGENTS.md` 或 `README.md` 里。** cwd 落在本仓库的
任务，`dsh-agent-instructions` 会把 AGENTS.md 注入上下文——原先的 `exit-code-contract`
问退出码契约，而那条契约正写在 AGENTS.md 第 23 行，题目于是退化成「会不会读文档」。
现在换成 `summarize-picks`：它问的行为只在 `plugins/runner.js` 的代码里，文档没写。
加检索题前先 `grep` 一遍两份文档。

## 怎么加任务

在 `eval/tasks/` 放一个 `.js`（零依赖裸 node，默认导出）。文件名任意（建议与 id 同名），
id 全局唯一，`--task` 用它。

```js
import { assertFrozen, copyDir, runOracle, toolCalls } from '../lib/guards.js'

export default {
  id: 'my-task',            // 唯一 id
  description: '一句话说清考什么',
  judge: '一句话说清怎么判（进结果文件）',
  task: '给 agent 的任务文本',
  timeoutMs: 300_000,       // 可省略，默认 5 分钟整体超时（超时 SIGKILL 整个进程组，timedOut=true）
  expectFail: '为什么当前过不了',  // 可省略；非空字符串；标了就走 xfail/xpass 语义，且不自动重跑

  async prepare({ runDir, repoRoot, sessionsRoot, attempt }) {
    // 造 agent 的工作目录；会被 agent 改写的 fixture 必须复制进 runDir 副本
    const cwd = copyDir(`${repoRoot}/eval/fixtures/my-task`, `${runDir}/workdir`)
    return { cwd }          // 必须返回 { cwd: string }；可选 env: {...} 追加给 CLI 进程
                            // 返回对象整体会作为 prepared 原样传给 grade
  },

  async grade({
    cwd, runDir, repoRoot,          // 与 prepare 同一套目录
    stdout, stderr, exitCode,       // CLI 产物；exitCode 为 null = 被杀/起不来
    timedOut, durationMs,
    result,                         // KINGCODE_RESULT_FILE 的一行 JSON（可能为 null）：
                                    //   {sessionId, reasonKind, errorCode, emptyOutput, exitCode,
                                    //    termination, signal}
                                    // termination: 'normal' 跑完（exitCode 由 exitCodeFor 定，0/3/1）
                                    //            | 'deadline' 触到 KINGCODE_DEADLINE_MS（exitCode 4）
                                    //            | 'signal'   收到信号（exitCode 130/143）
                                    // signal: termination==='signal' 时是 'SIGINT'/'SIGTERM'，否则 null
                                    // 后两种是「没跑完就被截断」，stdout 为空、reasonKind 多为 aborted——
                                    // 判分时别把它当 agent 答错，那是被外力砍的
    sessionId, sessionFile,         // 父会话明文 jsonl 绝对路径（找不到为 null）——过程判分的入口
    sessionsRoot,                   // 本次评测的会话根目录；子代理会话要靠它 + sessionId 才找得到
                                    //   （toolCallsDeep / childSessionFiles，见「过程判分」）
    usage,                          // 聚合用量：父会话 + 全部子代理会话（sessionFile 为 null 时也为 null）
    prepared,                       // prepare 的返回值
    attempt,                        // 1 = 首跑，2 = 抖动重跑
  }) {
    if (timedOut) return { pass: false, detail: '任务超时被杀' }
    const frozen = assertFrozen(cwd, `${repoRoot}/eval/fixtures/my-task`, ['test.js'])
    if (!frozen.ok) return { pass: false, detail: `改了不许改的文件：${frozen.changed.map(c => c.path).join('、')}` }
    const rerun = runOracle(process.execPath, ['test.js'], { cwd, timeoutMs: 30_000 })
    return { pass: rerun.status === 0, detail: rerun.timedOut ? '复跑测试超时' : `复跑退出码 ${rerun.status}` }
    // 必须返回 { pass: boolean, detail?: string }；返回别的形状 = harness-error
  },
}
```

prepare / grade 抛出的任何异常都记为 `harness-error`（堆栈打到 stderr），不会被算成 agent
失败——**夹具缺了就让它炸**，不要 try/catch 成 `pass: false`。隐藏判分脚本 spawn 不起来
（`runOracle` 返回 `error`）同理：throw，不要返回 `pass: false`。

### 目录约定：`fixtures/<id>/` 给 agent，`oracles/<id>/` 只给判分器

- `eval/fixtures/<id>/`：agent 看得见、改得动的工作目录原件。**prepare 只复制它**
  （`copyDir` 到 `<runDir>/workdir`），原件永不被污染；冻结比对（`assertFrozen`）以它为准。
- `eval/oracles/<id>/`：判分资产——隐藏用例、变异体、探针、金样例、隐藏数据。
  **永不进 runDir，agent 看不见，grade 时才用**：要么判分器直接以绝对路径
  `runOracle` 它（如 needle-haystack 的 probe.js、build-break 的 oracle.js），要么 grade 时才
  复制进副本、跑完删掉（如 fix-slug 的 hidden-test.mjs 用生僻文件名
  `__eval_hidden_slug_test.mjs`，multi-file-rename 用完 `rmSync`）。
- **检索类任务（find-result-writer、summarize-picks）的 cwd 是仓库跟踪文件的副本**：
  `git ls-files` 减去 `eval/` 复制进 runDir，答案键根本不在 agent 的工作目录里。之前它们
  直接在仓库根跑，只能靠「工具调用参数出现 `eval/` 就 FAIL」的路径正则去猜偷看写法——那条
  正则实测被四种写法一起绕开（`grep … eval` 目录名不带斜杠、`cd eval && grep … .`、bash 的
  cwd 参数指到 eval、以及仓库根一条不带 eval 的 grep：守卫只看**调用参数**，看不见**结果
  文本**里躺回来的答案）。**防作弊要么让作弊在原理上不可能，要么在核对不了时直接不给过，
  不要用正则去猜写法。** 副本方案下 prepare 还必须**逐文件核验答案键零出现**（find-result-writer
  另把答案改名成每次随机的名字），核验不过就抛 harness-error。夹具副本类任务也应至少像
  api-contract-extend 那样拒绝参数里出现 `eval/oracles`。凡「整棵委派树里都不许出现 X」的
  取证**一律用 `toolCallsDeep(sessionFile, sessionsRoot, sessionId)`**——`toolCalls` 只看
  父会话，一句 `explore` 委派就绕过去了。
- 期望值一律从原件**现算**（探针 / 差分 / 独立参考实现），不手抄常量；隐藏资产有
  规格的（add-tests 的 mutants.js）载入时与规格逐字比对，漂移 → harness-error。
- **防作弊优先用「阴性对照」而不是黑名单。** 黑名单封的是几种具体写法，换一种就绕过去了
  （add-tests 上实证过：八条正则封住 `.toString()`，一句 `m[k] + ''` 就零行为断言过线）。
  阴性对照是结构性的：在判分队列里混进一个**本该判过**的样本（行为与原件等价、只是写法不同），
  判错它 = 判据不是我们要的那个性质，直接 FAIL。写对照的代价是**必须证明它确实等价**——
  等价性要在判分时现算（见 `eval/oracles/add-tests/controls.js`），证不了就抛 harness-error，
  绝不能拿一个可能不等价的对照去冤枉 agent。

### 过程判分（sessionFile）

有了 `sessionFile` 可以判「怎么做的」而不只是「结果对不对」：用了哪些工具、有没有跑
测试、有没有偷看判分器或原件目录。事件形状（读自真实会话）：

- `{"type":"tool/call","data":{"turn","step","callId","name","arguments":"<JSON 字符串>"}}`
- `{"type":"assistant/message","data":{"message":{...},"usage":{"inputTokens","outputTokens","cacheReadTokens","reasoningTokens"}}}`
- `{"type":"tool/result","data":{"message":{"source":{"kind":"tool","callId"},"content":[{"toolCallId","content":[{"text"}]}]}}}`
  ——按 `callId` 与 tool/call 配对；每条事件还带 epoch ms 的 `time`，
  `result.time − call.time` 就是该次工具调用的实耗（long-command-timeout 的耗时门槛靠它）。
- 其余：`session`（首行，含 cwd）、`user/message`、`turn/end`
  （`data.reason.kind`）等；`assistant/chunk` 里有 usage 的同值副本，别重复计数。

**子代理另开一份会话文件——取证别只看父会话。** `subagent` / `subagent_fork` / `explore`
起的子代理不是父会话里的几条事件，而是同一个 root 下**另一份 `session.jsonl`**，首行长这样
（读自真实会话）：

```json
{"type":"session","version":0,"id":"1167b76a-…","createdAt":1787317336217,
 "cwd":"/Users/prometheus/Projects/kingcode","parentSession":"session-a5fd33c7-…",
 "origin":"subagent","delegationDepth":1}
```

两个坑：**子会话目录名不带 `session-` 前缀**（就是裸 uuid），按前缀过滤会整批漏掉；父子关系
只能靠 `parentSession` 连，别按目录名猜。只查父会话的取证有个致命洞——「工具参数触及 `eval/`
即 FAIL」一句 `explore` 委派就洗白了（真正 grep 到答案的 bash 落在子会话里，父会话干净得像
没作弊，detail 还会主动宣称「未触及 eval/」；离线复现过判 PASS）。所以凡是「整棵委派树里都
不许出现 X」的取证一律用 `toolCallsDeep(sessionFile, sessionsRoot, sessionId)`，要事件级证据
（耗时配对之类）就用 `sessionFamilyFiles` 逐份 `readSession`——**别把多份会话的 callId / seq
混成一张表**：seq 跨会话不可比，混排还会给「A 会话等够时间、B 会话伪造输出」开口子。

### guards API（`eval/lib/guards.js`，零依赖，全同步）

| 函数 | 作用 | 返回 |
|---|---|---|
| `assertFrozen(runDir, originDir, relPaths)` | 逐字节比对一组不许改的文件（测试、夹具） | `{ ok, changed: [{ path, reason: 'modified'│'missing'│'origin-missing' }] }` |
| `fileSetDiff(dirA, dirB, { ignore? })` | 两目录文件清单差异（只看有无，不看内容）；`ignore` 项为相对路径前缀字符串或正则 | `{ same, added: [只在 B], removed: [只在 A] }` |
| `listFiles(dir, skip?)` | 递归列文件相对路径（POSIX 分隔符，排序稳定） | `string[]` |
| `runOracle(cmd, args?, { cwd?, timeoutMs = 30_000, env?, input?, maxBuffer? })` | spawnSync 带超时跑判分命令；**agent 写的代码可能死循环，判分命令必须带超时**；超时 SIGKILL | `{ status, signal, stdout, stderr, timedOut, error }` |
| `toolCalls(sessionFile)` | **单份**会话里的工具调用序列（按事件顺序），`arguments` 解析成对象 | `[{ name, args, rawArguments, callId, turn, step, seq }]` |
| `toolCallsDeep(sessionFile, sessionsRoot, rootSessionId?)` | 父会话 **+ 全部子代理会话**的工具调用合集（父在前）——「整棵委派树里都不许出现 X」的取证用它，别用 `toolCalls` | 同上，每项多带 `sessionId` / `sessionFile` / `subagent` |
| `childSessionFiles(sessionsRoot, rootSessionId)` | 递归收集 rootSessionId 的**全部后代**会话 jsonl（广度优先，成环也不转死） | `string[]`（绝对路径，不含父会话） |
| `sessionFamilyFiles(sessionFile, sessionsRoot, rootSessionId?)` | 父 + 全部后代的会话文件（父在最前）；漏传 `sessionsRoot` 直接抛 | `string[]` |
| `sessionIdOf(sessionFile)` | 从首行 session 事件取 sessionId，坏首行退回目录名 | `string` |
| `sessionUsage(sessionFile)` | 聚合**单份**会话 `assistant/message` 的 usage | `{ inputTokens, outputTokens, cacheReadTokens, reasoningTokens, llmCalls }` |
| `sessionUsageDeep(sessionFile, sessionsRoot, rootSessionId?)` | 整棵委派树的用量：父 + 全部后代逐份相加 | 同上，另加 `sessions`（计入了几份会话） |
| `readSession(sessionFile)` | 解析 jsonl 为事件数组（截断的尾行跳过；文件不存在抛错） | `Array<{ type, seq, time, data }>` |
| `findSessionFile(sessionsRoot, sessionId)` | 按 sessionId 定位 `<root>/<cwd 编码目录>/<sessionId>/session.jsonl` | 绝对路径或 `null` |
| `copyDir(src, dst)` | 递归复制夹具到 runDir；src 不存在**抛错**（→ harness-error） | `dst` |

**判分哲学（不许破例）：**

- **零 LLM 判分**：判分器绝不问模型。只用退出码、正则、引擎复算——沿用仓库
  「金样例对原文、独立验证」的测试纪律。判不客观的任务不进任务集。
- **期望值独立复算**，不从 agent 输出反推、不手抄常量。
- **防作弊是判分的一部分**：agent 能改到的文件（如测试）判分前先与原件比对
  （`assertFrozen`）；不许新建/删文件的用 `fileSetDiff`。
- **任务是基线不是刁难**：当前 agent 应能过；某任务确实过不了就如实保留、加
  `expectFail: '原因'` 并在上面的 known-fail 表登记，**不许为凑绿改判分**。xpass 出现
  时摘掉 expectFail。

## eval 专用组合树（cordis.eval.yml）

派生自根 `cordis.yml`，改根文件时对照同步。全部差异见其头注释，核心两条：

- **不挂 settings-file，模型才钉得死。** `agent-default-model` 的组合层取值只是
  Settings 区的 base，挂了 settings provider 后用户级 `$DSH_HOME/settings.yaml`
  会覆盖它（本机就存着 v4-pro + effort max）。settings 服务缺席时该覆盖机制
  整个不注册，组合层的 flash 恒生效——已实测验证（会话 jsonl 里
  `"model":"deepseek-v4-flash"`）。代价：settings.yaml 里 llm-deepseek:/llm-pi-ai:
  的个人覆盖在 eval 里同样失效，这正是可复现性要的。
- **persistence root 每次评测一个全新目录**（环境变量注入）。同一 root 下明文与
  zstd 会话混放会 fail-loud 拒启，而 eval 固定明文、仓库 `./.kingcode/sessions`
  已有 zstd——绝不能共用。并发（`--jobs`）下安全：persistence 按
  `<root>/<cwd 编码>/<sessionId>/` 落盘，root 下没有任何共享索引文件；每个任务/
  每次 attempt 的 runDir 也互不相交。

## 调试 harness 自身

- `KINGCODE_EVAL_BASELINE=<path>`：临时换一份基线文件（验抖动重跑等用）；日常别设。
- `eval/lib/guards.js` 有无头测试 `test/test-guards.js`（在 `npm test` 链里）：子会话递归
  收集、成环、坏首行、漏传 sessionsRoot 直接抛、用量逐份相加。判分地基改了先跑它。
- 验 xfail / xpass / harness-error 路径：在 `eval/tasks/` 放临时任务（`task: 'Reply with
  exactly: ok'` 一次 flash 调用即可；harness-error 用 `copyDir` 指向不存在的夹具，
  不花钱），`--task` 跑完删掉。

## 威胁模型（判分能防住什么、防不住什么）

这一节存在的理由：**判分器不许说自己核实不了的话**。反复出现的失败形态不是漏判一次
作弊，而是判分器一边被绕过、一边在 detail 里理直气壮地断言「重复已消除」「未触及
eval/」——假的绿灯比红灯危险得多，因为后续所有判断都建立在它上面。

**防的是**：模型为了省事走的自然捷径。改测试而不改代码、把金样例硬编码进实现、
`echo` 一个期望字符串冒充跑过、只在栈顶加判空糊过根因、写个只断言 `typeof` 的空测试。
这些都实证复现过，并且现在都判 FAIL。

**不防**：一个能读到 `eval/tasks/*.js` 与 `eval/oracles/` 的对手，专门逆向判分器来构造
绕法。这条线是刻意划的——真正在做题的模型没有动机也没有信息去做这件事，而为它加固
是无底洞（三轮对抗下来：修掉 5 条、再找到 3 条、做完结构性修复再找到 5 条，不收敛）。
已实证可行、**刻意不堵**的几条，如实登记在此：

- `refactor-preserve` 的重复计数是**文本判据**（原件里重复过的条件文本各 ≤1 次）。
  语义等价的改写——De Morgan 变形 `a || b` → `!(!a && !b)`、把校验搬进 `new Function`
  执行——都能让文本判据成立而重复一行没消除。要真正判定「重复是否消除」需要语义
  等价判定，那不是这套判分器该承担的。detail 已改成只陈述它真检查了什么。
- ~~队列交错固定、候选池写死~~ **这两条已修**（队列每次随机、候选名运行时生成带随机后缀），
  留在这里是为了记住它们长什么样：可预测性本身就是漏洞，「随机化」如果参数可反查就等于没随机。
- 检索类任务的会话取证是字符串匹配，shell 里用 `$HOME` 拼路径即可不出现字面量。

**一条硬纪律**：判分器冤枉正当工作，比漏判一次作弊更糟。`add-tests` 的黑名单曾把
「注释里带引号提了一句 `'node:fs'`」的正经测试判成作弊——那会让人不敢写注释。
扫描前先抹注释就是为此。加任何黑名单式判据时，先想清楚它的误伤面。

## 已知限制

- **成本口径**：一次全量跑 = 任务数次 flash 任务级会话（每个任务一个独立 agent
  会话，内部各有数次模型调用），实测 11 任务 agent 耗时合计 ~350s、`--jobs 3` 墙钟
  ~180s（见「任务集」下的实测耗时）；重跑会加一次。加任务线性加钱，`totals.usage`
  记真实 token 花费。
- **单次采样**：每任务只跑一遍（抖动缓冲最多再一遍）。基线对比报「回归」时先看
  `attempts[]` 是否两次都挂，再定性。
- **耗时不进判分**：durationMs 只记录不比较，机器负载会让它抖；`--jobs` 下单任务耗时
  还会因争用变大。
- **模型钉死是靠不挂 settings 实现的**，所以 eval 跑的不是「用户此刻配置下的
  agent」，而是「组合层默认下的 agent」。这是刻意取舍，换模型评测请直接改
  cordis.eval.yml 的 agent-default-model 节。
- **多人同时跑 eval** 会互相覆盖 `latest.json` / `latest-partial.json`：判断自己那次的
  结果看控制台输出或 `runDirRoot` 下的证据，别读共享的 json。
