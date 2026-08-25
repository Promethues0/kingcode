# KingCode on 鸿蒙 PC（融合开发引擎）

把 KingCode 引擎**本体**装进鸿蒙电脑的「融合开发引擎」——华为提供的一键 Linux 环境
（openEuler、Linux 6.6 内核、aarch64，底层 StratoVirt 虚拟化）。不是瘦客户端：
bash、git、tsc、LSP、子代理、multi_edit 一件不少，CLI 与 Web 两种形态都在里面跑。

> **先决条件**：鸿蒙 PC，HarmonyOS 6.0 及以上（商用机个人空间需 6.0.0.130+），
> 从应用市场装「融合开发引擎」，**仅主用户可用**。联网要切 NAT 模式。

## 三步

脚本本身住在仓库里，所以**第一件事是把仓库弄到虚拟机上**（`install.sh` 也能自己
clone，但那样你就得先有 `install.sh`——鸡生蛋）。在虚拟机的 Linux 终端里：

```bash
# ⓪ 先拿到仓库（clone 不通就从 /mnt/linux_share 拷一份到本地盘，别在共享目录里装）
git clone https://github.com/Promethues0/kingcode.git ~/kingcode
cd ~/kingcode/deploy/harmonyos-pc

# ① 只读探针：把这台机器上决定方案的事实采集齐，整段回贴给我
#    （不装软件、不改配置；只会刷新 dnf 元数据缓存、在共享目录建删一个探针文件）
bash preflight.sh > ~/pf.txt; cat ~/pf.txt

# ② 一键装：系统包 → Node → 依赖 → dsh/pnpm → profile
#    --repo 指向刚才 clone 的那份，省得它再 clone 一次
DEEPSEEK_API_KEY=sk-... bash install.sh --mirror --repo ~/kingcode

# ③ 起 Web 服务（CLI 形态装完就能直接用，不需要这步）
~/kingcode/deploy/harmonyos-pc/kingcode-web.sh start
~/kingcode/deploy/harmonyos-pc/kingcode-web.sh status   # 体检
~/kingcode/deploy/harmonyos-pc/kingcode-web.sh url      # 宿主浏览器该开哪个地址
```

装完之后：

```bash
cd ~/kingcode && node bin/kingcode.js "介绍一下这个仓库"   # CLI
npm test                                                   # 自检，不花模型钱
```

**更新**：`git pull` 之后必须重跑 `./profile/setup.sh`——profile 里的补丁层与 preset 是
setup.sh **拷**进去的，光 pull 不重跑，跑的还是上一版的身份句、预设与垫片。

> `install.sh` 开跑前会自查这份代码含不含本次交付（`deploy/`、垫片、挂垫片的
> `cordis.patch.yml`、指向 `~/.kingcode` 的 `setup.sh`），缺哪样都会在 `npm ci` **之前**
> 停下并说清原因——clone 只拿得到已提交的东西，这一条挡的就是「装完一切正常，
> 直到宿主访问时工作区转圈」。

## 跨机访问：三道闸，两道会静默

Web 形态跑在虚拟机里，浏览器在**鸿蒙宿主**上。这条链路上有三道闸，其中两道的失败
形态是「页面打得开、界面完整、什么错都不报」——最容易被当成装好了。

| 闸 | 症状 | 治法 |
|---|---|---|
| ① bind 地址 | 宿主连不上（connection refused） | 绑 `0.0.0.0`。**不能用 `--host 0.0.0.0`**，dsh 主动拒绝它并退 1；只能用 `bind-all.patch.yml` 覆盖 `webserver` 行。`kingcode-web.sh` 默认就带 |
| ② `/api` 信任栅栏 | 页面 200、UI 完整、**工作区永远转圈**；控制台里 `/api` 全 403 | 绑 0.0.0.0 时 dsh 会在**启动那一刻**把本机所有非 internal IPv4 自动加进信任名单，所以按虚拟机 IP 访问是自动过的。IP 变了要重启服务 |
| ③ secure context | 同样是页面 200、UI 完整、工作区转圈；设置里写着 `crypto.randomUUID is not a function` | 明文 HTTP 到非 loopback 地址 = 浏览器判定不安全上下文，`crypto.randomUUID` 不存在，而 dsh 客户端每条 RPC 都要用它铸 rpcId。**KingCode 自带垫片**（`plugins/insecure-context-shim.js`），profile 里已挂上，不需要你做任何事 |

