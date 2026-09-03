# KingCode 原生跑在鸿蒙 PC（HiShell，不经虚拟机）

`deploy/harmonyos-pc/` 是把引擎装进「融合开发引擎」的 openEuler 虚拟机；这里是另一条路：
引擎直接跑在鸿蒙 PC 自带的终端（HiShell）里，Node 是 Harmonybrew 装的原生
`platform=openharmony` 构建，没有虚拟机。

**状态（2026-09-02 真机）**：A 级已通——整棵 CLI 组合树在 HiShell 里 boot 成功，无钥烟测
恰好死在 `MISSING_CREDENTIAL`，`npm test` 全绿；把凭证放进 el2 home 后，带钥 `say hi` 退出码 0，
一个真用工具的任务也过了：bash 工具经 node-pty 在原生内核上跑 `uname -a`（回的是
HongMeng Kernel 1.13.0），grep 工具经 ripgrep 数出 README 里 26 行——subprocess-local 的
openharmony 检查器与 ripgrep 平台包两条链路都真跑了。**B 级（Web 形态 + 鸿蒙壳连 127.0.0.1）
也已在 2026-09-03 真机全通**，见下面「B 级」一节。

设备：HUAWEI MateBook 14 / HarmonyOS 7.0.0.102 / API 26 / HongMeng Kernel 1.13.0 /
Node 26.8.1（`process.platform === 'openharmony'`，V8 非 lite、JIT 正常）。

## 三步

```sh
# 0 前置（Harmonybrew，见下「工具链」）：node cmake python@3.12 ohos-sdk llvm-gcc-compat bash git ripgrep pnpm
cd ~/kingcode                                   # 仓库放家目录即可（hmdfs），DSH_HOME 另放
npm ci --ignore-scripts                          # koffi 的 postinstall 会试图现编、必败，先跳过全部脚本
( cd node_modules/node-pty && CC=clang CXX=clang++ npx --no-install node-gyp rebuild )   # 只有它需要原生编
sh deploy/harmonyos-native/patch-node-modules.sh # 五处补丁，幂等，--revert 可撤
. deploy/harmonyos-native/env.sh                 # PATH / DSH_HOME=el2 / KINGCODE_LSP=0
sh deploy/harmonyos-native/smoke.sh              # 无钥：PASS = 恰好死在 MISSING_CREDENTIAL
DEEPSEEK_API_KEY=sk-... sh deploy/harmonyos-native/smoke.sh   # 带钥：应有回答
# 或者把 .credentials.yaml 放进 $DSH_HOME（chmod 600，必须在 el2 上）后直接 node bin/kingcode.js "say hi"
```

> 第 1、2 步是按 09-01 在真机上摸索出的顺序整理的，当时的 `npm ci` 是在 koffi 处失败后手工
> 补编 node-pty 走通的；`--ignore-scripts` 这条一次成型的顺序**没有从零复跑过**。
> 第 3 步起（补丁 → 烟测）在 09-02 真机上按这个脚本原样跑通。

## 五处补丁与它们对应的硬事实

| 补丁 | 真机事实 | 做法 |
|---|---|---|
| ① koffi 桩 | `dsh-subprocess-local` 顶层 `import koffi` 并在加载期调 `koffi.pointer("void")`，openharmony 无原生产物，插件加载即炸；其余调用全在 win32 分支 | 换成惰性桩：`pointer/struct/array` 返回空类型对象，`load/alloc/encode/decode` 一律 throw；不碰任何 `.node` |
| ② 终端检查器 | `createProcessInspector` 对非 linux/darwin/win32 直接 throw，首次开终端时触发；`/proc` 在 | openharmony 走 `LinuxProcessInspector` |
| ③ 会话落盘 | 用 `link()` 原子发布；家目录（hmdfs）**EPERM**、`/data/storage/el2/base`（hmfs）**EACCES**——全盘禁硬链接 | link 失败即 `open(wx)` 占位 + `rename`，保住「不存在才创建」 |
| ④ 写工具新建文件 | 同 ③（`dsh-fs-local` 的 createIfAbsent 路径；dsh-harmonyos 套件没治这处） | 同 ③ |
| ⑤ ripgrep | `@vscode/ripgrep` 按 `ripgrep-${platform}-${arch}/bin/rg` 解析，无 openharmony 包；fs-search 的 `execPath-rg` 侧车只在 pkg 打包二进制里生效 | 放本地包 `@vscode/ripgrep-openharmony-arm64`，`bin/rg` 软链 Harmonybrew 的 rg |

