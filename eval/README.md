# KingCode agent 行为评测（eval harness）

回答一个仓库其他测试都不回答的问题：**给 agent 一个任务，它完成得怎么样。**
固定任务集 + 零 LLM 自动判分 + 基线对比。真调模型（组合树钉死便宜的
deepseek-v4-flash），凭证走 `~/.dsh/.credentials.yaml`，与 CLI 正常跑一致。

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
  直接给出绝对路径，判分存疑时翻它看 agent 到底做了什么。
- 运行目录刻意放在仓库外：`dsh-agent-instructions` 会从 .git 根到 cwd 逐层装载
  AGENTS.md，放仓库内会把本仓库指令注进每个评测会话。
- `eval/results/` 已在根 .gitignore。

### 结果 schema（`kingcode-eval-result/2`）

每条 record：`id / description / judge / expectFail / status / pass / detail / harnessError /
exitCode / timedOut / durationMs / sessionId / sessionFile / reasonKind / errorCode /
usage / runDir / retried / attempts[]`。`usage` 从会话 jsonl 的 `assistant/message`
事件聚合：`{inputTokens, outputTokens, cacheReadTokens, reasoningTokens, llmCalls}`
（inputTokens 不含缓存命中；llmCalls ≈ 模型调用次数）。`attempts[]` 每项是一次完整
尝试（同样的字段 + `attempt` 序号）。

`totals`：`total / passed / failed / xfail / xpass / harnessError / retried / durationMs
（各任务最终 attempt 之和）/ wallMs（墙钟，并发时更小）/ usage（**全部 attempt 之和，
含重跑——这是真实花费**）`。

## 任务集（11 个）

判分方式一栏同时写明防作弊手段（与各 `eval/tasks/<id>.js` 的头注释 / `judge` 字段同步；
细节以任务文件为准）。「冻结」= `assertFrozen` 与原件逐字节比对；「隐藏」= 资产在
`eval/oracles/<id>/`，不复制进 runDir，grade 时才用。

