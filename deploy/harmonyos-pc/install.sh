#!/bin/bash
# KingCode 鸿蒙 PC 一键部署 —— 在融合开发引擎的 openEuler（aarch64）虚拟机里跑。
#
#   bash install.sh                     # 默认：装系统包 + Node + 仓库 + dsh + profile
#   bash install.sh --mirror            # 走 registry.npmmirror.com（大陆网络更稳）
#   bash install.sh --repo ~/kingcode   # 用已经在本地的仓库，不 clone
#   bash install.sh --skip-system       # 跳过 dnf（你自己已经装好工具链）
#   DEEPSEEK_API_KEY=sk-... bash install.sh   # 顺手把凭证写进 harness home
#
# 幂等：每一步都先看现状再动手，重复跑不会把已经装好的东西弄坏。
# 失败即停并打印排查方向——半装成功的环境比装不上更难查。
#
# 每一步为什么这么做，见 deploy/harmonyos-pc/README.md 的「为什么」一节。
set -euo pipefail

NODE_VERSION="${KINGCODE_NODE_VERSION:-v24.19.0}"   # ≥22.19.0 是硬下限，见 README
DSH_VERSION="${KINGCODE_DSH_VERSION:-0.1.2-alpha.3}"   # 与开发机验证过的同一版（alpha 通道，见仓库 README）
PNPM_VERSION="${KINGCODE_PNPM_VERSION:-9.12.3}"
REPO_URL="${KINGCODE_REPO_URL:-https://github.com/Promethues0/kingcode.git}"
REPO_DIR="${KINGCODE_REPO:-$HOME/kingcode}"
KINGCODE_HOME="${DSH_HOME:-$HOME/.kingcode}"
NPM_PREFIX="${KINGCODE_NPM_PREFIX:-$HOME/.local/npm-global}"
NODE_ROOT="${KINGCODE_NODE_ROOT:-$HOME/.local/node-$NODE_VERSION}"
REGISTRY=''
SKIP_SYSTEM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)      REGISTRY='https://registry.npmmirror.com'
                   # registry 只管 npm 包。Node 的 tarball 和 **node-gyp 编译 node-pty 时
                   # 要下的 headers** 走的是另一条路（disturl），不跟着 registry 走——
                   # 这是全流程里唯一一个既没镜像旋钮、也最容易在墙内卡住的强制外网下载。
                   # cdn.npmmirror.com/binaries/node 下 headers 与 SHASUMS256.txt 都实测可达。
                   : "${KINGCODE_NODE_MIRROR:=https://cdn.npmmirror.com/binaries/node}"
                   : "${KINGCODE_DISTURL:=https://cdn.npmmirror.com/binaries/node}"
                   shift ;;
    --registry)    REGISTRY="$2"; shift 2 ;;
    --repo)        REPO_DIR="$2"; shift 2 ;;
    --skip-system) SKIP_SYSTEM=1; shift ;;
    --node)        NODE_VERSION="$2"; NODE_ROOT="$HOME/.local/node-$2"; shift 2 ;;
    -h|--help)     sed -n '2,12p' "$0"; exit 0 ;;
    *) printf '未知参数：%s（-h 看用法）\n' "$1" >&2; exit 2 ;;
  esac
done