不是补丁、但必须做的三件：`DSH_HOME` 放 `/data/storage/el2/base/…`（见下）、`KINGCODE_LSP=0`、
node-pty 用本机 clang 现编（Harmonybrew 没有 llvm/clang formula，`ohos-sdk` + `llvm-gcc-compat`
才给出 clang 15 / gcc 别名）。

## 真机上量到的事实（HiShell 域，2026-09-02）

**hdc shell 与 HiShell 是两个环境，探针只能在 HiShell 里做。** hdc 进的是 `uid=2000 shell`、
`u:r:sh:s0`，看不到 `/storage/Users/`，`/dev/ptmx` 连 `ls` 都拒绝，硬链接拒绝，PATH 无 node——
全是悲观值。HiShell 是 uid 20001006（文件归 file_manager 组），家目录
`/storage/Users/currentUser`，从 hdc 侧看它就是 `/storage/media/100/local/files/Docs`
（同一目录，两边都能读写；这是往 HiShell 递脚本、取日志的通道）。

| 项 | HiShell 里的实测 |
|---|---|
| `/dev/ptmx` | `ls` 报 Permission denied，但 `open(/dev/ptmx, r+)` **成功**；09-01 编的 node-pty 能 spawn `/bin/sh` 并拿到输出 |
| `/proc` | 在，293 项，可读 |
| 硬链接 | 家目录 EPERM、el2/base EACCES、`/tmp` EROFS（只读 erofs） |
| 符号链接 | 正常 |
| chmod 600 | 家目录（hmdfs）落成 **660**；`/data/storage/el2/base`（hmfs, acl）落成 **600**——凭证文件必须放后者 |
| TMPDIR | HiShell 默认指到家目录 |
| PATH | `~/.harmonybrew/bin:/usr/local/bin:/data/app/bin:/data/service/hnp/bin:/usr/bin:/vendor/bin` |
| 工具链 | clang 15.0.4（`aarch64-unknown-linux-ohos`）、gcc/cc/ld/ar 别名、make、cmake、python3.12、git、rg 15.2、pnpm、bash 5.3、zsh（系统） |
| 进程 | 10 次 `spawnSync(sh)` 269 ms；3e7 次热循环正常（JIT 开着） |

`/data/service/hnp/bin/clang` 在这台机器上**不存在**（dsh-harmonyos 套件假定的路径），
编译器来自 Harmonybrew 的 `ohos-sdk`（2.7 GB）+ `llvm-gcc-compat`。

## 与虚拟机路径相比，哪些东西不再需要

绑 `0.0.0.0` 的覆盖层、`/api` 信任名单与 IP 漂移、跨机 403、凭证桥、不安全上下文——引擎在
本机、壳连 `127.0.0.1`，loopback 是安全上下文。**仍然需要**的是浏览器会话认证那一步
（token → cookie 对 loopback 也不豁免，见 `deploy/harmonyos-pc/README.md` 闸④）。

## B 级（Web 形态原生 + 鸿蒙壳连 127.0.0.1）——2026-09-03 已通

