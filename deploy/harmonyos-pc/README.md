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
# ⓪ 先拿到仓库。**openEuler 镜像里默认没有 git**（真机实测：git: command not found，
#    看起来像"clone 失败"，其实是没这个命令），所以先装它；install.sh 第 1 步也会装，
#    但那时你还没有 install.sh——鸡生蛋，这一条得自己来。
sudo dnf install -y git
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

dsh 升级、垫片或预设改动之后，用 `./rehearse-emulator.sh` 在开发机上十分钟复验这半边：
它把上面这些探针加上「DevEco 2in1 模拟器真开页面 → 截屏取证 → lsof 查 WS 下行」串成
一条命令，机器验不了的只剩肉眼看一眼截图里工作区有没有数据。

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
- **C++ 工具链还得装，但服务对象只剩全局 `dsh`**。仓库自己的 `npm ci` 已经不编译：
  `package.json` 用 `overrides` 把 `node-pty` 钉到 `1.2.0-beta.15`，那版自带
  `prebuilds/linux-arm64/pty.node`（真 aarch64 ELF），install 脚本探到预编译目录直接
  退 0，node-gyp 不跑；`module.exports` 键集合与 1.1.0 逐字相同
  （createTerminal/fork/native/open/spawn），上游 `dsh-subprocess-local@0.1.0-rc.8`
  起也精确钉这一版。工具链现在只为第 7 步的**全局 `dsh@0.1.0-rc.6`** 存在：
  `npm i -g` 不吃本仓库的 overrides，它树里的 `node-pty` 仍按 `^1.1.0` 解析到
  1.1.0（semver 区间撞不到预发布版），那版无 linux 预编译，必然现场编译。也没有
  绕的路：其 `scripts/prebuild.js` 只认包内 `prebuilds/<platform>-<arch>` 目录、
  没有任何指向外部预编译的环境变量（唯一认的 `npm_config_build_from_source` 方向
  相反），而 `--ignore-scripts` 会连 `@vscode/ripgrep` 的 postinstall 下载一起跳过。
  上游 Web 形态升到 rc.8+ 之日，这条前置可整个删除。
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
  采的快照）。`status` 与 `url` 会把名单里的 IP 和本机现在的 IP 对比，漂了会红字
  告警——但只在有 `ip`/`hostname -I` 可用的机器上（openEuler 有）。
- 开机自启在这个环境里没有可靠方案（没有 systemd，`chsh` 也被禁）。当前做法是
  `install.sh` 把 PATH 快照接进 `~/.bashrc`，你开终端后手动 `kingcode-web.sh start`。
  如果 `crond` 可用，`@reboot` 是可以试的一条路——**没验证过**。
- 会话日志（`$DSH_HOME/sessions`）**不会自动清**，但 `./kingcode-web.sh prune` 能清：
  删掉 N 天没动的会话目录（默认 30，`KINGCODE_PRUNE_DAYS` 可调），默认干跑列清单、
  `--yes` 才真删、服务在跑时拒绝执行。spill 文件（系统 tmp 里的 `dsh-spill-*`）prune
  只报数量不删——同机其它 dsh 产品的 spill 长得一模一样，删错会弄断人家的活会话。
- 网络差时最坏会静默约 30 分钟（重试 5 次 × 5 分钟 stream idle 超时）。CLI 形态用
  `KINGCODE_DEADLINE_MS` 兜住；两种形态都能用 `~/.kingcode/settings.yaml` 把静默压短，
  模板与算术见下面「网络差时把静默压短」。

## 网络差时把静默压短（可选）

上面「最坏 30 分钟」的构成（对着 dsh 0.1.0-rc.6 的 schema 与包文档逐项核过）：

- 适配器给**每一次读**的静默上限是 `streamIdleTimeoutMs`，默认 300000（5 分钟）。
  SSE 的 keep-alive 注释算传输活动、会重置计时，所以掐掉的是彻底断死的连接
  （`LlmError('TIMEOUT')`），不是活着但慢的流。
