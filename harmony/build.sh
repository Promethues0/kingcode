#!/bin/bash
# 命令行构建鸿蒙壳（不开 DevEco 的 GUI）。
#
# 仓库里没有 hvigorw wrapper——用 DevEco 自带的那份，连同它自带的 Node 与 JBR。
# 这三样都在 DevEco.app 里，不用另外装。
#
#   ./build.sh              # 构建（签名与否取决于 build-profile.json5）
#   ./build.sh --install    # 构建完顺手 hdc install
#
# **签名**：仓库里的 build-profile.json5 是 "signingConfigs": []（不携带任何签名材料，
# 那些是机器本地的、绑账号绑设备的东西）。所以开箱构建出来的是 **unsigned hap**，
# hvigor 只打一条 `WARN: Will skip sign 'hos_hap'`、不会失败——照着装会报
# `code:9568320 error: no signature file`。要装到真机，先在 DevEco 里做一次：
#   打开 harmony/ → 登录华为账号 → Project Structure → Signing Configs
#   → 勾 Automatically generate signature
# DevEco 会把 signingConfigs 写回 build-profile.json5（含本机加密的口令），
# 之后这个脚本就能一路签名构建，不用再开 GUI。
# **注意别把那份带 signingConfigs 的 build-profile.json5 提交上去。**
set -euo pipefail
cd "$(dirname "$0")"

DEVECO="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"
[ -d "$DEVECO" ] || { echo "找不到 DevEco Studio：$DEVECO（用 DEVECO_HOME 指定）"; exit 1; }

export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$DEVECO/sdk}"
export JAVA_HOME="${JAVA_HOME:-$DEVECO/jbr/Contents/Home}"      # PackageHap 要 Java
export PATH="$DEVECO/tools/node/bin:$JAVA_HOME/bin:$PATH"        # hvigor 要它自带的 Node
HVIGORW="$DEVECO/tools/hvigor/bin/hvigorw"
[ -f "$HVIGORW" ] || { echo "找不到 hvigorw：$HVIGORW"; exit 1; }

echo "==> hvigor assembleHap"
# hvigorw 是 bash 脚本，别用 node 直接跑它
bash "$HVIGORW" --mode module -p product=default assembleHap --no-daemon

OUT="entry/build/default/outputs/default"
SIGNED="$OUT/entry-default-signed.hap"
UNSIGNED="$OUT/entry-default-unsigned.hap"

if [ -f "$SIGNED" ] && [ "$SIGNED" -nt "$UNSIGNED" ]; then
  HAP="$SIGNED"; echo "==> 已签名：$HAP"
else
  HAP="$UNSIGNED"
  echo "==> **未签名**：$HAP"
  echo "    build-profile.json5 里 signingConfigs 是空的，装机会报 9568320。"
  echo "    在 DevEco 里勾一次 Automatically generate signature（见本文件头注释）。"
fi

if [ "${1:-}" = "--install" ]; then
  HDC="${HDC:-$DEVECO_SDK_HOME/default/openharmony/toolchains/hdc}"
  echo "==> hdc install $HAP"
  "$HDC" install "$HAP"
fi
