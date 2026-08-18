#!/bin/bash
# 构建 KingCode.app —— 只依赖 Xcode 命令行工具（swiftc + iconutil），无 Xcode 工程、无 npm。
# 用法：./build.sh [输出目录]   默认输出到 mac/build/
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="${1:-build}"
APP="$OUT_DIR/KingCode.app"
CONTENTS="$APP/Contents"

echo "==> 清理"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

echo "==> 编译 Swift"
# 部署目标必须显式给：swiftc 默认取 SDK 对应的最新系统版本，在当前系统上
# 会编出 minos 高于本机的二进制，LaunchServices 直接拒启（-10825）。
ARCH="$(uname -m)"
DEPLOY_TARGET="${DEPLOY_TARGET:-13.0}"
# -swift-version 5：避开 Swift 6 严格并发对 AppKit 单线程模型的报错
swiftc -swift-version 5 -O \
  -target "${ARCH}-apple-macosx${DEPLOY_TARGET}" \
  -framework AppKit -framework WebKit \
  -o "$CONTENTS/MacOS/KingCode" \
  Sources/Palette.swift Sources/KMark.swift Sources/ServerController.swift \
  Sources/LaunchView.swift Sources/main.swift

echo "==> 生成图标"
ICONSET="$OUT_DIR/KingCode.iconset"
rm -rf "$ICONSET"
"$CONTENTS/MacOS/KingCode" --make-iconset "$ICONSET" >/dev/null
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/KingCode.icns"
rm -rf "$ICONSET"

echo "==> 写 Info.plist"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>KingCode</string>
	<key>CFBundleDisplayName</key>
	<string>KingCode</string>
	<key>CFBundleIdentifier</key>
	<string>com.prometheus.kingcode</string>
	<key>CFBundleVersion</key>
	<string>0.1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleExecutable</key>
	<string>KingCode</string>
	<key>CFBundleIconFile</key>
	<string>KingCode</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>KingCode —— 基于 DeepSeek Harness 的编程智能体</string>
	<!-- 引擎跑在 127.0.0.1，WKWebView 需要放行本地明文 HTTP -->
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
PLIST

echo "==> 签名（ad-hoc，本机自用足够）"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (签名跳过，不影响本机运行)"

# Finder 有时缓存旧图标，戳一下修改时间促其刷新
touch "$APP"

echo
echo "构建完成：$(cd "$OUT_DIR" && pwd)/KingCode.app"
echo "  运行：open '$(cd "$OUT_DIR" && pwd)/KingCode.app'"
echo "  装到应用程序：cp -R '$(cd "$OUT_DIR" && pwd)/KingCode.app' /Applications/"
