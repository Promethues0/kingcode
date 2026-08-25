# 在 KingCode 的 harness home 下创建/更新 kingcode profile 与 kingcode agent preset
# （Windows）。
#
# 默认 home 是 %USERPROFILE%\.kingcode，不是 dsh 的 .dsh：后者跨产品共用，同机另一个
# dsh 产品的领域预设就装在那儿的 .agent-presets 下、默认预设写在那儿的 settings.yaml
# 里，共用会让 KingCode 的预设选择器列出别人的预设、新会话直接开在别人的预设上
# （设置层优先于组合层）。DSH_HOME 显式设了就听它的。
#
# 幂等：重复跑只会覆盖补丁层、重装品牌/仓库插件、重装 preset，不动会话与凭证，
# 也不碰 settings.yaml（默认预设由 profile/cordis.patch.yml 的组合层给）。
# KINGCODE_PROFILE 可改 profile 名（默认 kingcode）；preset 目录名固定为 kingcode。
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
# 写回 $env:DSH_HOME 是必须的：下面的 `dsh plugin add` 是子进程，自己再解析一次
# harness home——不设就会把插件装进默认的 .dsh，而本脚本其余部分写的是 $dshHome，
# 两边分家，boot 时报 "Cannot find package 'kingcode-web-brand'"。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.kingcode' }
$env:DSH_HOME = $dshHome
$profileName = if ($env:KINGCODE_PROFILE) { $env:KINGCODE_PROFILE } else { 'kingcode' }
$profileDir = Join-Path $dshHome "profiles\$profileName"
$presetDir = Join-Path $dshHome '.agent-presets\kingcode'

# 凭证搬家（刻意排在 dsh/pnpm 守卫**之前**）：纯 CLI 用户不需要那两个全局包，
# 搬家代码排在守卫后面的话，脚本会先以「缺少 dsh」退 1，他的 key 永远搬不过来。
# 只在目标不存在时拷，绝不覆盖，老文件不动。
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
$legacyCredentials = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$credentials = Join-Path $dshHome '.credentials.yaml'
if ((-not (Test-Path $credentials)) -and (Test-Path $legacyCredentials)) {
  Copy-Item $legacyCredentials $credentials
  Write-Host "已从 $legacyCredentials 复制一份凭证到 $credentials（原文件未改动）"
}

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
Write-Host "harness home：$dshHome"
Write-Host "profile 就绪：$profileDir"
Write-Host "preset 就绪：$presetDir（id: kingcode，新会话的默认预设）"
Write-Host "启动：直接运行 KingCode.exe（它自己会设 DSH_HOME），或在命令行里"
Write-Host "  `$env:DSH_HOME='$dshHome'; dsh --profile $profileName --port 3081"
Write-Host ''
Write-Host "提示：本脚本不改 $dshHome\settings.yaml——默认预设来自 profile 的组合层。"
Write-Host '  想换成别的预设，在 Web 的新会话预设选择器里选，或自己在 settings.yaml 里写：'
Write-Host '    agent-presets:'
Write-Host '      default: <preset-id>'
