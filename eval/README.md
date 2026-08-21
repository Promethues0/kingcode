# KingCode agent 行为评测（eval harness）

回答一个仓库其他测试都不回答的问题：**给 agent 一个任务，它完成得怎么样。**
固定任务集 + 零 LLM 自动判分 + 基线对比。真调模型（组合树钉死便宜的
deepseek-v4-flash），凭证走 `~/.dsh/.credentials.yaml`，与 CLI 正常跑一致。

## 怎么跑

```sh
node eval/run.js                        # 全量（4 个任务 ≈ 4 次模型会话，实测 ~35s）
node eval/run.js --task fix-slug        # 单任务
node eval/run.js --update-baseline      # 全量跑完把 latest 写为 baseline（禁与 --task 连用）
```

- 退出码：全过 0，任一 FAIL 1，参数错 2。
- 汇总写 `eval/results/latest.json`（**最近一次调用**的口径，单任务跑会带
  `partial: true`）；`eval/baseline.json` 是有意入库的基线，存在时逐任务对比并
  报告回归/改善。
- 每任务的全部证据落在 `eval/results/runs/<runId>/<taskId>/`：`stdout.txt`、
  `stderr.txt`、`kingcode-result.json`（runner 的机读结果，含 sessionId），以及
  `../sessions/` 下与 sessionId 对应的**明文** jsonl 会话流（DSH_SNAPSHOT=1），
  判分存疑时直接翻会话看 agent 到底做了什么。
- `eval/results/` 与 `eval/runs/` 已在根 .gitignore；`eval/baseline.json` 有意入库。

## 任务集（3 个）

| id | 类型 | 判分方式（全部零 LLM） |
|---|---|---|
| fix-slug | 代码修复 | 判分器在 fixture **副本**里复跑 `node test.js` 看退出码；test.js 须与原件逐字节一致（改测试不算修复） |
| find-result-writer | 代码检索 | stdout 正则匹配 `writeResultFile` 且退出码 0（答案是仓库私有命名，猜不出，只能读代码） |
| summarize-picks | 代码检索+格式遵循 | stdout 恰好回答 `PICKS=last_nonempty`，出现任何别的 PICKS 值即 FAIL |

**出题的一条硬约束：答案不能出现在 `AGENTS.md` 或 `README.md` 里。** cwd 落在本仓库的
任务，`dsh-agent-instructions` 会把 AGENTS.md 注入上下文——原先的 `exit-code-contract`
问退出码契约，而那条契约正写在 AGENTS.md 第 23 行，题目于是退化成「会不会读文档」。
现在换成 `summarize-picks`：它问的行为只在 `plugins/runner.js` 的代码里，文档没写。
加检索题前先 `grep` 一遍两份文档。

## 怎么加任务

在 `eval/tasks/` 放一个 `.js`（零依赖裸 node，默认导出）：

```js
export default {
  id: 'my-task',            // 唯一 id，--task 用它
  description: '一句话说清考什么',
  judge: '一句话说清怎么判（进结果文件）',
  task: '给 agent 的任务文本',
  timeoutMs: 300_000,       // 可省略，默认 5 分钟整体超时
  async prepare({ runDir, repoRoot }) {
    // 造 agent 的工作目录；会被 agent 改写的 fixture 必须复制进 runDir 副本
    return { cwd: /* agent 的 cwd */ }
  },
  async grade({ cwd, runDir, repoRoot, stdout, stderr, exitCode, timedOut, result }) {
    // result 是 KINGCODE_RESULT_FILE 的一行 JSON（可能为 null）
    return { pass: true, detail: '判分依据一句话' }
  },
}
```

**判分哲学（不许破例）：**

- **零 LLM 判分**：判分器绝不问模型。只用退出码、正则、引擎复算——沿用仓库
  「金样例对原文、独立验证」的测试纪律。判不客观的任务不进任务集。
- **期望值独立复算**，不从 agent 输出反推、不手抄常量。
- **防作弊是判分的一部分**：agent 能改到的文件（如测试）判分前先与原件比对。
- **任务是基线不是刁难**：当前 agent 应能过；某任务确实过不了就如实保留并在
  本节标注 known-fail，**不许为凑绿改判分**。当前无 known-fail（3/3 过）。

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
  已有 zstd——绝不能共用。

## 已知限制

- **成本口径**：一次全量跑 = 4 次 flash 任务级会话（每个任务一个独立 agent
  会话，内部各有数次模型调用），实测全量 ~35s。加任务线性加钱。
- **单次采样**：每任务只跑一遍，flash 的波动会体现为偶发 FAIL。判分设计上
  容忍格式噪音（正则宽松处见各任务注释），但结论性波动只能靠重跑分辨——
  基线对比报「回归」时先重跑确认再定性。
- **耗时不进判分**：durationMs 只记录不比较，机器负载会让它抖。
- **模型钉死是靠不挂 settings 实现的**，所以 eval 跑的不是「用户此刻配置下的
  agent」，而是「组合层默认下的 agent」。这是刻意取舍，换模型评测请直接改
  cordis.eval.yml 的 agent-default-model 节。
