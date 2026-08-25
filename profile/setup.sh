#!/bin/bash
# 在 KingCode 的 harness home 下创建/更新 kingcode profile 与 kingcode agent preset
# （macOS · Linux）。
#
# 默认 home 是 ~/.kingcode，不是 dsh 的 ~/.dsh：后者跨产品共用，同机另一个 dsh 产品
# 的领域预设就装在那儿的 .agent-presets 下、默认预设写在那儿的 settings.yaml 里，
# 共用会让 KingCode 的预设选择器列出别人的预设、新会话直接开在别人的预设上
# （设置层优先于组合层）。DSH_HOME 显式设了就听它的。
#
# 幂等：重复跑只会覆盖补丁层、重装品牌/仓库插件、重装 preset，不动会话与凭证，
# 也不碰 settings.yaml（默认预设由 profile/cordis.patch.yml 的组合层给）。
#
# KINGCODE_PROFILE 可改 profile 名（默认 kingcode）——给临时验证用；preset 目录名
# 固定为 kingcode（带前缀，天然不与别的项目的预设冲突）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# 必须 export：下面的 `dsh plugin add` 是子进程，自己再解析一次 harness home——
# 不导出就会把插件装进默认的 ~/.dsh，而本脚本的其余部分写的是 $DSH_HOME，
# 两边分家，boot 时报 "Cannot find package 'kingcode-web-brand'"。
export DSH_HOME="${DSH_HOME:-$HOME/.kingcode}"
PROFILE_NAME="${KINGCODE_PROFILE:-kingcode}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"
PRESET="$DSH_HOME/.agent-presets/kingcode"

# ── 凭证搬家（刻意排在 dsh/pnpm 守卫**之前**）───────────────────────────────
# KingCode 从共用的 ~/.dsh 换到自己的 home 之后，老 home 里那份还能用的 API key
# 不该让用户重填。只在目标不存在时拷，绝不覆盖，老文件不动。
# （DSH_HOME 被显式指回 ~/.dsh 时源与目标同一个文件，-e 判断天然让这段成为空操作。）
#
# 为什么必须排在守卫之前：**纯 CLI 用户根本不需要 dsh 与 pnpm**——他只跑
# `kingcode "<task>"`，没装那两个全局包。搬家代码若排在守卫后面，脚本会先以
# 「缺少 dsh」退 1，他的 key 就永远搬不过来，升级后表现为 MISSING_CREDENTIAL。
# 这一段只用到 cp/chmod，没有任何前置。
mkdir -p "$DSH_HOME"
LEGACY_CREDENTIALS="$HOME/.dsh/.credentials.yaml"
if [ ! -e "$DSH_HOME/.credentials.yaml" ] && [ -f "$LEGACY_CREDENTIALS" ]; then
  cp "$LEGACY_CREDENTIALS" "$DSH_HOME/.credentials.yaml"
  chmod 600 "$DSH_HOME/.credentials.yaml"
  echo "已从 $LEGACY_CREDENTIALS 复制一份凭证到 $DSH_HOME/.credentials.yaml（原文件未改动）"
fi

command -v dsh >/dev/null || { echo "缺少 dsh：npm install -g @deepseek-ai/dsh"; exit 1; }
command -v pnpm >/dev/null || { echo "缺少 pnpm（dsh plugin 依赖它）：npm install -g pnpm"; exit 1; }

mkdir -p "$PROFILE"

# profile 根是一份空入口列表——整棵树都是 patch 层叠出来的，别往这里写内容
cat > "$PROFILE/cordis.yml" <<'YML'
# dsh profile root —— 空入口列表。树由 patch 层组合：
# package.json 的 dsh.profile.bundles，然后 cordis.patch.yml，最后 --patch 覆盖层。
[]
YML

cat > "$PROFILE/pnpm-workspace.yaml" <<'YML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YML

# 已存在则不动 package.json 的依赖段，只保证 bundles 正确
if [ ! -f "$PROFILE/package.json" ]; then
  cat > "$PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile-kingcode",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
JSON
fi

cp "$REPO/profile/cordis.patch.yml" "$PROFILE/cordis.patch.yml"

# 装品牌层。-w 是必需的：pnpm 会把 profile 目录视作 workspace root
dsh plugin --profile "$PROFILE_NAME" add -w "$REPO/web-brand"

# 把仓库本身 link 成 profile 里的包 `kingcode`：preset 的 agent.cordis.yml 用
# `kingcode/plugins/<x>.js` 引用本仓库插件（preset 行的包名从 profile 目录解析，
# 详见 presets/kingcode/agent.cordis.yml 头注释）。link 而非复制：插件在仓库原位
# 加载，与 CLI 同一份，且 env-context 的 @deepseek-ai/schemastery 依赖能解析。
dsh plugin --profile "$PROFILE_NAME" add -w "$REPO"

# 装 KingCode 自有 agent preset（客户端里模型姓 KingCode 的唯一途径：内置 preset 都
# 挂了自己的 dsh-persona，会遮蔽 cordis.patch.yml 里的全局 persona）。只装这一个目录，
# 不动 $DSH_HOME/.agent-presets/ 下别的预设。权限照 dsh 自己复制预设的口径收紧。
mkdir -p "$PRESET"
cp "$REPO/presets/kingcode/preset.yml" "$REPO/presets/kingcode/agent.cordis.yml" "$PRESET/"
chmod 700 "$PRESET"
chmod 600 "$PRESET/preset.yml" "$PRESET/agent.cordis.yml"

echo
echo "harness home：$DSH_HOME"
echo "profile 就绪：$PROFILE"
echo "preset 就绪：$PRESET（id: kingcode，新会话的默认预设）"
echo "启动：DSH_HOME=$DSH_HOME dsh --profile $PROFILE_NAME --port 3081"
echo "  （mac/win 客户端自己会设这个 DSH_HOME，命令行起服务时要带上）"
echo
echo "提示：本脚本不改 $DSH_HOME/settings.yaml——默认预设来自 profile 的组合层。"
echo "  想换成别的预设，在 Web 的新会话预设选择器里选，或自己在 settings.yaml 里写："
echo "    agent-presets:"
echo "      default: <preset-id>"