- 断掉之后由 `dsh-llm-retry` 按路由的 `retryPolicy` 重试：normal 模式默认
  `maxRetries: 2`——初次 + 2 次重试，单路由最坏 3 × 5 分钟 ≈ 15 分钟全程无声。
  CLI 形态还挂着 model-failover（pro 熔断后切 flash），两段路由加起来 ≈ 30 分钟。
- `dsh-llm-deepseek` 把自己的整份 Config 注册成 settings 的 `llm-deepseek:` 命名空间：
  `~/.kingcode/settings.yaml` 里的这一节**免重启热生效**，只覆盖写了的字段，
  Web 与 CLI 吃同一份（CLI 的 harness home 同样默认 `~/.kingcode`）。

虚拟机上建议写进 `~/.kingcode/settings.yaml`（这套部署装完默认没有这个文件；
新建即可，dsh 会保留既有文件，Web 的 Models 页以后写的也是同一份）：

```yaml
llm-deepseek:
  streamIdleTimeoutMs: 120000   # 2 分钟判死断流（默认 5 分钟）
  retryPolicy:
    mode: normal                # 别改 always：它对认证/配额类永久错误也无限重试
    maxRetries: 2               # 即默认值，写出来是让人知道有这颗旋钮
    backoff:
      initialDelayMs: 1000
      maxDelayMs: 15000
      jitterRatio: 0.2
```

效果：单路由最坏静默从 ≈15 分钟压到 ≈6 分钟。**不要**把 `streamIdleTimeoutMs`
调得太狠：reasoningEffort=high 的长思考期间如果上游 keep-alive 稀疏，过短的值会把
活流误杀成 TIMEOUT——2 分钟已经是保守值，而 keep-alive 的真实节奏没人在弱网上实测过。
真正的硬兜底仍是 CLI 的 `KINGCODE_DEADLINE_MS`；Web 会话没有对应的墙钟上限。

## 模拟器彩排（2026-08-27）

用 DevEco Studio 6.0.2 的 2in1 模拟器（MateBook Pro，HarmonyOS 6.0.2，API 22）里的
**华为浏览器**，访问跑在 Mac 上的这套 Web 服务（`kingcode-web.sh` +
`bind-all.patch.yml`，明文 HTTP + LAN IP——和真机一样落在不安全上下文里）。
浏览器半边六项全部通过：

1. 页面 200，UI 完整；
2. 品牌是 KingCode（web-brand 层在 ArkWeb 里生效）；
3. `agentPreset.list` 探针 200（信任栅栏放行）；
4. **工作区数据正常加载**——这条就是垫片在真 ArkWeb 里生效的证据：不安全上下文下
   没有垫片，这里必然转圈；
5. WebSocket 下行保持 ESTABLISHED；
6. 预设选择器默认 KingCode。

这验掉的是链路里「浏览器侧」的全部未知：ArkWeb 的行为是不是标准、垫片在真华为
浏览器里挂不挂得上。**没验掉的**：服务侧当时跑在 Mac 上，不在 openEuler 虚拟机里——
所以「真机上宿主能否访问虚拟机端口」和 openEuler 侧的安装链路仍然只能在真机上验。
模拟器结果不等于真机结果，别把这节当成后者。复验步骤见文末附录，
一条命令版是 `./rehearse-emulator.sh`。

## 真机实测（2026-08-28，HUAWEI MNTXM-32A / HarmonyOS 7.0.0.102 / API 26）

**宿主能访问虚拟机端口——这条通了**，整套方案最后一个未知数就此消除。证据链：

- 虚拟机拿到的是 StratoVirt NAT 私网地址 `172.16.105.2/24`（eth0），网关即宿主
  `172.16.105.1`；**不在 LAN 上**，所以别指望局域网里的别的机器能直连它。
