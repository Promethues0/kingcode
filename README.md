# KingCode

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的编程智能体。dsh 是「一切皆插件」的 agent 运行时（Cordis 微内核），KingCode 不 fork 源码——只做**自己的组合树 + 自己的插件 + 自己的 bin**。

## 形态

CLI、Web、Mac 客户端、Windows 客户端四种形态**共用同一棵 dsh 组合树**。

### 1. CLI 一次性任务

```
kingcode "跑一下测试并修复失败"
```

接一个任务 → agent 干活（bash/文件/glob/grep/子代理/todo 全套工具）→ stdout 打印最终回答 → 按结果退出。适合终端与 CI。

**退出码契约**：0 = 完成且有回答；3 = 完成但助手零输出（不该被 CI 当成功）；1 = 其余（错误/未收敛/参数错）。设 `KINGCODE_RESULT_FILE=<path>` 可额外落一行机读 JSON（sessionId / reasonKind / errorCode / emptyOutput / exitCode），给评测 harness 判分用。

**结构**：

| 文件 | 职责 |
|---|---|
| `bin/kingcode.js` | 进程入口：fail-loud → 读 `.env` → `provideCmdline`（参数+退出请求）→ `boot()` 挂载组合树 |
| `cordis.yml` | 组合树：每行一个插件 `{id, name, config}`，这就是 KingCode 的「配方」 |
| `plugins/startup.js` | 解析任务位置参数与 `--help`，发布 `headlessStartup` 服务 |
| `plugins/runner.js` | 一次性任务驱动：建 agent → followup → 等静默 → 打印 → 定退出码 |
| `plugins/multi-edit.js` | 自定义工具：`multi_edit` 批量字面替换（可跨文件、按文件原子） |
| `plugins/prompt-sections.js` | 系统提示词补充段：一次性会话契约 / 工作纪律 / 工具取舍 |
| `plugins/env-context.js` | 运行时上下文：日期 / 平台 / git 分支与工作树脏净（只注入一次） |
| `jsconfig.json` | 只给语言服务器划项目边界（见「语义导航」），不参与任何构建 |

**首次使用**：

```bash
npm install
cp .env.example .env    # 填入 DEEPSEEK_API_KEY
node bin/kingcode.js "介绍一下这个仓库"
# 或 npm link 后直接 kingcode "..."
```

密钥解析优先级：进程环境变量 > `~/.dsh/.credentials.yaml`（0600）> 调用目录 `.env`。密钥永不写进 cordis.yml。

### 2. Web UI（dsh profile + 品牌层）

官方 web 全家桶（web UI + plan mode + 权限预设 + skills）上叠 KingCode 人格补丁与品牌层。profile 的权威副本在仓库的 `profile/` 下，用脚本装到 `$DSH_HOME`：

```bash
./profile/setup.sh        # Windows 用 .\profile\setup.ps1
dsh --profile kingcode --port 3081
```

脚本幂等：重复跑只覆盖补丁层、重装品牌/仓库插件、重装 preset，不动会话与凭证，也不改 `settings.yaml`。

**模型姓 KingCode 靠的是 preset，不是 profile 补丁。** 上游把 persona 注册为全局段，而每个内置 preset（standard/code/cordis/minimal）都挂了自己的 `dsh-persona`，在 agent 作用域把全局 persona 遮蔽掉——所以 `profile/cordis.patch.yml` 里的身份句到不了模型。`presets/kingcode/`（setup 脚本装到 `$DSH_HOME/.agent-presets/kingcode/`）是 standard preset 的整份拷贝加三处叠加：KingCode 身份句（与 CLI 逐字一致）、`plugins/prompt-sections.js`（关掉一次性 CLI 的会话契约与工具取舍，换成面向交互式 Web 的取舍段）、`plugins/env-context.js`（`git: false`）。选它的两种方式：

