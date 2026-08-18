#!/bin/bash
# 从 macOS / Linux 交叉编译 Windows 版（需 .NET 8 SDK 或更高）。
#
# 为什么强调 .NET 8：≤.NET 7 的 SDK 在非 Windows 主机上写不了 PE 资源，
# 产物既没有图标和版本信息，还会因为 GUI subsystem 位没设而弹出控制台窗口
# （dotnet/runtime#89303 在 8.0 修复）。
#
# 官方保留意见：EnableWindowsTargeting 用于非 Windows 平台开发，
# **正式发布仍建议在 Windows 上构建**。
set -euo pipefail
cd "$(dirname "$0")"

command -v dotnet >/dev/null || { echo "缺少 dotnet。装 .NET 8 SDK：https://dotnet.microsoft.com/download"; exit 1; }

MAJOR=$(dotnet --version | cut -d. -f1)
if [ "$MAJOR" -lt 8 ]; then
  echo "检测到 .NET SDK $(dotnet --version)，交叉编译 Windows GUI 需要 8 或更高"; exit 1
fi

# 不加 PublishReadyToRun：官方交叉编译支持表里 macOS/Linux 主机不支持 Windows 目标
dotnet publish KingCode.csproj -c Release -r win-x64 \
  --self-contained false \
  -p:PublishSingleFile=true \
  -o publish

echo
echo "构建完成：$(pwd)/publish/KingCode.exe"
echo "注意：这是交叉编译产物，未在 Windows 上运行验证过。"