- 宿主 `ping 172.16.105.2` → 2 发 2 收 0% 丢包（L3 通）。
- 虚拟机里起 `python3 -m http.server 3081 --bind 0.0.0.0`，**鸿蒙浏览器打开
  `http://172.16.105.2:3081` 正常渲染**；虚拟机侧访问日志同时记下
  `172.16.105.1 - - "GET / HTTP/1.1" 200`（L4/L7 通，且请求确实来自宿主网关）。
- 反向也通：虚拟机 `curl` 同网段另一台机器上的 KingCode 服务 → `HTTP/1.1 200 OK`
  （NAT 出网正常，装依赖、调模型都没问题）。

**实测规格**（官方与全网都查不到的那几项）：融合开发引擎控制台显示
**内存 4G / CPU 4 核 / 磁盘 512G / 网络 NAT**；虚拟机内 `free -m` 报 total 3912、
available 3701，`df -h /` 报 503G 可用（已用 745M）。对照 `preflight.sh` 的
`NEED_DISK_MB=2048`：**磁盘绰绰有余**；内存 4G 也够（引擎实测 RSS 48MB），
但仍建议小内存机加 `KINGCODE_NODE_OPTS=--max-old-space-size=768` 兜住病理会话。

**环境事实**：`uname -srm` → `Linux 6.6.0 aarch64`；`/etc/os-release` 报
**openEuler 24.03 (LTS-SP1)**，dnf 里的包也都是 `oe2403sp1` 后缀——**别被镜像包名
`com.huawei.developer.rgm.images_openeuler22.03` 里的 22.03 误导，那只是包名**。
glibc 2.38、locale `C.UTF-8`、SELinux Disabled、sudo 免密可用、PID 1 是 `hsl_init`、
**没有 `crontab`**（`@reboot` 自启这条路就此确认走不通）。`/mnt/linux_share` 存在但
`root:root 700`，普通用户不可写——与官方 FAQ 一致，仓库与 harness home 都别放那儿。
虚拟机由「融合开发引擎」应用的系统控制台点「开启」启动，起来后是鸿蒙桌面上的一个
终端窗口。

**默认没有的命令**：**git**、node、npm、pnpm、make、gcc、g++。git 这条最坑——
没有它连仓库都拿不到，而报错 `git: command not found` 看起来像"clone 失败"
（本次就是这么被误判成"网络连不上"的）。「三步」的第 ⓪ 步已经把 `dnf install -y git`
写在最前面。

**完整安装链路一次装通**（八步无红灯）：

| 步骤 | 实测 |
|---|---|
| preflight | 退出码 0，103 行，无阻塞项 |
| 1 系统包 | `Complete!`（gcc-c++ 12.3.1 / make 4.4.1 / python3 3.11.6 / glibc-devel 2.38…） |
| 2 Node | v24.19.0 从 cdn.npmmirror.com 下 29.1M @ 12.7M/s，**SHA256 校验 OK**（`--mirror` 把 Node 二进制也改道镜像那条优化生效） |
| 6 `npm ci` | 通过，**全程没碰 node-gyp**——`node_modules/node-pty/prebuilds/` 里 `linux-arm64` 在列，overrides 免编译在真机兑现 |
| 7 dsh/pnpm/profile | 就绪 |
| 自检 | `npm test` **全部通过** |
| Web 服务 | 引擎就绪 `http://172.16.105.2:3081` |
| 五项体检 | 全绿：端口 `0.0.0.0:3081`、本机 `/api` 200、LAN 口 200、IP 漂移「没有（信任名单一致）」 |
| 鸿蒙壳 | 填 `172.16.105.2:3081` 连上**自家**引擎，工作区加载 |

至此这台鸿蒙 PC 自洽：壳与引擎都在同一台机器上，不依赖任何外部机器。

**踩到的坑**：

1. 终端里的中文输入法会把命令吃掉（`uname -srm` 变成「U那么-上热门」），
   **按一下 Shift 切英文**再敲。用 hdc 远程驱动时尤其要注意这点。