- Web 新会话的预设选择器里选「KingCode」（已开始对话的会话不能换预设，这是上游规则）；
- 或在 `$DSH_HOME/settings.yaml` 写 `agent-presets: { default: kingcode }`，之后新会话默认就是它。setup 脚本**不替你写**——`~/.dsh` 可能与别的项目共用，默认预设是用户自己的选择。

preset 里用 `kingcode/plugins/…` 引用仓库插件，靠的是脚本把仓库本身 `dsh plugin add -w` 成 profile 里的包 `kingcode`：插件在仓库原位加载，与 CLI 同一份。升级 dsh 后对照 `<dsh>/config/agent-presets/standard/agent.cordis.yml` 同步工具面行。

## 语义导航（`lsp` 工具）

grep 回答「这段文字出现在哪」，`lsp` 回答「这个符号到底绑到了什么」。CLI 树挂了三行——`dsh-lsp`（能力接缝 `ctx.lsp`）→ `dsh-lsp-stdio`（通用 stdio 宿主）→ `dsh-tool-lsp`（模型侧只读工具 `lsp`），四个操作：`goToDefinition` / `findReferences` / `goToImplementation` / `hover`，坐标是 **1-based UTF-16**（光标要落在符号上，落偏了就是空结果）。`findReferences` 永远包含声明本身。只读探索子代理 `explore` 也放行了它。

**覆盖范围**：`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`，server 是 devDependency `typescript@7` 自带的**原生二进制**（`tsc --lsp -stdio`）。命令直指 `node_modules/@typescript/typescript-<platform>-<arch>/lib/tsc`，不走 `node_modules/.bin/tsc`——后者是个 node 脚本再 `execve` 到同一个二进制，白搭一次 Node 启动（实测 `initialize` 57–314ms vs 直连 9–16ms）。路径由 `!!js` 从 `baseUrl` 按平台拼出，所以换平台后 `npm i` 装上对应的原生包即可；**装不上就是 boot 期响亮失败**（`subprocess-local: command "…" is not an executable file`），不会静默降级成「查不到引用」。语言服务器进程本身是惰性的，首次匹配查询才 spawn。

**`jsconfig.json` 是前提，不是可选项**。没有它，TypeScript 把每个「打开即查」的文件当独立推断项目，`findReferences` 只报本文件内的引用——实测查 `plugins/runner.js` 的 `summarize` 只得 **2 处**（真实 6 处，漏掉 `test/test-runner.js` 里的 import 与三处调用）。**查引用不全比没有这个工具更危险**：模型会拿「仓库内没有其他引用」当结论去改签名。加上之后是 6 处。这个文件只服务语言服务器（`checkJs: false` + `noEmit: true`），仓库没有 tsc 构建步骤，它不进任何构建或测试命令。

**加别的语言**：在 `cordis.yml` 的 `lsp-stdio` 行 `servers:` 下再开一个条目，给它自己的 `command` / `args` / `extensionToLanguage`。路由只按小写扩展名，且一个扩展名只能属于一个 provider——两个 provider 抢同一个扩展名会 `LSP_CONFLICT`（boot 期失败），没人认领的扩展名查询抛 `LSP_UNAVAILABLE`。`command` 必须是绝对路径或裸 PATH 名，含 `/` 的相对路径会被 `subprocess-local` 拒绝。

**整体关闭**：`KINGCODE_LSP=0`。三行都带 `disabled: !!js "process.env.KINGCODE_LSP === '0'"`（loader 支持条目级 `disabled`），关掉后 `lsp` 工具连同上游那段工具指导一起从请求里消失，其余能力不受影响。唯一残留：`plugins/prompt-sections.js` 的工具取舍段仍会提一句 lsp——那是静态文本，不随组合树开关走；真调用会得到 `UNKNOWN_TOOL`，是响亮的，不是静默的。

## 品牌层 `web-brand/`

一个双半侧插件包，把 Web UI 换成**苔径晨雾大地色系**（沿用 race-calendar 的已定板）。全程走官方扩展点，**不 fork、不重编译上游前端**：