# 归一成绝对路径。不做的话有两处会咬人：npm ci 之前 `cd "$REPO_DIR"` 成功，之后再拼
# "$REPO_DIR/profile/setup.sh" 就指向了仓库内部的相对位置——十几分钟的 npm ci 白跑，
# 而报错说的是「setup.sh 失败」，指着错的地方；下面 /mnt/linux_share 的护栏也是对
# 原始字符串做字面前缀匹配，`--repo .` 之类会整个绕过去。
case "$REPO_DIR" in /*) ;; *) REPO_DIR="$PWD/$REPO_DIR" ;; esac
case "$KINGCODE_HOME" in /*) ;; *) KINGCODE_HOME="$PWD/$KINGCODE_HOME" ;; esac

step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
warn()  { printf '  \033[33m! %s\033[0m\n' "$*"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

printf '========== KingCode → 鸿蒙 PC（融合开发引擎）==========\n'
info "Node $NODE_VERSION ・ dsh $DSH_VERSION ・ pnpm $PNPM_VERSION"
info "仓库 $REPO_DIR ・ harness home $KINGCODE_HOME"
[ -n "$REGISTRY" ] && info "npm registry $REGISTRY"

# ── 0. 体质检查 ────────────────────────────────────────────────────────────
step '0/8 体质检查'
[ "$(id -u)" -ne 0 ] || die '别用 root 跑：装出来的东西属主会是 root，日常用的普通用户读不了。'
arch="$(uname -m)"
info "架构 $arch"
[ "$arch" = aarch64 ] || warn "架构不是 aarch64，下面按 linux-arm64 下载的 Node 可能跑不起来"
[ -n "${HOME:-}" ] || die 'HOME 没有值，后面所有路径都会错'
case "$KINGCODE_HOME" in
  /mnt/linux_share/*) die "harness home 不能放共享目录：那儿的权限位不受 POSIX 管，.credentials.yaml 永远过不了 0600 检查（dsh 会以退出码 1 拒启）" ;;
esac
case "$REPO_DIR" in
  /mnt/linux_share/*) die "仓库不能放共享目录：属主是 root、符号链接与可执行位都不可靠，而 profile 里挂的是指向仓库的 pnpm link" ;;
esac

# ── 1. 系统包（C++ 工具链只为第 7 步的全局 dsh 存在）───────────────────────
step '1/8 系统包'
if [ "$SKIP_SYSTEM" -eq 1 ]; then
  info '按要求跳过'
else
  have dnf || die '找不到 dnf——这不像融合开发引擎的 openEuler。确认环境，或加 --skip-system 自行准备工具链'
  # C++ 工具链现在**大概率用不上了**，留着是保险。原委：rc.6 时代第 7 步全局装 dsh
  # 会把 node-pty 解析到 1.1.0（上游那时写的是 ^1.1.0，semver 区间撞不到预发布），
  # 那版没有 linux 预编译，必然 node-gyp rebuild，所以这一步非装工具链不可。
  # 升到 0.1.2-alpha.3 之后实测：全局 dsh 树里的 node-pty 是 1.2.0-beta.15，
  # 自带 prebuilds/linux-arm64——与本仓库 overrides 钉的是同一版，两边都不再编译。
  # 没直接删掉这几个包，是因为别的原生传递依赖将来仍可能要它们，而在这台虚拟机上
  # 「装了用不上」只是多花几分钟，「该装没装」却要重来一遍。
  info '装 git curl tar xz make gcc-c++ python3 glibc-devel ca-certificates（需要 sudo）'
  sudo dnf install -y git curl tar xz make gcc-c++ python3 glibc-devel ca-certificates \
    || die 'dnf 装包失败。先在 preflight 报告里确认这些包在源里存在、以及 sudo 可用'
fi

# ── 2. Node ────────────────────────────────────────────────────────────────
step "2/8 Node（硬下限 22.19.0）"
node_ok() {
  have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=19))?0:1)' 2>/dev/null
}
if node_ok; then
  info "已有合格的 Node $(node --version)（$(command -v node)）"
  # 记下它真正的位置：env.sh 的 PATH 快照要写这一份。写死 $NODE_ROOT 的话，
  # 这条分支下那个目录根本没被创建过，快照就指向一个不存在的路径。
  NODE_BIN="$(cd "$(dirname "$(command -v node)")" && pwd)"
elif [ -x "$NODE_ROOT/bin/node" ]; then
  info "用之前装好的 $NODE_ROOT"
  export PATH="$NODE_ROOT/bin:$PATH"
  NODE_BIN="$NODE_ROOT/bin"
else
  have node && warn "现有 Node $(node --version) 太老（会话压缩用的 node:zlib zstd API 要 22.15+，pi-ai 自报 22.19+），另装一份"
  tarball="node-$NODE_VERSION-linux-arm64.tar.xz"
  base="${KINGCODE_NODE_MIRROR:-https://nodejs.org/dist}/$NODE_VERSION"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  # 必须给超时：出网被防火墙 DROP（不是 REJECT）时，没有 --connect-timeout 的 curl
  # 会无限期挂着，--retry 救不了（它只在请求真的失败后才重试）。这套交付里
  # preflight.sh 与 kingcode-web.sh 的 curl 都带超时，偏偏这两条要走 WAN 拉几十 MB 的漏了。
  info "下载 $base/$tarball"
  curl -fSL --connect-timeout 15 --max-time 900 --retry 3 --retry-connrefused --retry-delay 3 \
    -o "$tmp/$tarball" "$base/$tarball" \
    || die "下载失败。检查外网（preflight 第四节），或用 KINGCODE_NODE_MIRROR 换源"
  info "校验 SHA256（$base/SHASUMS256.txt）"
  # 不加 -s：卡住时至少还能看见进度，静默挂起分不清「在慢慢下」和「彻底死了」
  curl -fSL --connect-timeout 15 --max-time 120 --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" \
    || die '拿不到校验和文件'
  ( cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c - ) || die 'SHA256 对不上——下到的包不完整或被中间人改过，别装'
  mkdir -p "$NODE_ROOT"
  tar -xJf "$tmp/$tarball" -C "$NODE_ROOT" --strip-components=1 || die '解压失败（xz 装了吗）'
  export PATH="$NODE_ROOT/bin:$PATH"
  NODE_BIN="$NODE_ROOT/bin"
  info "装好 $(node --version) → $NODE_ROOT"
fi
node_ok || die "Node 还是不合格（$(node --version 2>/dev/null || echo '没有')）。需要 ≥22.19.0"

# ── 3. npm 与全局前缀 ──────────────────────────────────────────────────────
step '3/8 npm 全局前缀'
mkdir -p "$NPM_PREFIX"
# 用环境变量而不是 `npm config set`：后者会**永久重写用户的 ~/.npmrc**——把全局
# prefix 换掉（之前装的全局 CLI 从 npm ls -g 里集体消失）、把 registry 钉死
# （此后这台机器上每一次与 KingCode 无关的 npm install 都改道）。旧值没有备份、
# 也没人告诉过用户。npm_config_* 只作用于本次进程，效果一样、零污染。
export npm_config_prefix="$NPM_PREFIX"
[ -n "$REGISTRY" ] && export npm_config_registry="$REGISTRY"
# 第 7 步全局装 dsh 时 node-gyp 编译 node-pty@1.1.0，按 disturl 去下 node headers
# （默认 nodejs.org/dist）。不跟着 registry 走，所以要单独给。
# （仓库自己的 npm ci 走预编译，不碰 disturl。）
[ -n "${KINGCODE_DISTURL:-}" ] && export npm_config_disturl="$KINGCODE_DISTURL"
export PATH="$NPM_PREFIX/bin:$PATH"
info "prefix=$NPM_PREFIX（仅本次进程，不写 ~/.npmrc）  npm $(npm --version)  registry=$(npm config get registry)"

# ── 4. PATH 快照（给 kingcode-web.sh 与自启用）──────────────────────────────
step '4/8 写 PATH 快照'
mkdir -p "$KINGCODE_HOME"
cat > "$KINGCODE_HOME/env.sh" <<ENVEOF
# KingCode 的 PATH 快照（install.sh 生成）。
# 非交互式地拉起服务时（.bashrc 之外的路径、计划任务），交互式 shell 的 PATH
# 不一定在，node 与 dsh 要靠这份才找得到。
export PATH="$NODE_BIN:$NPM_PREFIX/bin:\$PATH"
# 让位于显式设置：写死的话，\`DSH_HOME=~/别的home ./kingcode-web.sh start\` 会被
# 这一行悄悄改回来（kingcode-web.sh 是先 source 本文件、再算默认值的），
# 于是服务起在了用户没打算用的 home 上，还不报错。
export DSH_HOME="\${DSH_HOME:-$KINGCODE_HOME}"
ENVEOF
info "$KINGCODE_HOME/env.sh"
# 去重判据要用真实路径：写死字面量 kingcode 的话，DSH_HOME 换个名字就永不命中，
# 每跑一次往 .bashrc 追加一段。
if ! grep -qF "$KINGCODE_HOME/env.sh" "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# KingCode\n[ -f "%s/env.sh" ] && . "%s/env.sh"\n' "$KINGCODE_HOME" "$KINGCODE_HOME" >> "$HOME/.bashrc"
  info '已把它接进 ~/.bashrc（新开的终端自动生效）'
fi

# ── 5. 仓库 ────────────────────────────────────────────────────────────────
step '5/8 仓库'
if [ -d "$REPO_DIR/.git" ]; then
  info "已有 $REPO_DIR，跳过 clone（要更新自己 git pull）"
elif [ -d "$REPO_DIR" ] && [ -f "$REPO_DIR/package.json" ]; then
  info "$REPO_DIR 是个非 git 的仓库副本，直接用"
  warn 'test-env-context 那条测试要求 cwd 是未 detached 的 git 工作树，非 git 副本会让 npm test 崩——不是代码 bug'
else
  have git || die '没有 git'
  info "clone $REPO_URL → $REPO_DIR"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR" || die "clone 失败。检查网络，或用 --repo 指向已经拷过来的副本"
fi
[ -f "$REPO_DIR/package.json" ] || die "$REPO_DIR 里没有 package.json"
[ -f "$REPO_DIR/jsconfig.json" ] || warn 'jsconfig.json 不在——LSP 的 findReferences 会静默给出不完整结论（它没被 npm pack 打进包，必须走 git 工作树）'
# 拿到的这份仓库到底含不含鸿蒙部署这批改动？clone 只能拿到**已提交**的东西，
# 而本脚本自己、改过的 setup.sh 与 cordis.patch.yml 可能还躺在开发机的工作树里。
# 不查的话：装完一切正常，直到 harness home 还是老的 ~/.dsh（setup.sh 是旧版）——
# 这种极难现场定位。
#
# 曾经这里还查过 plugins/insecure-context-shim.js 在不在、profile 补丁挂没挂它。
# 那个垫片在 dsh 0.1.2-alpha.1 之后已经冗余并删除（上游 dsh-util-crypto 收编了全部
# crypto.randomUUID 调用点），所以两条检查一并去掉——留着的话，装一份**正确的**新代码
# 反而会被 die 掉。
for required in deploy/harmonyos-pc/kingcode-web.sh; do
  [ -f "$REPO_DIR/$required" ] \
    || die "$REPO_DIR 里没有 $required：这份代码不含鸿蒙部署那批改动。clone 只拿得到已提交的东西——先在开发机上把它们提交并推送，或用 --repo 指向一份完整的工作树拷贝"
done
grep -q '\.kingcode' "$REPO_DIR/profile/setup.sh" \
  || die "$REPO_DIR/profile/setup.sh 还是老版（harness home 仍指 ~/.dsh）。同上，先提交推送"
if [ -f "$REPO_DIR/.env" ]; then
  warn "$REPO_DIR/.env 存在：CLI 形态下它会**压过** ~/.kingcode/.credentials.yaml（bin/kingcode.js 用的是 loadEnv，把 .env 摊平进 process.env）。两处 key 不一致时以 .env 为准。"
fi

# ── 6. 依赖 ────────────────────────────────────────────────────────────────
step '6/8 npm ci（node-pty 走 linux-arm64 预编译，不再现场编译）'
cd "$REPO_DIR"
# 刻意不加 --omit=dev / --omit=optional：
#   --omit=dev      会抽掉 LSP 的 tsc 平台二进制（cordis.yml 按路径直接拼它，boot 期硬失败）
#   --omit=optional 会抽掉 ripgrep 与 koffi 的 linux 二进制
npm ci || die 'npm ci 失败。node-pty 已钉 1.2.0-beta.15（带 linux-arm64 预编译），不该死在编译上——先查网络/registry；若日志里真在跑 node-gyp，说明这份 lock 没带 overrides 那次提交，回开发机 git pull 再拷'
info "依赖装好（$(find node_modules -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ') 个顶层条目）"
if [ -d node_modules/@typescript/typescript-linux-arm64 ]; then
  info 'LSP 的 linux-arm64 tsc 到位'
else
  warn 'LSP 平台二进制没装上——lsp 工具会在 boot 期失败（不是静默降级）。实在装不上就用 KINGCODE_LSP=0 关掉整组 LSP'
fi
if [ -d node_modules/node-pty/build ] || [ -d node_modules/node-pty/prebuilds/linux-arm64 ]; then
  info 'node-pty 的 linux 产物到位（bash 工具靠它）'
else
  warn 'node-pty 既没有编译产物也没有 linux 预编译——bash 工具会在 boot 期失败，回头看上面 npm ci 的输出'
fi

# ── 7. dsh / pnpm / profile ────────────────────────────────────────────────
step '7/8 dsh + pnpm + profile'
# 必须显式钉版本：@deepseek-ai/dsh 的 latest 已经漂到别的小版本线，
# 与本仓库验证过的组合树不是同一份。
npm i -g "@deepseek-ai/dsh@$DSH_VERSION" "pnpm@$PNPM_VERSION" || die '全局装 dsh/pnpm 失败'
have dsh  || die "dsh 装完却不在 PATH 上（prefix=$NPM_PREFIX）"
have pnpm || die 'pnpm 装完却不在 PATH 上——dsh plugin add 是直接 spawn "pnpm"，shell 别名/函数不算数'
info "dsh $(dsh --version 2>&1 | head -1) ・ pnpm $(pnpm --version)"
# 顺序不能反：setup.sh 把仓库 link 进 profile，被 link 的插件在仓库原位加载、
# 从仓库自己的 node_modules 解析依赖，所以必须先 npm ci 再 setup。
DSH_HOME="$KINGCODE_HOME" bash "$REPO_DIR/profile/setup.sh" || die 'profile/setup.sh 失败'

# ── 8. 凭证与冒烟 ──────────────────────────────────────────────────────────
step '8/8 凭证'
CREDS="$KINGCODE_HOME/.credentials.yaml"
if [ -n "${DEEPSEEK_API_KEY:-}" ] && [ ! -f "$CREDS" ]; then
  umask 177
  printf 'DEEPSEEK_API_KEY: %s\n' "$DEEPSEEK_API_KEY" > "$CREDS"
  chmod 600 "$CREDS"
  info "已写 $CREDS（0600）"
elif [ -f "$CREDS" ]; then
  mode="$(stat -c '%a' "$CREDS" 2>/dev/null || echo '?')"
  info "$CREDS 已存在（权限 $mode）"
  # 判据要和 dsh 自己的一致：它只要求**组与其他位全为 0**（dsh-credentials-local
  # 里是 `mode & 0o77`），0400 是合法的。写成 `= 600` 会对一次完全成功的安装报错，
  # 还倒过来劝人把权限放松。
  [ "$mode" = '?' ] && die "读不到 $CREDS 的权限位（stat 没跑起来），无法判断是否安全"
  [ $(( 8#$mode & 8#77 )) -eq 0 ] \
    || die "$CREDS 的组/其他位不能有权限（现在 $mode），dsh 会在 boot 期以退出码 1 拒启：chmod 600 $CREDS"
else
  warn "还没有凭证。二选一："
  info "  echo 'DEEPSEEK_API_KEY: sk-你的key' > $CREDS && chmod 600 $CREDS"
  info "  或在启动前 export DEEPSEEK_API_KEY=sk-你的key（环境变量优先级最高）"
fi

printf '\n\033[1m========== 装完了 ==========\033[0m\n'
cat <<DONE
  新开一个终端（或 . $KINGCODE_HOME/env.sh）让 PATH 生效，然后：

  CLI 形态：
      cd $REPO_DIR && node bin/kingcode.js "介绍一下这个仓库"
      （想全局用 kingcode 命令：cd $REPO_DIR && npm link）

  Web 形态（宿主浏览器访问）：
      $REPO_DIR/deploy/harmonyos-pc/kingcode-web.sh start
      $REPO_DIR/deploy/harmonyos-pc/kingcode-web.sh status   # 四项体检，跨机 /api 要 200
      $REPO_DIR/deploy/harmonyos-pc/kingcode-web.sh url      # 宿主该开哪个地址

  更新（重要）：
      cd $REPO_DIR && git pull && npm ci && ./profile/setup.sh
      profile 里的补丁层与 preset 是 setup.sh **拷**进去的，git pull 不会刷新它们——
      光 pull 不重跑 setup.sh，跑的还是上一版的身份句与预设。

  自检（不花模型钱）：
      cd $REPO_DIR && npm test
  真发一次请求（要 key）：
      cd $REPO_DIR && npm run smoke
DONE
