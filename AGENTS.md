# KingCode 仓库指令

基于 DeepSeek Harness（dsh）的**编程智能体**。不 fork 上游——只做自己的组合树
（cordis.yml）+ 自己的插件（plugins/）+ 自己的 bin。上游处于 developer preview，
版本锁在 package-lock.json，升级前先跑无钥烟测。

## 校验命令

```bash
npm test                # 无头测试（不起 agent、不调模型，无 API key 也能跑）
npm run smoke           # 真发一次模型请求；无钥时应恰好死在 MISSING_CREDENTIAL
npm run eval            # agent 行为评测：真跑任务集并与 eval/baseline.json 对比（真调模型）
npm run check:contrast  # 配色的 WCAG + 红绿色弱守卫（改品牌层时才需要）
```

改动 persona、组合树、runner 之后跑一次 `npm run eval`——无头测试守函数对不对，
eval 守「agent 干得对不对」。判分零 LLM 参与（复跑测试 / 正则 / 独立复算）。

## CLI 退出码契约

`kingcode "<task>"`：**0** = 完成且有回答（回答走 stdout，诊断一律走 stderr）；
**3** = 完成但助手零输出；**1** = 其余（错误/未收敛/参数错）。设
`KINGCODE_RESULT_FILE=<path>` 可额外落一行机读 JSON（sessionId/reasonKind/
errorCode/emptyOutput/exitCode），给 eval harness 判分用。

## 结构要点

- `cordis.yml`：组合树，每行一个插件，**行序即挂载声明序**（fs-observation-policy
  必须先于 tool-fs）。agent-spine-demo 已间接挂载 llm-retry/jobs/skill/invariants/
  shell-env/tool-bash/agent-instructions 等一批插件，**不要重复挂载**。
- `plugins/`：CLI 自有插件。Loader 插件必须具名导出 `name`/`inject`/`apply`
  （default export 会静默丢 inject）。自定义工具照 `multi-edit.js` 写；
  对象 schema 必须显式写 `additionalProperties`。
- **工具返回只有 `output.render` 的文本会进模型上下文**，结构化 value 模型
  看不到——新写工具时 render 必须承载模型所需的全量载荷（超长用 head/tail
  截断并提示细分查询）。
- `eval/`：行为评测。`cordis.eval.yml` 派生自根 `cordis.yml`（改根文件时对照
  同步），刻意不挂 `dsh-settings-file` 以免本机 settings.yaml 盖掉评测模型；
  评测树关掉 `web_search`（真实费用+外部结果扰动），`web_fetch` 保留。
- 子代理三实例：`subagent`（spawn，可用 bash/web）、`subagent_fork`（fork，复用前缀）、
  `explore`（spawn，toolFilter 只留 read/glob/grep 的只读探索者）。全部 one-shot 前台、
  maxDepth 1——一次性 CLI 退出即 dispose 整棵树，后台子代理会连结果一起被带走。
- `plugins/env-context.js` 用 `systemPrompt.context()`（不是 section）注入日期/平台/
  git 状态：context 只在文本变化时重新注入，所以日期不带时分、git 只在 apply 时拍
  一次快照。
- web 能力：`web_search` 走 DeepSeek 的 Anthropic 兼容端点，**复用
  DEEPSEEK_API_KEY**，不引入新密钥；`web_fetch` 只收 http/https、拒 URL 内嵌
  凭证、只跟同源重定向。两工具的 30s 超时靠 timeout-policy 兑现。
- 会话持久化：普通跑落 `.kingcode/sessions`（zstd），`DSH_SNAPSHOT=1` 落
  `.kingcode/sessions-plain`（明文）。**两者不能共用一个 root**，混放会 fail-loud。
- `mac/`、`win/`、`web-brand/`、`profile/`：客户端外壳与品牌层，与 CLI 共用同一棵
  组合树的引擎。
- `cordis.mcp.yml`：MCP 按需树——第一行 `cordis:include` 根树，之后每个 server 一行
  `@deepseek-ai/dsh-mcp-client`（一实例一 server，无 servers 表；工具名
  `mcp__<serverName>__<rawName>`），`kingcode --config cordis.mcp.yml` 启用。server 行
  **必须 `failOnStartupError: true`**：本 CLI 树没有 logger sink，默认 false 的「警一句
  后零工具」在这里是无声的。夹具 `test/fixtures/mcp-echo-server.js` 同时是示例 server
  与 `npm test` 的被测对象；MCP 行不进根树，所以 eval 树也不受影响。
- 测试是零依赖裸 node 脚本（check/eq 模式），纪律：金样例对原文、期望值由
  清单推导不手算、独立第三方回读、不编造补齐数据。

## 几条刻意的决定（不是漏做）

- **dsh 包一律 `npm i -E @deepseek-ai/<pkg>@0.1.0-rc.6`**。`latest` dist-tag 指向
  0.0.1 老线，省略版本会装到与本树不兼容的包。
- **后台执行面在工具层整体关闭**：`toolJobs: false` + `toolBash.enableRunInBackground:
  false` + subagent 走 `one-shot`，`tool-subagent-control`/`-report` 不挂。一次性
  CLI 退出时 dispose 整棵树，树外存活的工作必然被带走；与其让 persona 劝模型别用
  （而工具 schema 和上游提示词都在说「可以用、默认用」），不如让这个状态在结构上
  无法产生。**runner 因此不需要 drain job**——只有将来上持久 shell 或 goal 三件套，
  「树外存活工作」才会重新出现，届时正确做法是给 runner 显式收敛判据 + wall-clock
  预算，而不是无限等待。
- **不挂 plan-mode / ask-user**：它们的退出都需要一个真人审批，`kingcode "<task>"`
  里没有人，挂上只会让模型卡在等待里。
- **Code Mode 未启用**：依赖已从 package.json 移除。要启用需重装
  `dsh-code-runtime-worker-thread` 并给 agent-spine 传 `tools: { mode: both }`，
  且应当用 eval 证明轮数/耗时确有收益再留下。
- **系统提示词的工作纪律在 `plugins/prompt-sections.js`，不在 persona**：persona 有
  三份副本（根树 / eval 树 / profile 补丁），纪律堆在那里必然漂移；且 persona 固定在
  order 0，排在上游工具指导段（100-105）之前，仲裁不了工具取舍。