| 文件 | 做什么 | 用的官方缝 |
|---|---|---|
| `index.js`（node 半侧） | `<title>` → KingCode；接管 `/favicon.svg`（自绘 K 标）与 `/manifest.webmanifest` | `webServer.tapIndex()` + `webServer.register({kind:'exact'})` |
| `client.js`（浏览器半侧） | 91 个 `--dsw-*` token 覆盖（亮/暗双套）+ 藏掉 deepseek 字标与鲸鱼、换 K 标与 KingCode 字样 | `ctx.theme.overrideTokens()` + 注入 `<style>` |
| `tools/check-contrast.js` | WCAG 对比度 + 红绿色弱（Machado 1.0）ΔE 守卫 | — |

**配色的源头是一处，但派生产物不止一处。** `client.js` 顶部的 `P` 常量块
（亮色 15 个 + 暗色 14 个）是 Web 侧唯一事实源，`check-contrast.js` 直接从它
抽取——守卫和配色永远不会各说各话。但**原生端与二进制图标是复制过去的，不会
自己跟着变**，改完 `P` 必须依次过一遍：

```bash
node web-brand/tools/check-contrast.js          # 1. 守卫先过（不达标直接退 1）
# 2. 手工同步三份复制品：
#    web-brand/index.js  的 INK / PAPER / ACCENT2（favicon.svg 自绘用）
#    mac/Sources/Palette.swift
#    win/Palette.cs
cd mac && ./build.sh                            # 3. 重建 Mac（顺带出新 iconset）
./build/KingCode.app/Contents/MacOS/KingCode --make-iconset /tmp/ico-set
# 4. 补 24/48 两档（iconset 没有），再组装 Windows 图标：
sips -Z 24 /tmp/ico-set/icon_256x256.png --out /tmp/24.png
sips -Z 48 /tmp/ico-set/icon_256x256.png --out /tmp/48.png
python3 win/assets/make-ico.py win/assets/KingCode.ico \
  /tmp/ico-set/icon_16x16.png /tmp/24.png /tmp/ico-set/icon_32x32.png /tmp/48.png \
  /tmp/ico-set/icon_32x32@2x.png /tmp/ico-set/icon_128x128.png /tmp/ico-set/icon_256x256.png
```

**`win/assets/KingCode.ico` 是最容易漏的一个**——它是二进制，`git diff` 看不出
颜色变了没有，守卫也管不到（守卫只读 `P`）。字节蓝那批就漏了：Web 三端都换完
推送了，`.ico` 里还是上一版的墨绿黑 `#262B24` + 深赭 `#B97B45`。校验办法是解出
每帧数主色，别靠肉眼看图标缩略图。

**改品牌文案**：`client.js` 的 `BRAND` 块（wordmark / headline 两个字符串）。

## Mac 客户端

`mac/` 下是一个原生 macOS 外壳：真窗口、Dock 图标、中文菜单栏，启动时自己把引擎拉起来。不装 Electron、不建 Xcode 工程——只用 Xcode 命令行工具里的 `swiftc` + `iconutil`。

```bash
cd mac && ./build.sh          # 产物：mac/build/KingCode.app
open mac/build/KingCode.app
cp -R mac/build/KingCode.app /Applications/   # 想从聚焦搜索启动就装过去
```

| 文件 | 职责 |
|---|---|
| `Sources/main.swift` | NSApplication + WKWebView + 菜单栏；`--make-iconset` 兼作图标生成器 |
| `Sources/ServerController.swift` | 引擎生命周期：探活 → 需要时才拉起 → 退出时只收自己拉起的那个 |
| `Sources/LaunchView.swift` | 启动页（引擎装配要几秒，这几秒得有品牌在场，且失败时给得出日志） |
| `Sources/KMark.swift` | K 字标的矢量几何，应用图标与启动页共用 |
| `Sources/Palette.swift` | 原生侧配色，与 `web-brand/client.js` 的 `P` 块同源 |