**B 级已通（2026-09-03 09:38，跑的是全局 dsh alpha.3；仓库随后升到 alpha.5，五处补丁的锚点已在 alpha.5 上逐字复核且唯一，但 B 级链路本身没在 alpha.5 上复跑）**：全局 dsh 在 HiShell 里装通并 boot 成功，鸿蒙壳
（com.kingcode.client）连 `http://127.0.0.1:3081/?token=…` 加载出完整工作区，并在壳里发一条真消息
拿到回答——2 次工具调用，bash 经 node-pty 回 `HongMeng Kernel 1.13.0 … aarch64 Toybox`，grep 经
ripgrep 数出 README 里 26 行；20K token / 11 秒 / 89 tok/s / 缓存命中 46%（DeepSeek-V4-Pro High，
完全权限）。品牌层（K 标与字标）、KingCode 预设、设置 → 模型页「API 密钥已配置」都正常。

在 A 级五处补丁之外，B 级多出四件：

| 事 | 真机事实 | 做法 |
|---|---|---|
| 安装 | `npm i -g @deepseek-ai/dsh@0.1.2-alpha.5`（**必须钉版**：latest 指着 0.1.1-rc.2，那条线没有会话认证）会在 koffi 的 postinstall 上失败 | `--ignore-scripts` 装完，再 `cd ~/.harmonybrew/lib/node_modules/@deepseek-ai/dsh && CC=clang CXX=clang++ npm rebuild node-pty` |
| sharp | `dsh-attachment-local` 加载期 require sharp。**别用 `npm install --no-save @img/sharp-wasm32`**——全局 dsh 那棵树没有任何 lockfile（`package-lock.json` 与 `node_modules/.package-lock.json` 都没有），这条命令会对 ~70 个 caret 依赖做整树重解析：2026-09-03 实测挂 20 分钟无进展、无报错（比失败更难排查），而且按 reify 语义它还会重解包整棵树，把刚打的补丁与刚编的 `pty.node` 一起冲掉 | `npm pack @img/sharp-wasm32@<sharp 版本> @emnapi/runtime tslib` 拿 tarball，再 `tar -xzf` 解到全局 `node_modules/<包名>`（tarball 里是 `package/` 前缀）。同机实测 3 个包 5 秒。断网兜底才是从另一台机器打包那三个目录（`tar` 时路径写 `./@img/...`，裸 `@` 会被 bsdtar 当归档指令）|
| 补丁 | 全局树多 `dsh-attachment-local` 的 link() 与 `dsh-win32-process` 加载期的两个结构体大小断言 | `patch-node-modules.sh --root <全局 node_modules>`（桩里带大小表） |
| **profile 包解析** | 起服务报 `Cannot find package 'kingcode-web-brand'`——`cordis-plugin-loader` 靠 `--expose-internals` 或 `node-addon-require-builtin` 拿 Node 内部加载器来解析 profile 里的包，后者没有 openharmony 构建，退化后 profile 包解析不到（09-01 那次也是这个） | **用 `node --expose-internals <dsh 的 bin.js> --profile kingcode --port 3081 --no-open` 起**，profile 包立刻解析到 |

起服务的完整命令（在 HiShell 里，仓库根目录）：

```sh
. deploy/harmonyos-native/env.sh
export DSH_PERMISSION_MODE=danger-full-access        # sandbox-local 对未知平台 fail-closed，bash-sandbox 在这个模式下直接放行
bash profile/setup.sh                                # 只需一次：profile + preset + link 品牌层与仓库，落在 $DSH_HOME/profiles/kingcode
nohup node --expose-internals "$(readlink -f "$(command -v dsh)")" --profile kingcode --port 3081 --no-open > ~/kc-web.log 2>&1 &
grep 'dsh web:' ~/kc-web.log                          # 带 token 的地址；壳里首次用它，之后靠 cookie
```

curl 走过的链：`GET /` 401 → `GET /?token=…` 303 + Set-Cookie → 带 cookie `GET /` 200、`/api/agentPresets/list` 到达网关、
`/favicon.svg` 200、`<title>KingCode</title>`（品牌层 host 半侧生效）。壳里第一次进页面底部有「连接异常」，点一次重连
（页面重载、弹上游「内测声明」点「继续」）后消失，`/proc/net/tcp` 里能看到多条到 :3081 的 loopback 连接。