**跨机访问下这些是正常态，不是故障**：设置面板里 `/api/settings.describe` 报 403、
凭证页与模型发现不可用、预设的读取/复制/删除转圈——上面第三段说的「配置面钉死
loopback」就长这个样子。所以下面那条「403 = 栅栏拦了」只适用于 `agentPreset.list`
这类普通方法；配置面的 403 是设计如此，改不掉，也不必改。

一条命令分辨②和③：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"probe","method":"agentPreset.list","payload":{}}' \
  http://<虚拟机IP>:3081/api/agentPreset.list
```

`200` = 栅栏放行（那么转圈就是③，检查垫片有没有挂上）；`403` = 栅栏拦了（是②）；
连不上 = ①。`./kingcode-web.sh status` 已经把这条探针内建了。

**垫片治不了的两样**：

1. 跨机访问时 `settings.*`、`credentials.*`、`agentPreset.read|copy|remove`、
   `llm.discoverModels` 这一整个配置面被上游**钉死在 loopback**，一律 403。所以
   **API key 必须在虚拟机侧落盘**，不能在宿主浏览器的 Models 页里填。
2. `navigator.clipboard` 同样是 secure-context 门槛 API（dsh 的复制按钮用它）。垫片
   没治它，也不该治。后果只是复制按钮失效，会话本身不受影响。全量扫过 dsh 送进
   浏览器的 73 个 JS，被 secure context 挡住的就这两样。

**安全**：绑 0.0.0.0 等于把一个能执行任意命令的 agent 暴露给它所在的网络，而 dsh
自己在文档里写明「no TLS, no auth, no origin policy」。在 NAT 模式的虚拟机里，
它的可达面基本只有宿主；但**别把这个覆盖层带回 Mac/Win**——那儿的网络不是这个网络。
所以它是单独一个 opt-in 文件，不在 `profile/cordis.patch.yml` 里。

## 为什么是这些选择

每一条都是查过的，不是惯例：

- **Node 必须 ≥ 22.19.0，脚本默认装 v24.19.0**。硬下限 22.15.0 来自
  `dsh-session-persistence-jsonl` 顶层 `import { zstdCompress, ... } from 'node:zlib'`——
  ESM 从内置模块具名导入不存在的名字是**链接期 SyntaxError**，把 `compression` 配成
  `none` 也救不了。再往上，`pi-ai` 自报 `engines.node >= 22.19.0`，而 `llm-pi-ai` 是
  cordis.yml 标注「必须挂」的行。选 24 是因为 cordis 的插件加载器按 Node major 分叉，
  而开发机上真正跑过的只有 24 那条分支。
  **openEuler 源里的 nodejs 是 20.x，`dnf install nodejs` 这条路是堵死的。**
- **必须装 C++ 工具链**。`node-pty@1.1.0` 的发布包里只有 darwin/win32 预编译，
  linux-arm64 必然回落到 `node-gyp rebuild`；它是 `dsh-subprocess-local` 的
  **非 optional** 依赖，编译失败会让整条 `npm ci` 退 1。全局 `dsh` 那份也吃它。
- **`npm ci` 不能加 `--omit=dev`，也不能加 `--omit=optional`**。前者会抽掉 LSP 的
  `@typescript/typescript-linux-arm64`（cordis.yml 按路径直接拼这个二进制，缺了是
  boot 期硬失败）；后者会抽掉 ripgrep 与 koffi 的 linux 二进制。
- **不能从 Mac 拷 `node_modules`**：ripgrep / tsc / koffi 三个包都按 os+cpu 分发，
  Mac 上只落了 darwin-arm64 那份。`package-lock.json` 里 linux-arm64 的条目**都在**，
  在目标机 `npm ci` 会自己装对，不需要重新生成 lock。
- **顺序不能反：先 `npm ci`，再 `profile/setup.sh`**。setup 把仓库 `pnpm link` 进
  profile，被 link 的插件在仓库原位加载、从仓库自己的 `node_modules` 解析依赖。
  同理，**`~/.kingcode` 不能从别的机器拷**（里面是绝对路径的符号链接），
  仓库跑完 setup 之后也不能再挪位置。
- **仓库与 harness home 都不要放 `/mnt/linux_share`**：共享目录属主是 root
  （官方 FAQ 承认 `git clone` 会因此失败），权限位不受 POSIX 管，而
  `.credentials.yaml` 必须是 0600——多一位 dsh 就在 boot 期以退出码 1 拒启。
- **装出来的东西全在你自己的目录里**：Node 落 `~/.local/node-<版本>`、全局包落
  `~/.local/npm-global`、PATH 快照落 `~/.kingcode/env.sh`（并接进 `~/.bashrc`）。
  **不写 `~/.npmrc`**——用 `npm_config_prefix` / `npm_config_registry` 环境变量只影响
  本次进程，不会把你机器上其它项目的 npm registry 或全局 prefix 永久改掉。
- **没有 systemd，所以用 `nohup` + 看门狗**。dsh 不处理 SIGHUP，收到直接死（退 129），
  所以必须 nohup；SIGTERM 是优雅退出，「退出码 0 = 人主动停的、非 0 = 该重启」是可靠
  判据；就绪判据是日志里的 `dsh web: http://` 那一行，不是端口能连上（端口先开、
  整棵树 settle 之后才打那一行）。日志只能 `>>` 追加 + copy-truncate 轮转——dsh 没有
  reopen 通道，唯一能当 reopen 信号的 SIGHUP 会直接杀死它。