**引擎端口**默认 3081，`KINGCODE_PORT` 可改。引擎日志在 `~/Library/Logs/KingCode.log`（菜单「引擎 → 显示引擎日志」直达）。

### 五个踩过的坑

1. **部署目标必须显式给**。`swiftc` 默认按 SDK 取最新系统版本，编出的二进制 `minos` 会高于本机，Finder 双击直接报 `-10825` 拒启，且错误信息毫无指向性。`build.sh` 用 `-target <arch>-apple-macosx13.0` 钉死。
2. **GUI 启动的 App 拿不到你的 PATH**。从 Finder 启动时 PATH 只有 `/usr/bin:/bin` 之类，`dsh` 的 `#!/usr/bin/env node` 必然扑空。解法两条一起上：用登录 shell 现解一次真实 PATH（mise/homebrew/nvm 都覆盖得到），并且直接 `node <dsh 的 bin.js>` 调用，绕开 shebang 查找。
3. **WKWebView 会缓存插件 bundle**。`/plugins/<id>/client.js` 路径不带版本号，改完品牌层重启引擎也看不到新的。首次加载用 `.reloadIgnoringLocalCacheData`，菜单的重新载入用 `reloadFromOrigin()`。
4. **WebKit 与 Chromium 对 `mask` 简写解析不同**。`mask: url(...) center / contain no-repeat` 在 Chromium 正常，在 WebKit 里 `no-repeat` 丢失导致蒙版平铺，K 字标两侧露出相邻分块的竖笔，看起来像 `|K|`。**这个缺陷只在原生客户端里出现，浏览器里永远复现不了**——所以品牌层的蒙版一律写长写属性（`mask-image` / `mask-repeat` / `mask-position` / `mask-size`）。
5. **`.fullSizeContentView` 会让窗口拖不动**。它把 WKWebView 铺到标题栏下面，拖拽区被网页吃掉——窗口挪不到扩展屏，这在多显示器上是致命的。只保留 `titlebarAppearsTransparent`：标题栏透出窗口底色、视觉上仍与内容连成一片，但它还是一条真正可抓的标题栏。

## Windows 客户端

`win/` 下是 WinForms + WebView2 的原生外壳，架构与 Mac 版对齐（探活 → 按需拉起 → 退出只收自己拉起的引擎）。

```powershell
# 1. 前置：Node.js、dsh、pnpm
npm install -g @deepseek-ai/dsh pnpm

# 2. 初始化 profile（写 %USERPROFILE%\.dsh\profiles\kingcode 并装品牌层）
.\profile\setup.ps1

# 3. 构建（需 .NET 8 SDK）
cd win; .\build.ps1                    # 框架依赖，需目标机装 .NET 8 桌面运行时
.\build.ps1 -SelfContained             # 自包含单文件，目标机无需装 .NET
```

| 文件 | 职责 |
|---|---|
| `Program.cs` | 入口；**第一件事是把自己加进 Job Object** |
| `JobObject.cs` | 进程树兜底回收（P/Invoke） |
| `ServerController.cs` | 引擎生命周期 + node/dsh 定位 |
| `MainForm.cs` | WebView2 承载 + 菜单 |
| `LaunchPanel.cs` / `KMark.cs` / `Palette.cs` | 启动页、K 字标、配色（与 Mac 版同源） |
| `assets/KingCode.ico` | 7 尺寸图标，由 `assets/make-ico.py` 组装 |

**环境变量**：`KINGCODE_PORT`（默认 3081）、`KINGCODE_NODE`、`KINGCODE_DSH_ENTRY`（后两个用于自动定位失败时手工指路）。引擎日志在 `%LOCALAPPDATA%\KingCode\engine.log`。

### 验证状态：编译验证过，运行未验证

开发机是 macOS，所以做了交叉编译验证（.NET 8 起支持从 mac/Linux 编出 Windows GUI exe）。

