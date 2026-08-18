# KingCode

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的编程智能体。dsh 是「一切皆插件」的 agent 运行时（Cordis 微内核），KingCode 不 fork 源码——只做**自己的组合树 + 自己的插件 + 自己的 bin**。

## 两种形态

### 1. CLI 一次性任务（本仓库）

```
kingcode "跑一下测试并修复失败"
```

接一个任务 → agent 干活（bash/文件/子代理/todo 全套工具）→ stdout 打印最终回答 → 按结果退出（completed=0，否则 1）。适合终端与 CI。

**结构**：

| 文件 | 职责 |
|---|---|
| `bin/kingcode.js` | 进程入口：fail-loud → 读 `.env` → `provideCmdline`（参数+退出请求）→ `boot()` 挂载组合树 |
| `cordis.yml` | 组合树：每行一个插件 `{id, name, config}`，这就是 KingCode 的「配方」 |
| `plugins/startup.js` | 解析任务位置参数与 `--help`，发布 `headlessStartup` 服务 |
| `plugins/project-stats.js` | 自定义工具示例：`project_stats` 按扩展名统计项目文件 |

**首次使用**：

```bash
npm install
cp .env.example .env    # 填入 DEEPSEEK_API_KEY
node bin/kingcode.js "介绍一下这个仓库"
# 或 npm link 后直接 kingcode "..."
```

密钥解析优先级：进程环境变量 > `~/.dsh/.credentials.yaml`（0600）> 调用目录 `.env`。密钥永不写进 cordis.yml。

### 2. Web UI（dsh profile + 品牌层，已就位）

`~/.dsh/profiles/kingcode/` 是一个 dsh profile：官方 web 全家桶（web UI + plan mode + 权限预设 + skills）上叠 KingCode 人格补丁（`cordis.patch.yml`）与品牌层。

```bash
dsh --profile kingcode --port 3081
```

## 品牌层 `web-brand/`

一个双半侧插件包，把 Web UI 换成**苔径晨雾大地色系**（沿用 race-calendar 的已定板）。全程走官方扩展点，**不 fork、不重编译上游前端**：

| 文件 | 做什么 | 用的官方缝 |
|---|---|---|
| `index.js`（node 半侧） | `<title>` → KingCode；接管 `/favicon.svg`（自绘 K 标）与 `/manifest.webmanifest` | `webServer.tapIndex()` + `webServer.register({kind:'exact'})` |
| `client.js`（浏览器半侧） | 91 个 `--dsw-*` token 覆盖（亮/暗双套）+ 藏掉 deepseek 字标与鲸鱼、换 K 标与 KingCode 字样 | `ctx.theme.overrideTokens()` + 注入 `<style>` |
| `tools/check-contrast.js` | WCAG 对比度 + 红绿色弱（Machado 1.0）ΔE 守卫 | — |

**改配色只改一处**：`client.js` 顶部的 `P` 常量块（亮色 15 个 + 暗色 14 个）。改完跑：

```bash
node web-brand/tools/check-contrast.js
```

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

## 校验

```bash
npm test              # project_stats 工具的无头测试（不调模型）
npm run check:contrast # 配色的 WCAG + 色弱守卫
npm run smoke         # 无钥烟测：应恰好死在 MISSING_CREDENTIAL
```

`npm test` 直接拿 `defineTool` 的定义驱动 `execute`，不起 agent 也不调模型，所以没有 API key 也能跑。期望值由测试里的 `FIXTURE` 清单推导而非手写常量——第一版手算样本文件数算错了，报了 5 个假失败。

### 配色是怎么定的

亮色直接继承 race-calendar 的苔径晨雾板（墨绿黑 `#262B24` / 纸底 `#F1EFE7`·`#FCFBF7` / 深赭 `#8F5127`→`#B97B45` / 岩灰 `#6A6B61` / danger `#963C4A` / good `#447A6E` / warn `#B1881E`），这套值你已做过 WCAG + 色弱评审，工具对它只报 WARN 不判失败。

暗色「夜径」是新造的，因此按同一标准硬校验。**踩到过一个真坑**：把 good/danger 从亮色随手提亮后，两者明度撞在一起（L≈59 vs 58），红绿色弱下 ΔE 掉到 9.7——「成功 vs 失败」正是最不能混的一对。网格搜索后取 good `#70B7B3` / danger `#CE7280`，ΔL 11.2、ΔE 18.5/19.6，恢复了亮色板「色相 + 明度差」双保险的做法。

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
- **加自定义工具**：照 `plugins/project-stats.js`——具名导出 `name`/`inject:['tools']`/`apply(ctx)`，`ctx.tools.register(defineTool({...}))`，再在 `cordis.yml` 加一行。注意：对象 schema 必须显式写 `additionalProperties`
- **接其他模型厂商**：OpenAI 兼容端点零代码——换 `@deepseek-ai/dsh-llm-pi-ai` 行，`providers` 里手工声明路由（`api: openai-completions` + `baseURL` + `models`）；自有协议才需要写 LlmAdapter
- **权限门**：另写 hook 插件监听 `tools/pre-execute` waterfall，返回 `{kind:'deny'|'ask'}`；沙箱可换 `dsh-bash-sandbox` + `dsh-sandbox-policy`（参照上游 acp-agent 示例）
- **Code Mode**：`DSH_TOOLS_MODE=code|both` 让模型用 JS 编排工具（`code-runtime` 行已挂）

## 上游生态须知（踩过的坑）

- **npm dist-tag**：`@deepseek-ai/dsh-*` 库包的 `latest` 标签滞后，**装 `@next`** 才是与 CLI 对齐的 `0.1.0-rc.6` 版本线
- **Loader 插件必须具名导出**（`export const name/inject` + `export function apply`），default export 会静默丢 `inject`
- `cordis.yml` 的 `!!js` 标量是 dsh include 的 YAML 方言，普通 YAML 解析器读不了
- `fs-observation-policy` 行必须排在 `tool-fs` 之前（写文件要求先读过）
- `installFailLoud` 必须在 `boot()` 之前调用，否则并发挂载的晚到 rejection 会静默
- 上游处于 developer preview，**会有破坏性变更**；锁 `package-lock.json`，升级前先跑无钥烟测：`env -u DEEPSEEK_API_KEY node bin/kingcode.js "say hi"` 应恰好死在 `MISSING_CREDENTIAL`

## 路线图（可选下一步）

- [ ] 自写 runner 替换 `@deepseek-ai/dsh-headless`（错误前缀现在还是 `dsh:`）
- [ ] `agent-spine-demo` 展开为自组正式 bundle（demo 包非产品 API）
- [ ] 交互式 TUI 形态（上游生态有 `github:deepseek-harness/turtle-ui` 可参考）
- [ ] 发布 `@kingcode/bundle` 到 npm，支持 `dsh plugin add` 安装进任意 profile（仓库加 `dsh-plugin` topic）
- [ ] ACP / Python SDK 形态：同一棵组合树换协议头，接编辑器或程序化调用
