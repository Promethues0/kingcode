# KingCode 原生路线：HiShell 里的运行环境。用法：  . deploy/harmonyos-native/env.sh
#
# 每一行都对应真机上量到的一件事（2026-09-02，HarmonyOS 7.0.0.102 / API 26）：
# - Harmonybrew 装的 node/npm/rg/clang 在 ~/.harmonybrew/bin，登录 shell 之外未必在 PATH 上；
# - DSH_HOME 不能放家目录：/storage/Users/currentUser 是 hmdfs，chmod 600 落成 660，
#   dsh-credentials-local 会以「组/其他位不为 0」拒绝启动；/data/storage/el2/base 是 hmfs，
#   mode 位如实生效（实测 600）。这也是 dsh-harmonyos 套件把 home 放 el2 的原因；
# - LSP 三行拼的是 @typescript/typescript-${platform}-${arch} 平台二进制，没有 openharmony 包，
#   不关掉就在 boot 期 fail-loud；
# - /tmp 是只读 erofs；HiShell 自己把 TMPDIR 指到家目录，够用。
export PATH="$HOME/.harmonybrew/bin:$PATH"
export DSH_HOME="${DSH_HOME:-/data/storage/el2/base/kingcode-home}"
export KINGCODE_LSP=0
export TMPDIR="${TMPDIR:-$HOME}"
mkdir -p "$DSH_HOME" && chmod 700 "$DSH_HOME"