**已验证**：
- `dotnet build` 与 `dotnet publish -r win-x64` 均 **0 错误 0 警告**通过。
- 产物是合法的 Windows GUI 程序：PE32+ / x86-64 / **子系统 = 2（GUI）**——这一位设错就会在启动时弹出控制台黑框，而它恰好是 ≤.NET 7 交叉编译会静默弄错的地方。
- 图标真的嵌进去了：把 `assets/KingCode.ico` 的 7 个帧逐个拿特征字节去 exe 的资源节里比对，**7/7 命中**。
- `assets/KingCode.ico` 自身的二进制结构（`file(1)` 识别为 7 图标，声明尺寸与内嵌 PNG 实际尺寸逐条一致）。
- `profile/setup.sh`（macOS 版）实跑通过。

**仍未验证**（这些只有在真 Windows 上跑才知道）：
- 运行期行为：WebView2 初始化时序、Job Object 的 P/Invoke 结构体布局在真实内核上是否被接受、窗口与菜单的实际观感。
- node/dsh 路径探测在你的机器上是否命中（探测顺序是按调研的安装惯例写的，但没有真机样本）。
- `profile/setup.ps1`（是 setup.sh 的直译，逻辑同构但未运行）。
- 交叉编译产物在 Windows 上的实际启动。官方对 `EnableWindowsTargeting` 留过一句保留意见：该属性用于非 Windows 平台开发，**正式发布仍建议在 Windows 上构建**——所以你那边最好用 `build.ps1` 重新构建一次，而不是直接用我这边交叉编译出来的 exe。

跑不通就把报错发我。定位失败时可用 `KINGCODE_NODE` / `KINGCODE_DSH_ENTRY` 手工指路。

### 实现里已按调研落实的几处（都是「写错就出问题」的点）

- **回收进程树用 Job Object + `KILL_ON_JOB_CLOSE`，而不是 `Process.Kill(entireProcessTree)`**。后者的 Windows 实现是「先杀自己再枚举后代」，中间层进程在别的 job 里或权限不足时递归会提前断掉，孙进程成孤儿（dotnet/runtime#107992，修复排到 .NET 11）；而且它需要进程活着才能执行，崩溃路径完全不覆盖。做法是启动时**把自己加进 job**，后代自动继承成员身份，不存在「Start() 返回后再 Assign」的窗口期；job 句柄不可继承（否则崩溃时 KILL_ON_JOB_CLOSE 不触发）。
- **直接 `node.exe <dsh 的 bin.js>`，不碰 `dsh.cmd`**。Windows 上没有 npm.exe/dsh.exe，走 .cmd 会隐式起一层 cmd.exe，进程树多一层、kill 直接子进程就留孤儿，还会撞上 cmd.exe 的参数解析问题（BatBadBut）。
- **`CreateNoWindow` 必须与 `UseShellExecute=false` 成对**，单设无效；刻意不设 `WindowStyle`（.NET 8 前后行为不同）。
- **PATH 是启动时快照**，用户装完 Node 不重启应用就读不到——所以额外并入注册表里的机器级/用户级 PATH。
- **WebView2 的用户数据目录必须显式指定**：.NET 平台默认建在 exe 旁边，装进 Program Files 后会因权限失败。
- **`Form.Icon` 要单独设**：`ApplicationIcon` 只管资源管理器/任务栏，窗口标题栏与 Alt+Tab 用的是前者，不设就是 WinForms 内置图标。
- **没有 `Reload(ignoreCache)` 这种重载**，所以菜单的重新载入是「先 `ClearBrowsingDataAsync(DiskCache)` 再 Reload」——与 Mac 版踩过的插件缓存问题同源。

### 上游对 Windows 的支持程度（客观情况）

dsh 在 Windows 上走 pwsh 栈而非 bash（`bash-sandbox`/`tool-bash` 与 `pwsh-sandbox`/`tool-pwsh` 两组行按 `process.platform` 互斥启用），`$DSH_HOME` 解析到 `%USERPROFILE%\.dsh`，模块兜底目录用 junction 而非 symlink（所以不需要管理员权限或开发者模式）。