2. **同版本 dsh 的前端未必是同一份**：都自称 0.1.0-rc.6，但全新 npm 安装会把子依赖
   解析到更新版本、前端重打包（实测资源名 `index-CA9Bpko5.js` vs 开发机的
   `index-Dqw48FrP.js`）。后果是品牌覆盖层里凡是锚在 **DOM 层级**上的选择器都会
   **安静失效**——`button > svg` 落空，上游的鲸鱼字标就漏在 KingCode 旁边，
   而同一段 CSS 的 `::before`/`::after` 照常生效，不报任何错。选择器只能锚组件自身的
   稳定属性（`viewBox`、类名后缀）。已修（见 `web-brand/client.js` 的 `BRAND_CSS`）。

**跨机访问下「设置页大半打不开」是设计如此**，不是装坏了：同一台机器上实测
`settings.describe` 从 `127.0.0.1` 返回 400（请求体缺字段——说明放行了），
从 `172.16.105.2` 返回 **403**。开发机上按 LAN 地址复现过整页的样子：

| 设置页分区 | 跨机表现 |
| --- | --- |
| 通用设置 | 预设与权限两栏卡在「正在加载」/「不可用」，下面挂着 `transport failure for /api/settings.describe: HTTP 403` |
| 模型 | 整页只剩一行红字「加载提供方目录失败」+ 一个「重试」按钮 |
| 插件 / Agent 预设 | 同因 403 降级 |
| **KingCode** | **正常**——它不走 `/api`，走自己的 `trusted-host` 通道 |

**换模型不受影响**：模型选择器走 `llm.models` / `session.selectModel`，上游**故意**
没把这两个钉进禁列（注释原文说 LAN 客户端的模型选择器合法地需要它）。真机验过
跨机 `ok:true`，且换一次模型 `settings.yaml` 里就会长出 `agent-default-model` 段。
所以换模型用**输入框上的模型选择器**，不要去设置页的「模型」分区。

### 填 API key 的两条路

**① 设置页里的「KingCode」分区（推荐）**——需要启动时带上凭证桥：

```bash
KINGCODE_CREDENTIAL_BRIDGE=1 ~/kingcode/deploy/harmonyos-pc/kingcode-web.sh restart
```

然后在鸿蒙壳里开「设置 → KingCode」，填 key、保存即可。这条路只写不读：
分区永远不会显示已有的值，服务端也从不回传它（契约见 `web-config/index.js`）。
`KINGCODE_CREDENTIAL_BRIDGE` 不是默认开的——它是个写凭证的入口，默认该是「没有」。

**② 在虚拟机侧落盘**（不想开那条通道时）：

```bash
echo 'DEEPSEEK_API_KEY: sk-你的key' > ~/.kingcode/.credentials.yaml
chmod 600 ~/.kingcode/.credentials.yaml   # 组/其他位有权限会让 dsh 在 boot 期拒启
~/kingcode/deploy/harmonyos-pc/kingcode-web.sh restart
```

启动服务的 shell 里若 `export` 过同名环境变量，它**赢过**文件（上游让它可见地只读，
而不是静默遮蔽写入）。这时「KingCode」分区会显示「已配置（来源：env）」并说明
在这里改不生效——上游的 `set` 也会直接拒绝，不会假装写成功。

## 待你在机器上验的

1. **开机自启**：已确认没有 `crontab`、PID 1 是 `hsl_init`，`@reboot` 这条路走不通。
   当前做法是开终端后手动 `kingcode-web.sh start`（`install.sh` 已把 PATH 快照接进
   `~/.bashrc`）。找到别的自启钩子欢迎补进来。
2. **长期运行的表现**：会话与 spill 的实际增长速度、`prune` 的收益、看门狗在真实
   崩溃下的行为——都得跑上一段时间才知道。

