# KingCode 原生跑在鸿蒙 PC（HiShell，不经虚拟机）

`deploy/harmonyos-pc/` 是把引擎装进「融合开发引擎」的 openEuler 虚拟机；这里是另一条路：
引擎直接跑在鸿蒙 PC 自带的终端（HiShell）里，Node 是 Harmonybrew 装的原生
`platform=openharmony` 构建，没有虚拟机。

**状态（2026-09-02 真机）**：A 级判据已过——整棵 CLI 组合树在 HiShell 里 boot 成功、
无钥烟测恰好死在 `MISSING_CREDENTIAL`（退出码 1、结果文件落盘、会话目录写成功），
`npm test` 全绿。带钥的真回答还没跑（设备上没有凭证）。Web 形态（B 级）未做。

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

## 未做 / 未验

- 带钥的真回答（设备上没有凭证；在 HiShell 里 `export DEEPSEEK_API_KEY=…` 后跑 smoke.sh）。
- B 级（Web 形态原生 + ArkWeb 壳连 127.0.0.1）：全局 dsh 树多三处——`dsh-sandbox-local` →
  `dsh-sandbox-windows-acl` 也静态 import koffi，且 sandbox-local 会做 `STARTUPINFOW` 布局探测，
  本桩过不了（09-01 实测 `layout mismatch: koffi computed undefined`）；`dsh-attachment-local`
  的 `link()`；sharp 要 `@img/sharp-wasm32`。另需 `DSH_PERMISSION_MODE=danger-full-access`。
- 从零 `npm ci --ignore-scripts` 的顺序未复跑。
- 本地编译的 `.node` 在这台机器上能 dlopen（node-pty 已证）；别的套件记录的 Merkle 签名要求
  没有在这里遇到。
- 关掉 HiShell 窗口后进程是否存活、开机自启，未验。
- 上游只开 Discussions：值得提的三件是 openharmony 当 POSIX 认、link EPERM 回落 rename、
  koffi 改懒加载——合入后 ①②③④ 都不再需要。
