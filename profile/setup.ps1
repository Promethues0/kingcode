# 在 $DSH_HOME 下创建/更新 kingcode profile（Windows）。
# 幂等：重复跑只会覆盖补丁层与重装品牌插件，不动会话与凭证。
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\kingcode'

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
& dsh plugin --profile kingcode add -w (Join-Path $repo 'web-brand')
if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin add 失败（退出码 $LASTEXITCODE）" }

# ── agent presets：把仓库里的预设装到用户预设根（幂等覆盖）─────────────────
$presetRoot = Join-Path $dshHome '.agent-presets'
New-Item -ItemType Directory -Force -Path $presetRoot | Out-Null
Get-ChildItem -Directory (Join-Path $repo 'presets') | ForEach-Object {
  $dest = Join-Path $presetRoot $_.Name
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $_.FullName $dest
  Write-Host "preset 已安装：$($_.Name) → $dest"
}

Write-Host ''
Write-Host "profile 就绪：$profileDir"
Write-Host '启动：dsh --profile kingcode --port 3081，或直接运行 KingCode.exe'
