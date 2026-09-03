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
**3** = 完成但助手零输出；**4** = 触到 `KINGCODE_DEADLINE_MS`；**130** = SIGINT、
**143** = SIGTERM（Unix 惯例 128+信号号）；**1** = 其余（错误/未收敛/参数错）。
0/3/1 由纯函数 `exitCodeFor` 定（既有测试守着它）；4/130/143 是「没跑完就被截断」，
走 runner 的 `windDown` 另一条路径，**此时 stdout 为空**——只有 0 才意味着有回答。
设 `KINGCODE_RESULT_FILE=<path>` 可额外落一行机读 JSON（sessionId/reasonKind/
errorCode/emptyOutput/exitCode/termination/signal），给 eval harness 判分用；
`termination` ∈ {normal, deadline, signal}，`signal` 只在 signal 时非 null。

## runner 生命周期（stderr 进度流 / 信号 / deadline）

- **进度流默认开，只走 stderr**：runner 订 `session/event`，把工具调用（名 + 截断
  参数）、轮/步边界、`llm/retry` 退避、压缩、收尾摘要逐行打出来，每行带相对起始的
  秒数、无 ANSI、限宽 100。渲染在 `plugins/progress.js`（纯函数，可单测）。
  **stdout 只许有最终回答**，进度绝不能借道那里。`KINGCODE_QUIET=1` 关掉进度流，
  错误诊断不受影响（把真报错也吞掉只会造出新的静默失败）。
- **SIGINT/SIGTERM**：取消 agent（`agent.cancel({kind:'user'})`）→ 最多等 5s 收敛 →
  `sessions.flush` → 按 130/143 退。**第二次同一信号立即硬退**。
- **`KINGCODE_DEADLINE_MS`**：整次调用的墙钟上限，到点走同一条收尾路径、退 4。

## 结构要点

- `cordis.yml`：组合树，每行一个插件，**行序即挂载声明序**（fs-observation-policy
  必须先于 tool-fs）。agent 骨架那一节（timer/llm/session/session-title/
  system-prompt/tools/skill/agent/llm-retry/jobs/invariants ×5/shell-env/
  tool-bash/agent-instructions/tool-skill/agent-loop）是原
  `@deepseek-ai/dsh-agent-spine-demo` 的逐行展开——上游 0.1.2-alpha.3 删掉了那个
  demo 包。**这些行现在归本仓库维护**：加插件前先确认没和这一节撞 id。
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
  `explore`（spawn，toolFilter 只留 read/glob/grep/lsp 的只读探索者）。全部 one-shot 前台、
  maxDepth 1——一次性 CLI 退出即 dispose 整棵树，后台子代理会连结果一起被带走。
- `plugins/env-context.js` 用 `systemPrompt.context()`（不是 section）注入日期/平台/
  git 状态：context 只在文本变化时重新注入，所以日期不带时分、git 只在 apply 时拍
  一次快照。
- web 能力：`web_search` 走 DeepSeek 的 Anthropic 兼容端点，**复用
  DEEPSEEK_API_KEY**，不引入新密钥；`web_fetch` 只收 http/https、拒 URL 内嵌
  凭证、只跟同源重定向。两工具的 30s 超时靠 timeout-policy 兑现。
- 语义导航：`dsh-lsp` / `dsh-lsp-stdio` / `dsh-tool-lsp` 三行给模型一个只读 `lsp` 工具
  （定义/引用/实现/hover，1-based UTF-16），server 是 `typescript@7` 的原生二进制
  `tsc --lsp -stdio`（直指平台包，不走 `.bin/tsc` 的 node 壳）。**仓库根 `jsconfig.json`
  是前提**：没有它 TS 把每个打开的文件当独立项目，`findReferences` 只报本文件内的引用
  （实测 2 处 vs 真实 6 处）——查引用不全比没有这个工具更危险。三行带条目级
  `disabled`，`KINGCODE_LSP=0` 整体关；server 二进制缺失是 boot 期 fail-loud。
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