**验证状态**：**整条链路已在鸿蒙 PC 真机上跑通**（见上面「真机实测」）——
preflight、install 八步、`npm test`、Web 服务、五项体检、鸿蒙壳连自家引擎，
全部一次过。开发机（macOS）上另外验过的：脚本全部 shellcheck 干净、
`kingcode-web.sh` 的 start/stop/restart/并发start/看门狗重启/端口被占时不谎报就绪
都实跑过、垫片有 30+ 条断言的无头测试（外层 catch 那条用变异体验过覆盖真实）、
浏览器半边在 HarmonyOS 6.0.2 模拟器的真 ArkWeb 里彩排过。

## 排障速查

| 症状 | 大概率是 |
|---|---|
| 全局装 dsh 时卡在 node-pty | 缺 gcc-c++/make/python3/glibc-devel，或 node-gyp 下不到 node headers |
| `npm ci` 竟然在编译 node-pty | 这份 lock 没带 overrides 那次提交（node-pty 应是 1.2.0-beta.15，带 linux-arm64 预编译） |
| boot 报找不到 tsc | 用了 `--omit=dev`，或从别的机器拷了 node_modules |
| boot 以退出码 1 拒启、提凭证权限 | `.credentials.yaml` 不是 0600 |
| 页面能开、工作区一直转圈 | `/api` 403（信任栅栏）或 randomUUID（垫片没挂上）——用上面那条 curl 分辨 |
| 宿主连不上 | 没绑 0.0.0.0，或虚拟机 IP 变了 |
| 服务关掉终端就没了 | 没走 `kingcode-web.sh start`（少了 nohup，SIGHUP 直接杀死 dsh） |
| 服务起得来，但预设选择器里没有 KingCode、也没有默认项 | `$DSH_HOME/.agent-presets/kingcode` 不在（没跑 `profile/setup.sh`）。这是个**不响的失败**：服务照常起、品牌照常是 KingCode。`kingcode-web.sh start` 已经会在启动前拦住它 |
| CLI 报 MISSING_CREDENTIAL，但你记得填过 key | key 还在老的 `~/.dsh/.credentials.yaml` 里。跑一次 `profile/setup.sh` 会搬过来（它不需要 dsh/pnpm 也能走到搬家那一步） |
| 模型请求半天没动静 | 重试退避，最坏 30 分钟；先确认 `api.deepseek.com` 通（401 即通）。可压短，见「网络差时把静默压短」 |

## 跨机配置面（web-config）的真机记录

2026-08-31 在真机上装通并逐项验过：28 条断言全绿，含完整写入路径
（set → configured:true → unset → configured:false）、四条信任栅栏分支
（伪造 Host / 跨源 Origin / sec-fetch-site: cross-site / GET 方法 / 缺 content-type），
以及 setup.sh 重装后对既有面（品牌层、垫片、preset、`/api`）的回归。
自检用的是一次性假值，验完即清；引擎日志里只留字符数，**没有任何密钥值**。

**只有真机才会暴露的五件事**：

1. **上游「模型」页跨机时的报错措辞和浏览器里不一样**。开发机上按 LAN 地址访问看到的是
   `transport failure for /api/settings.describe: HTTP 403`；鸿蒙壳里看到的却是
   `加载提供方目录失败: settings are unavailable in this browser`——是客户端**自己**
   关的闸，压根没发请求。按前者去抓包会一无所获。
2. **`↔`（U+2194）在鸿蒙的字体回退里被当 emoji 渲染**，成一个蓝色方块。UI 文案里
   不要用箭头之类的符号字符，改用汉字。
3. **改了 client bundle 的内容必须重启引擎**。client-modules 的包元数据按名缓存且
   永不过期（原文：plugin-set changes take effect on restart; bundle content changes
   reach the graph only through `ClientModuleRegistry.rebuilt`）。只改文件不重启，
   服务上仍是旧 bundle。