但要知道：**上游 README 从未提及 Windows**，也没有平台支持矩阵。他们的 CI 有 Windows 通道，可其中真正跑 dsh 二进制端到端冒烟的那条被显式标成 `allowFailure`，**不阻塞合并**。也就是说 Windows 是「能跑、有人在意，但不是被保证的路径」。

## 校验

```bash
npm test              # 全部无头测试（不起 agent、不调模型）
npm run check:contrast # 配色的 WCAG + 色弱守卫
npm run smoke         # 无钥烟测：应恰好死在 MISSING_CREDENTIAL
npm run eval          # agent 行为评测：真跑任务集并与基线对比（真调模型）
```

`npm test` 直接拿 `defineTool` 的定义驱动 `execute`，不起 agent 也不调模型，所以没有 API key 也能跑。

### 行为评测 `eval/`

无头测试守的是「函数对不对」，`npm run eval` 守的是**「agent 干得对不对」**——改一行 persona、换个模型、调压缩阈值，行为是变强还是变弱，这里才看得见。

```bash
npm run eval                          # 全量跑，与 eval/baseline.json 对比
node eval/run.js --jobs 3             # 并发跑（11 个任务 agent 合计 ~6 分钟，--jobs 3 墙钟 ~3 分钟）
node eval/run.js --task fix-slug      # 单任务，写 latest-partial.json 不碰全量结果
node eval/run.js --update-baseline    # 把本次结果定为新基线（有 harness-error 时拒写）
```

11 个任务覆盖：修复失败测试、修复构建、按栈追因、跨文件重命名、重构保行为、扩展 API 不破坏调用方、给未测模块补测试（**变异测试判分**：agent 写的测试至少杀死 6 个变异体里的 4 个）、陌生代码检索、长命令超时处理（必须读工具说明传 timeoutMs）。

**判分零 LLM 参与**：复跑测试看退出码、stdout 正则、隐藏用例（`eval/oracles/`，agent 看不见）、变异体杀灭率、会话 jsonl 过程取证（用了什么工具、传了什么参数、花了多久）。防作弊是判分的一部分：测试文件与原件逐字节比对、不许新建文件用文件集合 diff、读盘的「测试」直接拒收、靠 `echo VERIFY_OK` 混过的长命令题要看那次调用真花了 135 秒。

状态五态：pass / fail / xfail（标了 `expectFail` 的 known-fail）/ xpass（该摘标了）/ harness-error（评测器自己的病，绝不伪装成 agent 失败）。本次 fail 而基线 pass 的任务自动重跑一次，两次都记账。

评测用 `eval/cordis.eval.yml`（派生自根 `cordis.yml`，改根文件时对照同步）：换便宜的 flash 模型、会话根隔离，且**刻意不挂 `dsh-settings-file`**——否则本机 `settings.yaml` 的模型选择会盖掉组合层，评测口径被个人设置污染。

**`npm run smoke` 会真的发一次模型请求**（如果凭证可用）——它验证的是「组合树能挂起来并走到模型边界」，不是离线检查。没有凭证时会停在 `MISSING_CREDENTIAL`；有凭证时会实际调用一次。期望值由测试里的 `FIXTURE` 清单推导而非手写常量——第一版手算样本文件数算错了，报了 5 个假失败。

### 配色是怎么定的

配色是**字节蓝**（Arco Design 色阶，字节跳动开源设计系统）。accent 用 Arco primary `#165DFF` 而非品牌色 `#3370FF`——后者白字对比度只有 4.28，不达 WCAG AA 的 4.5。

语义三色按「对比度 × 红绿色弱可辨性」**双约束**选取，不是挑好看的。Arco 九种 red×green 组合的色弱 ΔE 跨度极大——`red-7×green-8` 只有 **2.1**（成功与失败在绿弱者眼里几乎同色），`red-8×green-7` 是 **23.6**。最终取 danger `#A1151E` / good `#009A29` / warn `#D25F00`。

