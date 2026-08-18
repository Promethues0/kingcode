# 构建 KingCode.exe。需要 .NET 8 SDK 或更高。
#   .\build.ps1              框架依赖（小，需目标机装 .NET 8 桌面运行时）
#   .\build.ps1 -SelfContained   自包含单文件（大，目标机无需装 .NET）
param(
  [switch]$SelfContained,
  [string]$Runtime = 'win-x64'
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error '缺少 dotnet。装 .NET 8 SDK：https://dotnet.microsoft.com/download'
  }

  $args = @(
    'publish', 'KingCode.csproj',
    '-c', 'Release',
    '-r', $Runtime,
    '-p:PublishSingleFile=true',
    '-o', 'publish'
  )
  if ($SelfContained) {
    $args += '--self-contained', 'true'
  } else {
    $args += '--self-contained', 'false'
  }
  # 刻意不加 -p:PublishReadyToRun=true：官方交叉编译支持表里 macOS/Linux
  # 主机不支持 Windows 目标，加了会在非 Windows 上构建失败。
  # 在 Windows 上构建时可以自行加上以换取更快的启动。

  Write-Host "dotnet $($args -join ' ')"
  & dotnet @args
  if ($LASTEXITCODE -ne 0) { Write-Error "构建失败（退出码 $LASTEXITCODE）" }

  $exe = Join-Path $PSScriptRoot 'publish\KingCode.exe'
  Write-Host ''
  Write-Host "构建完成：$exe"
  Write-Host '首次运行前请先初始化 profile： ..\profile\setup.ps1'
} finally {
  Pop-Location
}