4. **壳里的 WebView 不会因为引擎重启而重载**。要看到新前端得
   `aa force-stop com.kingcode.client` 再 `aa start`。
5. **点输入框时 ArkWeb 会整片黑一下**，是输入法弹出时的瞬时重绘，不是崩溃
   （`ps` 里 `:render` 进程都还在），下一次点击就恢复。别当成 bug 去查。

**凭证桥已设为常开**：虚拟机的 `~/.bashrc` 末尾加了 `export KINGCODE_CREDENTIAL_BRIDGE=1`
（改前备份在 `~/.bashrc.bak-kingcode`）。验过：用不带任何显式变量的登录 shell 重启，
引擎命令行里自动带上 `--patch …/credential-bridge.patch.yml`，通道回 `ok:true`。
临时想不带桥启动用 `KINGCODE_CREDENTIAL_BRIDGE=0 …/kingcode-web.sh restart`
（启动器判的是 `= 1`，所以设成 0 就关）。

**远程驱动虚拟机终端的两个坑**（用 hdc + uitest 时）：

- `uitest uiInput text` 会**丢掉开头若干字符**（实测丢了 13 个，`curl -sSf htt` 整段没了，
  剩下的 `p://…` 被 bash 当成文件名报 No such file）。办法是在命令前垫一串空格当牺牲位
  ——bash 忽略前导空白，丢的是空格而不是命令。
- 虚拟机只能单向够到开发机，靠截图读输出既慢又容易看漏。开发机上起一个既发文件、
  又收 POST 的小中继，让虚拟机 `curl … | bash` 并把完整日志 POST 回来，比截图可靠得多。

## 附录：用模拟器复验浏览器半边

将来 dsh 升级或垫片改动，不用等真机——DevEco 的 2in1 模拟器跑的是真 ArkWeb，
一条命令能把浏览器半边整个复验一遍：`./rehearse-emulator.sh`（机器能验的自动判，
只留一张截图给肉眼）。下面是它背后的手工版，脚本坏了或要单步排查时用：

1. DevEco Studio → Device Manager 装一个 **2in1** 镜像（例：MateBook Pro，
   HarmonyOS 6.0.2 / API 22）并启动。开发机上照常 `kingcode-web.sh start`
   （模拟器与开发机同网，直接访问开发机的 LAN IP——明文 HTTP + 非 loopback，
   正好落在和真机一样的不安全上下文里）。
2. hdc 三条命令就够（hdc 在
   `<DevEco-Studio.app>/Contents/sdk/default/openharmony/toolchains/hdc`，
   目标 `-t 127.0.0.1:5555`）：

   ```bash
   # 带 URL 拉起浏览器
   hdc -t 127.0.0.1:5555 shell "aa start -A ohos.want.action.viewData -U http://<开发机LAN-IP>:3081"
   # 抓客户机真屏（别信宿主窗口截图，缩放会骗人）
   hdc -t 127.0.0.1:5555 shell "snapshot_display -f /data/local/tmp/x.jpeg"
   hdc -t 127.0.0.1:5555 file recv /data/local/tmp/x.jpeg /tmp/x.jpeg
   # 点屏幕（坐标按客户机分辨率算，这个 2in1 镜像是 3120×2080）
   hdc -t 127.0.0.1:5555 shell "uitest uiInput click <X> <Y>"
   ```

3. 判读口径（与「三道闸」一一对应）：
   - **工作区数据加载出来了** = 垫片生效、`/api` 放行，浏览器半边整体通过；
   - **只有页面没有数据**（UI 完整、工作区转圈）= 用「跨机访问」一节那条 curl 探针
     分辨：`/api` 403 是信任栅栏（闸②，重启服务重采 IP）；200 则是
     `crypto.randomUUID`（闸③，垫片没挂上——查 `git pull` 之后重跑过
     `profile/setup.sh` 没有）；
   - **页面都打不开** = 没绑 0.0.0.0 或 IP 写错（闸①）。