- **自己保证单实例**：同一个 `$DSH_HOME` 起两个实例会双双成功，harness home 这一级
  没有任何跨进程锁（跨进程写锁只覆盖 `settings.yaml` 与 `.credentials.yaml`），
  而会话 jsonl 明确「一个会话只能有一个活写者」。
- **凭证放 `~/.kingcode/.credentials.yaml`（0600）或 export**。注意 CLI 形态下
  **调用目录的 `.env` 会压过凭证文件**（`bin/kingcode.js` 用 `loadEnv`，把 .env 摊平
  进 `process.env`），而 Web 形态优先级相反——两处都写、值不一样时，两种形态会各用
  各的 key。
- **代理必须 export，写 `.env` 一定失效**：dsh 全树没有代理支持代码，Node 的全局
  fetch 默认也不认 `HTTP_PROXY`——要走代理得 `export NODE_USE_ENV_PROXY=1`
  （Node ≥ 24.0 / ≥ 22.21）。而 `HTTP_PROXY`/`NODE_EXTRA_CA_CERTS`/`DSH_*` 是
  bootstrap-only 名单，Web 形态见到 `.env` 里有它们会直接抛错拒启。
- **出网只需要 `api.deepseek.com` 一个域名**（聊天 `/chat/completions`，
  web_search `/anthropic/v1/messages`，共用同一个 key），纯 IPv4，没有遥测域名。
  不带 key 打它返回 401 就说明网通了。

## 已知限制

- 融合开发引擎**不支持 Docker、systemctl、USB、内核模块、`chsh`、IPv6**，只支持
  openEuler，仅主用户。这些是官方 FAQ 写明的。
