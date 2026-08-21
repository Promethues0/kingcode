#!/bin/bash
# 在 $DSH_HOME 下创建/更新 kingcode profile 与 kingcode agent preset（macOS · Linux）。
# 幂等：重复跑只会覆盖补丁层、重装品牌/仓库插件、重装 preset，不动会话与凭证，
# 也不碰 $DSH_HOME/settings.yaml（默认 preset 由用户自己切，见脚本末尾的提示）。
#
# KINGCODE_PROFILE 可改 profile 名（默认 kingcode）——给临时验证用；preset 目录名
# 固定为 kingcode（带前缀，天然不与别的项目的预设冲突）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${KINGCODE_PROFILE:-kingcode}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"
PRESET="$DSH_HOME/.agent-presets/kingcode"

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
echo "profile 就绪：$PROFILE"
echo "preset 就绪：$PRESET（id: kingcode）"
echo "启动：dsh --profile $PROFILE_NAME --port 3081"
echo
echo "提示：本脚本不改 $DSH_HOME/settings.yaml。要让新会话默认用 KingCode 预设，"
echo "  在 Web 的新会话预设选择器里选「KingCode」，或在 settings.yaml 里写："
echo "    agent-presets:"
echo "      default: kingcode"