**壳的 401 判读已在真机验过（2026-09-03 12:25）**，正反两面都有：

| 构建 | 连一个无 cookie 的地址（引擎在跑，标准 401） |
|---|---|
| 改之前（08-28 那版，只挂 onErrorReceive） | WebView 里只剩服务端那行英文 `dsh web authentication required; reopen the URL printed by dsh web.`，**地址页不出现**，用户无从下手 |
| 改之后（22d6820 起，挂了 onHttpErrorReceive） | 回到地址页并给出中文指引：「需要带 token 的地址换一次会话 cookie。本机形态：在 HiShell 里跑 kc-hmos url…」 |

复现办法：`bm clean -n com.kingcode.client -d` 清掉 cookie 与存的地址，再填一个不带 `?token=` 的地址去连。
顺带修掉一个真机才看得出的小瑕疵：**ArkTS 的 `Text` 不渲染 markdown**，地址页文案里的 `**` 会原样显示成星号。

**自动化驱动的两条经验**（这次踩过）：① 系统 CapsLock 开着时 `uitest uiInput text` 输入整体大小写反转，
`keyEvent 2074` 不一定改得动——改用 **`uitest uiInput inputText <x> <y> '<文本>'`**，按坐标直写、不走键盘、
大小写如实；② Ctrl+A（`keyEvent 2072 2017`）在 WebView 里会选中整页并弹出上下文菜单，把后续输入全吃掉，
别用它清输入框。取 bounds 用 `uitest dumpLayout -b com.kingcode.client`。
引擎重启后壳不会自动重连（旧 WebSocket 断着），点一次「连接异常，点击立即重连」即可——
cookie signing secret 落盘在 `$DSH_HOME/.credentials.yaml`，所以**重启不用重贴带 token 的地址**。

## 引擎的生命周期绑死在 HiShell 上（2026-09-03 实测）

三档对照，`nohup` 与 `setsid` 都试过：

| 操作 | 引擎 | 端口 3081 |
|---|---|---|
| HiShell 切到后台（比如切去用鸿蒙壳） | **活着** | 仍 LISTEN |
| 关掉 HiShell 窗口（点标题栏的 ✕） | **立刻死** | 连 TIME_WAIT 都不留 |
| `aa force-stop com.huawei.hmos.hishell` | **立刻死** | TIME_WAIT 后消失 |

即使用 `setsid` 让引擎自成会话、父进程被 init 收养（实测 `ppid=1`、`sid` 等于自身 pid），
也挡不住——鸿蒙在应用终止时收走整个应用沙箱的进程组，跟 POSIX 那套「脱离控制终端就活得下去」
不是一回事。

两条推论：

- **正常使用形态是「HiShell 窗口留着、切后台」**，不是「起完就关」。B 级那次在壳里发消息拿到
  真回答，全程 HiShell 就在后台。
- **开机自启在这条路上意义有限**：没有任何载体能让引擎脱离 HiShell 活着，能做的最多是
  「开机后自动打开 HiShell 并在里面拉起引擎」，窗口仍然必须留着。参考项目里那套四层钩子
  （/etc/profile、.zshenv、.zshrc、XDG autostart）解决的是「怎么自动跑起来」，
  解决不了「窗口关了怎么办」。

## 未做 / 未验

- 「连接异常」首次出现的原因未查（点一次重连就消失）；ArkWeb 是否跨应用重启持久化 cookie 未验。
- 从零 `npm ci --ignore-scripts` 的顺序未复跑。
- 本地编译的 `.node` 在这台机器上能 dlopen（node-pty 已证）；别的套件记录的 Merkle 签名要求
  没有在这里遇到。
- ~~关掉 HiShell 窗口后进程是否存活~~ —— **已验（2026-09-03），答案是不存活**，见上面
  「引擎的生命周期绑死在 HiShell 上」一节。
- 上游只开 Discussions：值得提的三件是 openharmony 当 POSIX 认、link EPERM 回落 rename、
  koffi 改懒加载——合入后 ①②③④ 都不再需要。
