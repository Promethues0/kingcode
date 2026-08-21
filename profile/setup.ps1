# 在 $DSH_HOME 下创建/更新 kingcode profile 与 kingcode agent preset（Windows）。
# 幂等：重复跑只会覆盖补丁层、重装品牌/仓库插件、重装 preset，不动会话与凭证，
# 也不碰 $DSH_HOME\settings.yaml（默认 preset 由用户自己切，见脚本末尾的提示）。
# KINGCODE_PROFILE 可改 profile 名（默认 kingcode）；preset 目录名固定为 kingcode。
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileName = if ($env:KINGCODE_PROFILE) { $env:KINGCODE_PROFILE } else { 'kingcode' }
$profileDir = Join-Path $dshHome "profiles\$profileName"
$presetDir = Join-Path $dshHome '.agent-presets\kingcode'

# dsh 与 pnpm 都是 .cmd shim，用 Get-Command 探测而不是测 .exe
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Write-Error '缺少 dsh：npm install -g @deepseek-ai/dsh'
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error '缺少 pnpm（dsh plugin 依赖它）：npm install -g pnpm'
}

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

# profile 根是一份空入口列表——整棵树都是 patch 层叠出来的
@'
# dsh profile root —— 空入口列表。树由 patch 层组合：
# package.json 的 dsh.profile.bundles，然后 cordis.patch.yml，最后 --patch 覆盖层。
[]
'@ | Set-Content -Path (Join-Path $profileDir 'cordis.yml') -Encoding utf8

@'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
'@ | Set-Content -Path (Join-Path $profileDir 'pnpm-workspace.yaml') -Encoding utf8

$pkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgPath)) {
  @'
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
'@ | Set-Content -Path $pkgPath -Encoding utf8
}

Copy-Item (Join-Path $repo 'profile\cordis.patch.yml') (Join-Path $profileDir 'cordis.patch.yml') -Force

# 装品牌层。-w 是必需的：pnpm 会把 profile 目录视作 workspace root
& dsh plugin --profile $profileName add -w (Join-Path $repo 'web-brand')
if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin add 失败（退出码 $LASTEXITCODE）" }

# 把仓库本身 link 成 profile 里的包 `kingcode`：preset 用 kingcode/plugins/<x>.js 引用
# 本仓库插件（理由见 presets/kingcode/agent.cordis.yml 头注释与 setup.sh）
& dsh plugin --profile $profileName add -w $repo
if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin add 失败（退出码 $LASTEXITCODE）" }

# 装 KingCode 自有 agent preset（客户端里模型姓 KingCode 的唯一途径）。只装这一个目录。
New-Item -ItemType Directory -Force -Path $presetDir | Out-Null
Copy-Item (Join-Path $repo 'presets\kingcode\preset.yml') (Join-Path $presetDir 'preset.yml') -Force
Copy-Item (Join-Path $repo 'presets\kingcode\agent.cordis.yml') (Join-Path $presetDir 'agent.cordis.yml') -Force

Write-Host ''
Write-Host "profile 就绪：$profileDir"
Write-Host "preset 就绪：$presetDir（id: kingcode）"
Write-Host "启动：dsh --profile $profileName --port 3081，或直接运行 KingCode.exe"
Write-Host ''
Write-Host "提示：本脚本不改 $dshHome\settings.yaml。要让新会话默认用 KingCode 预设，"
Write-Host '  在 Web 的新会话预设选择器里选「KingCode」，或在 settings.yaml 里写：'
Write-Host '    agent-presets:'
Write-Host '      default: kingcode'