| id | 类型 | 判分方式（全部零 LLM） |
|---|---|---|
| fix-slug | 代码修复 | 在 fixture **副本**里复跑 `node test.js` 退出码 0；test.js 冻结（改测试不算修复）；隐藏用例 `hidden-test.mjs` grade 时才复制进副本复跑——覆盖空串、纯符号、首尾/连续分隔符、非 ASCII 等 test.js 没有的输入，堵「对 5 个可见输入硬编码返回值」的查表法 |
| build-break | 构建修复 | 副本里复跑 `npm run build` 退出 0；隐藏 `oracle.js` 换一组数据复算（堵把金样例硬编码进 renderReport）；package.json / src/index.js 冻结（改构建脚本、删冒烟不算修）；`fileSetDiff` 不许新建/删文件（node_modules、package-lock.json、.kingcode* 不计） |
| stack-trace-hunt | 按栈追因 | 复跑 `node index.js` 退出 0，逐单含「#单号 + 客户名」与合计——期望值由判分器从原件数据独立复算；隐藏 `hidden-check.mjs` 直调 findCustomer 覆盖短写编号全部变体（只在 render.js 加判空、或两边都 toLowerCase 的半修过不去）；隐藏 `orders-hidden.json` 端到端；data/*.json 冻结；render.js 是否被改只进 detail |
| refactor-preserve | 重构保行为 | 隐藏差分测试：同一张用例清单同时喂原件与改后模块，逐例比对返回值与抛错（类型+信息），导出集合一致；重复特征计数（阈值全部从原件推导，扫 cwd 全部 .js、test.js 除外，校验挪进新文件也算数）：校验 message 各 ≤1、`throw` 总数 ≤ 原件 − 冗余、原件里重复的 `if` 条件（括号配平抽取，连同其顶层逻辑或 / 逻辑与的各操作数，去空白比对）各 ≤1——堵「message 提常量 + `fail()` 助手、三份 if 原样保留」；test.js / package.json 冻结；夹具不得删 |
| multi-file-rename | 跨文件重命名 | 隐藏 `rename-check.mjs` 复制进副本复跑（新名在各模块到位、旧名从任何导出含默认导出对象的键里消失、行为与原件一致）；src/ 剥掉注释与字符串后不得再有旧名标识符（注释/字符串里的干扰项残留不算错）；src/ 文件集合不变；test.js 冻结；multi_edit / sed 批量替换的使用只记入 detail |
| api-contract-extend | API 扩展保契约 | 三个调用方 + data.js + package.json 冻结（改调用方让新参数「生效」不算完成）；夹具文件不许删；会话取证：工具调用参数触及 `eval/oracles` 即 FAIL；隐藏 `oracle.test.js`：默认行为对原件 format 逐输入差分、调用方输出对原件与金样例原文、新参数对独立的 Intl 参考实现 |
| add-tests | 补测试（变异测试） | 只认 agent **新建**且源码提到 node:test / assert 的 .js/.mjs/.cjs 为测试，显式交给 `node --test` 在原件上全过（不走可被改的 npm test）；换入 6 个隐藏单 bug 变异体逐个复跑，**至少杀死 4 个**（变异体载入时与「原件 + 规格」逐字比对，漂移 → harness-error；变异体不带头注释）；duration.js 冻结、夹具不得删；静态扫描测试文件及其相对 import 可达的新建文件：出现 `fs` / `node:fs` / `fs/promises` / `child_process` 字面量、或对被测函数取源码（`.toString()` / `String()` / 模板串 / `Function.prototype.toString`）即 FAIL 并点名——堵「readFileSync 源码断言子串」的伪测试 |
| long-command-timeout | 工具超时意识 | 不复跑 verify，全靠会话取证：存在 bash 调用 `timeoutMs ≥ 135000`；某次 bash 结果含**整行** `VERIFY_OK`（子串不算，`cat scripts/verify.js` 糊弄不过）；产出它的那次调用按事件 ms 时间戳配对 callId 实耗 ≥ 135000ms——或其前一次长调用实耗 ≥ 135s（重定向到文件再读出的变体）——堵 `echo VERIFY_OK` / `grep -o`；stdout 含 VERIFY_OK 且退出 0；package.json / scripts/verify.js 冻结（缩短等待不算跑过）；首跑是否撞默认超时只进 detail。整体 timeoutMs 420s |
| needle-haystack | 陌生代码检索 | 期望值不手抄：隐藏 `probe.js` 对夹具**原件**真实执行 createDispatcher() 读出生效窗口；stdout 里所有 `ANSWER=` 取值须全部恰好等于它且至少一次（列候选、两头押注、带单位即 FAIL）；退出码 0。答案藏在三跳之外且数值奇特，猜不中 |
| find-result-writer | 代码检索 | stdout 正则 `\bwriteResultFile\b` 且退出码 0（仓库私有命名，只能读代码）；cwd 是仓库根不做副本而答案字面量躺在 eval/ 下，所以：工具调用参数（raw 与解析后都查）出现路径形式的 `eval/` 或 `eval\` 即 FAIL（`retrieval/`、`kingcode-eval/` 不误伤）；prepare / grade 各取一次 `git status --porcelain -uall` 快照，有任何行差异即 FAIL（`KINGCODE_EVAL_SKIP_CLEAN_CHECK=1` 可临时关，见下） |
| summarize-picks | 代码检索+格式遵循 | stdout 恰好回答 `PICKS=last_nonempty`，出现任何别的 PICKS 值即 FAIL；会话取证 + 仓库取证与 find-result-writer 完全相同 |

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
                                    //   {sessionId, reasonKind, errorCode, emptyOutput, exitCode}
    sessionId, sessionFile,         // 明文会话 jsonl 绝对路径（找不到为 null）——过程判分的入口
    sessionsRoot,                   // 本次评测的会话根目录
    usage,                          // 该会话聚合用量（sessionFile 为 null 时也为 null）
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
- 凡 cwd 落在本仓库根、不做副本的任务（find-result-writer、summarize-picks），答案字面量
  就躺在 `eval/tasks/<id>.js`、本文件与 `eval/baseline.json` 里，必须加会话取证：工具
  调用参数触及 `eval/` 即 FAIL。夹具副本类任务也应至少像 api-contract-extend 那样拒绝参数里
  出现 `eval/oracles`。
- 期望值一律从原件**现算**（探针 / 差分 / 独立参考实现），不手抄常量；隐藏资产有
  规格的（add-tests 的 mutants.js）载入时与规格逐字比对，漂移 → harness-error。

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

### guards API（`eval/lib/guards.js`，零依赖，全同步）

| 函数 | 作用 | 返回 |
|---|---|---|
| `assertFrozen(runDir, originDir, relPaths)` | 逐字节比对一组不许改的文件（测试、夹具） | `{ ok, changed: [{ path, reason: 'modified'│'missing'│'origin-missing' }] }` |
| `fileSetDiff(dirA, dirB, { ignore? })` | 两目录文件清单差异（只看有无，不看内容）；`ignore` 项为相对路径前缀字符串或正则 | `{ same, added: [只在 B], removed: [只在 A] }` |
| `listFiles(dir, skip?)` | 递归列文件相对路径（POSIX 分隔符，排序稳定） | `string[]` |
| `runOracle(cmd, args?, { cwd?, timeoutMs = 30_000, env?, input?, maxBuffer? })` | spawnSync 带超时跑判分命令；**agent 写的代码可能死循环，判分命令必须带超时**；超时 SIGKILL | `{ status, signal, stdout, stderr, timedOut, error }` |
| `toolCalls(sessionFile)` | 会话里的工具调用序列（按事件顺序），`arguments` 解析成对象 | `[{ name, args, rawArguments, callId, turn, step, seq }]` |
| `sessionUsage(sessionFile)` | 聚合 `assistant/message` 的 usage | `{ inputTokens, outputTokens, cacheReadTokens, reasoningTokens, llmCalls }` |
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
- `KINGCODE_EVAL_SKIP_CLEAN_CHECK=1`：关掉 find-result-writer / summarize-picks 的
  `git status` 快照差分——多个 agent 并行改 eval/ 下文件再真跑验证时，快照前后必然不一致，
  那是环境噪声不是作弊。会话取证（参数触及 eval/）不受影响。日常别设。
- 验 xfail / xpass / harness-error 路径：在 `eval/tasks/` 放临时任务（`task: 'Reply with
  exactly: ok'` 一次 flash 调用即可；harness-error 用 `copyDir` 指向不存在的夹具，
  不花钱），`--task` 跑完删掉。

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
