# KingCode 原生路线：HiShell 里的运行环境。用法：  . scripts/env.sh
#
# 每一行都对应真机上量到的一件事（2026-09-02/03，HarmonyOS 7.0.0.102 / API 26 / HongMeng Kernel 1.13.0）：
# - Harmonybrew 装的 node/npm/rg/clang 在 ~/.harmonybrew/bin，登录 shell 之外未必在 PATH 上；
# - DSH_HOME 不能放家目录：/storage/Users/currentUser 是 hmdfs，chmod 600 落成 660，
#   dsh-credentials-local 会以「组/其他位不为 0」拒绝启动；/data/storage/el2/base 是 hmfs，
#   mode 位如实生效（实测 600）。另一条路是打 credentials-local 的补丁跳过检查（见 README 对照表），
#   换 home 不用改上游代码，所以这里选换 home；
# - LSP 三行拼的是 @typescript/typescript-${platform}-${arch} 平台二进制，没有 openharmony 包，
#   不关掉就在 boot 期 fail-loud；
# - 沙箱后端（bwrap / Landlock）在鸿蒙都不可用，受限模式会 fail-closed 抛 SANDBOX_UNAVAILABLE；
# - /tmp 是只读 erofs；HiShell 自己把 TMPDIR 指到家目录，够用。
export PATH="$HOME/.harmonybrew/bin:$PATH"
export DSH_HOME="${DSH_HOME:-/data/storage/el2/base/kingcode-home}"
export KINGCODE_LSP=0
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
export TMPDIR="${TMPDIR:-$HOME}"
# node-gyp 取 node headers 走 disturl，**不跟 npm registry**——它是全流程里唯一一个
# 既不受 KC_REGISTRY 管、又必须出网的下载，而这条路上要现编两次 node-pty。
# 姊妹路径 deploy/harmonyos-pc/install.sh 早就有这个旋钮，原生路线以前没有。
if [ -n "${KC_NODE_DISTURL:-}" ]; then export npm_config_disturl="$KC_NODE_DISTURL"; fi
mkdir -p "$DSH_HOME" && chmod 700 "$DSH_HOME"