- **绑 0.0.0.0 是 opt-in 的单独文件，不进 profile 补丁层**：
  `deploy/harmonyos-pc/bind-all.patch.yml` 只给鸿蒙 PC 的虚拟机用。绑 0.0.0.0 等于把
  一个能执行任意命令的 agent 暴露给所在网络（上游 dsh-host-webserver 的原话是它自己
  「no TLS, authentication, or origin policy **of its own**」——alpha.2 起 `/api` 与首页
  确实过 403/401 两层，但静态资源与未被认领的路由仍无遮拦，且一枚 30 天 cookie 就是全部凭证），写进 `profile/cordis.patch.yml` 会让 Mac/Win
  也跟着对外。顺带记一条上游事实：**`--host 0.0.0.0` 旗标会被 dsh-web-app 的 startup
  主动拒绝并退 1**，改 bind 只能走覆盖层改 `webserver` 行的 config（id 定向补丁整段
  替换 config，所以 `port` 那个 `!!js` 表达式必须原样重述，否则 `--port` 永久失效）。
- **不安全上下文垫片已删（dsh 0.1.2-alpha.2 起上游自己解决了）**：明文 HTTP 到非
  loopback 地址时浏览器判定为不安全上下文、`crypto.randomUUID` 不存在，曾经由
  `plugins/insecure-context-shim.js` 补上。上游的 `dsh-util-crypto` 收编了全部调用点
  并加了全仓 lint 拦住新的调用者，实测（前端 dist 25 个 JS + 59 个插件 client 半侧
  静态零命中；页面里换成计数器跑一轮 RPC，调用 0 次）确认冗余后删掉。
  **仍然成立的一条**：`navigator.clipboard` 同样卡 secure context，跨机访问时复制
  按钮失效（不影响会话）。
- **跨机配置面的 403 也没了**：`settings.*` / `credentials.*` /
  `agentPreset.read|copy|remove` / `llm.discoverModels` 曾被上游一份
  `PRIVILEGED_METHODS` 名单钉死在 loopback；0.1.2-alpha.2 的
  `fix(web): authenticate the browser Host API` 把那份名单整段删了，换成每进程
  launch token 换一次签名 cookie。现在的两层是：Host/Origin 栅栏不过 → 403，
  没有浏览器会话 → 401，**与方法名无关**。
  **但这只解决了服务端半侧**：浏览器半侧的 `dsh-client-ui-settings` 仍按页面 hostname 把非
  loopback 的设置面整体降级成 memory（`client.js:1345`，alpha.3 与 alpha.5 逐字相同），跨机
  「模型」页仍报 `settings are unavailable in this browser`——客户端自关闸、不发请求，抓包
  看不到 403。跨机填 key 只能服务侧落盘，或把地址变成 loopback。

- **KingCode 的 harness home 是 `~/.kingcode`，不是 dsh 默认的 `~/.dsh`**：dsh 的 home
  是「一台机器一份」的用户数据根（`.agent-presets/`、`settings.yaml`、
  `.credentials.yaml`、`sessions/`、`storages/`），同机另一个 dsh 产品会把它的领域
  预设装进 `.agent-presets/`、把默认预设写进 `settings.yaml`，共用就等于 KingCode 的
  预设选择器里列着别人的专业预设、新会话直接开在上面。**换 home 是唯一彻底的隔离**：
  dsh 启动器在所有补丁层之上再压一个 `agent-presets` 覆盖层，把 `roots` 强行写成随包
  发行的那一份（profile 里配 `roots` 会被整段丢掉），能留给部署方的只有 `default` 与
  `includeUserRoot`，而用户根固定是 `<dshHome>/.agent-presets`；`settings.yaml` 的
  `agent-presets.default` 又属于设置层，优先级高于任何组合层配置。五处入口各自兜底
  同一路径、都让位于显式的 `DSH_HOME`：`bin/kingcode.js`（排在 `loadEnv` 之后，
  `.env` 里写的也算显式）、`profile/setup.sh`、`profile/setup.ps1`、
  `mac/Sources/ServerController.swift`、`win/ServerController.cs`。
  `deploy/harmonyos-pc/` 下另有三处（`install.sh` 的 `KINGCODE_HOME`、
  `kingcode-web.sh` 的 `DSH_HOME`、`preflight.sh` 的 `KC_HOME`），它们都是
  `${DSH_HOME:-$HOME/.kingcode}` 形式、同样让位于显式值。**改路径要八处一起改。**
  凭证从老 home 搬家的代码只有一处（`profile/setup.sh`，刻意排在 dsh/pnpm 守卫之前，
  否则纯 CLI 用户跑不到那一段，升级后 key 静默失效）。
