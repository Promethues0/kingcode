#!/bin/bash
# 在 $DSH_HOME 下创建/更新 kingcode profile（macOS · Linux）。
# 幂等：重复跑只会覆盖补丁层与重装品牌插件，不动会话与凭证。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/kingcode"

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
dsh plugin --profile kingcode add -w "$REPO/web-brand"

echo
echo "profile 就绪：$PROFILE"
echo "启动：dsh --profile kingcode --port 3081"