守卫**没有任何豁免**：早先有过一条「继承自已定板只报 WARN」的例外，换配色后它就过期了，却仍在把一条 ΔE=2.1 的真失败伪装成提示——豁免比缺陷更危险，已删除。

### 品牌替换的三层难度（上游侧的客观情况）

1. **token 换肤** — 官方 API，最稳。`--dsw-alias-*` 语义层 + `--dsw-static-deepseek-*` 静态阶都要覆盖：徽章底、光晕这类组件直接吃静态阶，只改别名层会漏。
2. **图形替换（wordmark / 鲸鱼）** — 上游硬编码在 SVG 组件里，无插槽、无配置。这里用 CSS 藏原图 + 伪元素叠新标，选择器只匹配 CSS Modules 的**稳定语义后缀**（`[class*="_brand"]`、`[class*="_headline"]`、`[class*="_railFish"]`），不写死哈希前缀——上游重建换前缀不换后缀。**匹配不到时是无害空规则，UI 退回原样，不会白屏。**

   注意侧栏有**两个**品牌位，收起态那个容易漏：展开时是 `_brand` 按钮里的 `BrandWordmark`；收起成 rail 后该按钮**根本不渲染**，改成切换钮里的鲸鱼单标 `_railFish`（静止显示鲸鱼、悬停换成展开图标）。rail 态用 `button[class*="_toggle"]:has([class*="_railFish"])` 判定——`_railFish` 只在收起态存在，是最稳的判据，同时保留了上游的悬停互换逻辑。三个状态（展开侧栏 / rail / 首页 Hero）都已实测。
3. **K 字标不要用 CSS mask，改用烤色 SVG 背景图**。蒙版方案在 WebKit 里连栽两次：简写丢 `no-repeat` 致平铺成「|K|」；改长写后边缘仍会在栅格化时抖出一圈噪点。背景图没有蒙版那套语义，画出来就是干净的；代价是颜色不能跟 CSS 变量走，所以亮暗各生成一份，用 `body[data-ds-dark-theme]` 切换。

   写这份 SVG 时还踩到一条 SVG 规范：`linearGradient` 默认 `gradientUnits="objectBoundingBox"`，而 K 的竖笔是条**垂直线、包围盒宽度为零**，渐变退化后该形状**根本不绘制**——K 会变成「<」。必须用 `userSpaceOnUse` 并给 viewBox 坐标，顺带让三笔共享同一条渐变而不是各自一条。

4. **啃不动的** — 硬编码 SVG 里的 `fill`（已逐个用 CSS `fill` 覆盖，目前全页零残留蓝）；启动加载页的 `HARNESS` 字样在 shell dist 里，插件加载前就已渲染，改不到。

首页大标题走 locale 注册表且**单占席**（重复注册直接 throw，会把整个 UI 打挂），所以这里没走「抢注 locale」的路，用的是 CSS 覆盖。真要改文案的正门是整体替换 `locale` 行为自己的包装包。

## 改造点地图（在哪儿动什么）