- **`typescript` 挂在 devDependencies，但 LSP 在 boot 期就要解析它**：`npm ci --omit=dev`
  之后每一次调用都会死在 boot（除非同时 `KINGCODE_LSP=0`——disabled 的条目不 apply，
  也就不查 server 可执行文件）。当前无 CI、无 Docker、README 记的就是裸 `npm install`，
  所以不构成问题；将来加 CI 要记得这条。
- **dsh 包一律写精确版本，不用 `^`**：本树跟 alpha 通道（当前 `0.1.2-alpha.5`；
  以 `npm view @deepseek-ai/dsh dist-tags` 为准，写在文档里的数字必然会过期），
  `npm i -E @deepseek-ai/<pkg>@<那一版>`。两个理由：`latest` dist-tag 按包不同、
  多数子包还指着 0.0.1 老线，省略版本会装到与本树不兼容的包；而 alpha 一天能动几次，
  `^` 会让两次 `npm install` 装出不同的树。升级 = 改 package.json 里那一串数字后
  `rm -rf node_modules package-lock.json && npm install`，然后 `npm test` + 无钥烟测
  + **带钥烟测** + eval。带钥那条不能省：`summarize` 只有真跑完一轮才会被走到，
  alpha.4 删 `Session.events` 那次，无钥烟测在它之前就退出了，只有带钥才会暴露。
- **后台执行面在工具层整体关闭**：`toolJobs: false` + `toolBash.enableRunInBackground:
  false` + subagent 走 `one-shot`，`tool-subagent-control`/`-report` 不挂。一次性
  CLI 退出时 dispose 整棵树，树外存活的工作必然被带走；与其让 persona 劝模型别用
  （而工具 schema 和上游提示词都在说「可以用、默认用」），不如让这个状态在结构上
  无法产生。**runner 因此不需要 drain job**——只有将来上持久 shell 或 goal 三件套，
  「树外存活工作」才会重新出现，届时正确做法是给 runner 显式收敛判据 + wall-clock
  预算，而不是无限等待。
- **不挂 plan-mode / ask-user**：它们的退出都需要一个真人审批，`kingcode "<task>"`
  里没有人，挂上只会让模型卡在等待里。
- **PTC（原 Code Mode）未启用**：依赖已从 package.json 移除。要启用需装
  `dsh-code-runtime-worker-thread`，并给 `cordis.yml` 的 `tools` 行传
  `mode: ptc`（或 `both`），且应当用 eval 证明轮数/耗时确有收益再留下。
  上游 0.1.2-alpha.2 把这个特性连同配置值一起从 Code Mode 改名成 PTC
  （`mode: 'code'` 在这一版**不再是合法取值**），只有 `run_code` 工具名与
  durable 事件词表（`tool/code-dispatch*`）留在旧名上。
- **系统提示词的工作纪律在 `plugins/prompt-sections.js`，不在 persona**：persona 有
  三份副本（根树 / eval 树 / profile 补丁），纪律堆在那里必然漂移；且 persona 固定在
  order 0，排在上游工具指导段（100-105）之前，仲裁不了工具取舍。