- **虚拟机 IP 每次开机可能变**，官方没有端口转发功能。别把地址存成书签，
  用 `./kingcode-web.sh url` 重新问；IP 变了之后**要重启服务**（信任名单是启动那一刻
  采的快照）。
- 开机自启在这个环境里没有可靠方案（没有 systemd，`chsh` 也被禁）。当前做法是
  `install.sh` 把 PATH 快照接进 `~/.bashrc`，你开终端后手动 `kingcode-web.sh start`。
  如果 `crond` 可用，`@reboot` 是可以试的一条路——**没验证过**。
- 会话日志（`$DSH_HOME/sessions`）与 spill 文件**没有任何东西会自动清**，没有
  systemd-tmpfiles 兜底，长期用要自己看着点。
- 网络差时最坏会静默约 30 分钟（重试 5 次 × 5 分钟 stream idle 超时）。CLI 形态用
  `KINGCODE_DEADLINE_MS` 兜住，Web 形态在 `settings.yaml` 里调 `streamIdleTimeoutMs`。

## 待你在机器上验的（我在开发机上验不了）

1. **宿主能不能访问虚拟机端口**——`preflight.sh` 第六节给了验证步骤（用真正要用的
   端口、在空目录里起 http.server）。这条决定 Web 形态成不成立。
2. 默认分配的 CPU / 内存 / 磁盘（官方与全网都没有数据）——`preflight.sh` 第一节会量。
3. `@reboot` 自启到底行不行：`preflight.sh` 会报 `crontab` 在不在、PID 1 是谁，
   但「开机时真的会拉起来吗」只能你重启一次试。
4. openEuler 的具体小版本与源里各包的实际版本（`preflight.sh` 第一、四节会打出来）。

**整份交付里没有一行在鸿蒙 PC 上跑过。** 我能验的都在开发机（macOS）上验了：
三个脚本 shellcheck 干净、`kingcode-web.sh` 的 start/stop/restart/并发start/看门狗重启/
端口被占时不谎报就绪都实跑过、`install.sh` 用打桩的方式把八步逻辑走通过、
垫片有 30 条断言的无头测试并在真起的服务上确认注入生效、绑 0.0.0.0 + 跨机 /api 200
的整条链路在本机彩排过。**openEuler 特有的部分（dnf、aarch64、node-pty 现场编译、
宿主可达性）全部未验。**

## 排障速查

| 症状 | 大概率是 |
|---|---|
| `npm ci` 卡在 node-pty | 缺 gcc-c++/make/python3/glibc-devel，或 node-gyp 下不到 node headers |
| boot 报找不到 tsc | 用了 `--omit=dev`，或从别的机器拷了 node_modules |
| boot 以退出码 1 拒启、提凭证权限 | `.credentials.yaml` 不是 0600 |
| 页面能开、工作区一直转圈 | `/api` 403（信任栅栏）或 randomUUID（垫片没挂上）——用上面那条 curl 分辨 |
| 宿主连不上 | 没绑 0.0.0.0，或虚拟机 IP 变了 |
| 服务关掉终端就没了 | 没走 `kingcode-web.sh start`（少了 nohup，SIGHUP 直接杀死 dsh） |
| 服务起得来，但预设选择器里没有 KingCode、也没有默认项 | `$DSH_HOME/.agent-presets/kingcode` 不在（没跑 `profile/setup.sh`）。这是个**不响的失败**：服务照常起、品牌照常是 KingCode。`kingcode-web.sh start` 已经会在启动前拦住它 |
| CLI 报 MISSING_CREDENTIAL，但你记得填过 key | key 还在老的 `~/.dsh/.credentials.yaml` 里。跑一次 `profile/setup.sh` 会搬过来（它不需要 dsh/pnpm 也能走到搬家那一步） |
| 模型请求半天没动静 | 重试退避，最坏 30 分钟；先确认 `api.deepseek.com` 通（401 即通） |