- **人格/系统提示词**：`cordis.yml` 里 `agent-spine` 行的 `persona`（支持 `{{model}}`/`{{cwd}}` 模板）
- **默认模型**：`agent-default-model` 行（provider 路由 + model id；现为 `deepseek-official` / `deepseek-v4-pro`）
- **加自定义工具**：照 `plugins/multi-edit.js`——具名导出 `name`/`inject`/`apply(ctx)`，`ctx.tools.register(defineTool({...}))`，再在 `cordis.yml` 加一行。注意：对象 schema 必须显式写 `additionalProperties`；render 必须承载模型所需的全量载荷
- **接其他模型厂商**：OpenAI 兼容端点零代码——换 `@deepseek-ai/dsh-llm-pi-ai` 行，`providers` 里手工声明路由（`api: openai-completions` + `baseURL` + `models`）；自有协议才需要写 LlmAdapter
- **权限门**：另写 hook 插件监听 `tools/pre-execute` waterfall，返回 `{kind:'deny'|'ask'}`；沙箱可换 `dsh-bash-sandbox` + `dsh-sandbox-policy`（参照上游 acp-agent 示例）
- **接 MCP server**：不进根 `cordis.yml`，用独立树 `cordis.mcp.yml`（第一行 `cordis:include` 根树，之后每个 server 一行 `@deepseek-ai/dsh-mcp-client`，stdio 或 streamable-http；没有 servers 表），`kingcode --config cordis.mcp.yml "<task>"` 启用。工具名 `mcp__<serverName>__<rawName>`；仓库自带的 `test/fixtures/mcp-echo-server.js` 是示例行也是 `npm test` 的被测夹具（`mcp__echo__add`）。**务必 `failOnStartupError: true`**：server 起不来时 boot 以退出码 1 响亮失败；默认 `false` 在本 CLI 树里等于静默降级——dsh-mcp-client 的告警走 `ctx.logger`，而这棵树没有日志 sink，stderr 只能看到子进程自己的崩溃输出，模型会零工具作答。另外 server 的 inputSchema 只能用 dsh-tools 的关键字子集（带 `$schema` 的会被拒绝注册），server 挂起不退出时 boot 会等满 SDK 固有的 60s。Web/Mac/Win 形态走 `profile/cordis.patch.yml` 的 `insert`（dsh 安装自带 dsh-mcp-client），本仓库未做
- **Code Mode**：需给 agent-spine 的 ToolRuntime 传 `tools: {mode: 'code'|'both'}` 并挂 `dsh-code-runtime-worker-thread`（注意：曾以为环境变量 `DSH_TOOLS_MODE` 可控，实测全 node_modules 无代码读它——mode 只来自 ToolRuntime 配置，该虚注释与死重条目已从 cordis.yml 移除）

## 上游生态须知（踩过的坑）

- **CLI 的默认模型会被 Web UI 的选择覆盖**：`agent-default-model` 行的 config 属于组合层，而用户级 `$DSH_HOME/settings.yaml` 的同名节优先级更高——你在 Web UI 里选了 Claude，CLI 也会跟着用。所以 CLI 的 `cordis.yml` **必须挂 `llm-pi-ai` 多厂商适配器**，否则会报 `NO_ADAPTER: no adapter registered for provider "anthropic"`。这是两个形态共享一份用户设置的必然结果，不是 bug。

- **npm dist-tag**：`@deepseek-ai/dsh-*` 库包的 `latest` 标签滞后，**装 `@next`** 才是与 CLI 对齐的 `0.1.0-rc.6` 版本线
- **Loader 插件必须具名导出**（`export const name/inject` + `export function apply`），default export 会静默丢 `inject`
- `cordis.yml` 的 `!!js` 标量是 dsh include 的 YAML 方言，普通 YAML 解析器读不了
- `fs-observation-policy` 行必须排在 `tool-fs` 之前（写文件要求先读过）
- `installFailLoud` 必须在 `boot()` 之前调用，否则并发挂载的晚到 rejection 会静默
- 上游处于 developer preview，**会有破坏性变更**；锁 `package-lock.json`，升级前先跑无钥烟测：`env -u DEEPSEEK_API_KEY node bin/kingcode.js "say hi"` 应恰好死在 `MISSING_CREDENTIAL`

## 路线图（可选下一步）

- [x] 自写 runner 替换 `@deepseek-ai/dsh-headless` —— 诊断前缀已是 `kingcode:`，且核心服务缺失时改为响亮报错（上游是静默 return，进程会挂着不退、看起来像卡死）
- [ ] `agent-spine-demo` 展开为自组正式 bundle（demo 包非产品 API）
- [ ] 交互式 TUI 形态（上游生态有 `github:deepseek-harness/turtle-ui` 可参考）
- [ ] 发布 `@kingcode/bundle` 到 npm，支持 `dsh plugin add` 安装进任意 profile（仓库加 `dsh-plugin` topic）
- [ ] ACP / Python SDK 形态：同一棵组合树换协议头，接编辑器或程序化调用
