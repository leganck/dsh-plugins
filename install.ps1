<#
.SYNOPSIS
  安装本仓库的 DSH 插件。

.DESCRIPTION
  官方路径（cordis-plugin-development skill 推荐）：
    用 `plugin_manager` 的 `install_bundle`。skill 原文说的是传**包目录的绝对路径**：
      "use ordinary workspace files to author a bundle, then `plugin_manager` with
       `action: install_bundle` and the absolute package directory as `target`"
      "Do not write the profile's package.json or cordis.patch.yml ... `install_bundle`
       performs those steps"

  **但本仓库推荐传 `release/` 里的 `.tgz`，而不是包目录**（实测差异）：
    - 目录 → pnpm 用 `link:`（软链）→ **源码目录成为运行时依赖**，删/移/`git clean` 即静默失效；
      好处是"改源码 → 重启即生效"。
    - `.tgz` → pnpm 解包成**实体安装** → 源码目录与运行时解耦，版本固定；
      代价是改代码要重新打包 + 重装。
  本脚本在存在 `.tgz` 时打印 tarball 调用，否则回落到包目录调用。

  为什么这个脚本不能自己完成官方安装：`install_bundle` 是 **agent 工具**，不是 CLI 命令。
  本机 CLI 那条路也走不通 —— `dsh plugin --profile desktop` 直接拒绝：

      error: profile "desktop" is managed exclusively by the Electron application

  所以脚本能做的、也应该做的是三件事：
    1. 检查前置条件（profile 是否启用了 plugin_manager 工具）
    2. 打印出应当交给 agent 执行的确切 install_bundle 调用
    3. 用 `-Mode Legacy` 时提供退路：复制到 bundle 目录 + 手写 file:// 补丁行
       （**非官方路径**，代价见 README「按官方 skill 的合规性」；仅在 plugin_manager
        不可用时使用）

.PARAMETER Mode
  Official（默认）：只做前置检查并打印 install_bundle 调用，不改任何 profile 状态。
  Legacy：退回旧做法（复制目录 + 写 file:// 补丁行）。非官方路径。

.PARAMETER Plugin
  all（默认）| memory-archive | code-index

.PARAMETER BundleRoot
  Legacy 模式的安装目录，默认 C:\Users\you\dsh-bundles

.PARAMETER ProfileConfig
  要检查/写入的 profile 补丁层

.PARAMETER DryRun
  只打印将要做什么，不落盘

.EXAMPLE
  pwsh -File install.ps1                      # 官方路径：前置检查 + 打印该执行的调用
  pwsh -File install.ps1 -Mode Legacy         # 退路：复制 + 手写补丁行
#>
[CmdletBinding()]
param(
  [ValidateSet('Official', 'Legacy')]
  [string]$Mode = 'Official',
  [ValidateSet('all', 'memory-archive', 'code-index')]
  [string]$Plugin = 'all',
  [string]$BundleRoot = 'C:\Users\you\dsh-bundles',
  [string]$ProfileConfig = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'),
  [switch]$SkipNpm,
  [switch]$FetchModel,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Head($msg) { Write-Host "`n=== $msg ===" }

$plugins = @{
  'memory-archive' = @{ Dir = 'plugins\dsh-memory-archive'; Id = 'memory-archive'; Pkg = 'dsh-memory-archive' }
  'code-index'     = @{ Dir = 'plugins\dsh-code-index';     Id = 'code-index';     Pkg = 'dsh-code-index' }
}
$targets = if ($Plugin -eq 'all') { @('memory-archive', 'code-index') } else { @($Plugin) }

# ------------------------------------------------------------------ 前置条件
function Test-PluginManagerEnabled([string]$configPath) {
  if (-not (Test-Path $configPath)) { return @{ ok = $false; why = "找不到补丁层 $configPath" } }
  $text = [System.IO.File]::ReadAllText($configPath)
  # 找 `- id: tool-plugin-manager` 的行块，看它是不是被覆盖成 disabled: false
  if ($text -notmatch '(?ms)^\s*-\s*id:\s*tool-plugin-manager\s*$(.*?)(?=^\s*-\s|\z)') {
    return @{ ok = $false; why = 'profile 补丁层里没有 tool-plugin-manager 覆盖行（该行被 shipped patch 默认置为 disabled: true）' }
  }
  $block = $Matches[1]
  if ($block -match 'disabled:\s*false') { return @{ ok = $true } }
  return @{ ok = $false; why = '补丁层里 tool-plugin-manager 未显式设为 disabled: false' }
}

Write-Head '1. 前置条件：plugin_manager 工具是否可用'
$pm = Test-PluginManagerEnabled $ProfileConfig
if ($pm.ok) {
  Write-Step '✅ 补丁层已启用 tool-plugin-manager'
} else {
  Write-Step "❌ 未启用：$($pm.why)"
  Write-Step ''
  Write-Step '   修复：在 profile 补丁层追加以下 4 行（按 id 覆盖 shipped 行，是本文件的常规用法）'
  Write-Step '     - id: tool-plugin-manager'
  Write-Step "       name: '@deepseek-ai/dsh-plugin-manager/tools'"
  Write-Step '       disabled: false'
  Write-Step '   然后重启 DSH 应用。注意本 profile 由应用独占管理，CLI 那条路不可用：'
  Write-Step '     dsh plugin --profile desktop ...  → error: managed exclusively by the Electron application'
  if ($Mode -eq 'Official') {
    Write-Step ''
    Write-Step '   官方路径暂不可用，可先用 -Mode Legacy 装，或先启用 plugin_manager。'
  }
}

# ------------------------------------------------------------------ 官方路径
if ($Mode -eq 'Official') {
  Write-Head '2. 官方路径：交给 agent 执行 install_bundle'
  foreach ($name in $targets) {
    $dir = (Resolve-Path (Join-Path $repoRoot $plugins[$name].Dir)).Path
    # 优先用 release/ 里的 .tgz：目录会走成 link:（源码目录成为运行时依赖）
    $tgz = Get-ChildItem (Join-Path $dir 'release') -Filter '*.tgz' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1
    $target = if ($tgz) { $tgz.FullName } else { $dir }
    Write-Step "$name"
    if ($tgz) {
      Write-Step "  目标（tarball，推荐）：$($tgz.FullName)"
    } else {
      Write-Step "  目标目录：$dir"
      Write-Step '  ⚠️ 没有 release/*.tgz，将走成 link:（软链）—— 源码目录会成为运行时依赖'
    }
    Write-Step '  调用：'
    # 注意：PowerShell 里反斜杠不是转义符，拼接时用单引号 + 变量，别写 \" 
    Write-Step ('    plugin_manager(action: "install_bundle", target: "' + $target + '")')
  }
  Write-Step ''
  Write-Step '判定是否生效（读机器可读回执，不看日志/进程列表）：'
  Write-Step '  - install_bundle 返回的 application / warnings / pendingBuilds'
  Write-Step '  - application：applied=热生效；restart-required=要重启；failed=看 error.code'
  Write-Step '  - 再 list_bundles / list_plugins 复核 installed / enabled / fiberPhase'
  Write-Step '  - 本 profile 没有 cordis_* 工具，拿不到 cordis_inspect_query'
  Write-Step ''
  Write-Step '两个实测坑：'
  Write-Step '  - approvedBuilds 只在该包"待决定"时传；已批准过的名字再传 → stale-approval（pnpm 不跑）'
  Write-Step '  - 带生命周期脚本的重依赖包可能撞 service 侧 idleTimeoutMs(600s) 超时并回滚；'
  Write-Step '    先跑一次把构建产物落进 pnpm store，重试通常即秒级完成'
  Write-Step ''
  Write-Step '安装后 profile 的 cordis.patch.yml 里**不应**再有本插件的 - insert: 块 ——'
  Write-Step 'install_bundle 会写 profile 的 package.json / 锁文件与 bundle 选择；'
  Write-Step '若此前用手写 insert 行装过，请一并删除以免同一 id 两处定义。'
  Write-Step 'bundle 未提供的配置项（如 code-index 的 roots）要在补丁层按 id 覆盖行补，'
  Write-Step '否则会用默认值 —— roots 默认空 = 允许任意路径，白名单会静默消失。'
  return
}

# ------------------------------------------------------------------ Legacy 退路
Write-Head '2. Legacy：复制源码到 bundle 目录'
foreach ($name in $targets) {
  $src = Join-Path $repoRoot $plugins[$name].Dir
  $dst = Join-Path $BundleRoot $plugins[$name].Pkg
  if (-not (Test-Path (Join-Path $src 'index.js'))) { throw "源码缺 index.js：$src" }
  Write-Step "$name : $src → $dst"
  if ($DryRun) { Write-Step '        (DryRun：跳过复制)'; continue }
  robocopy $src $dst /E /XD node_modules dist release .git /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  Write-Step '        完成'
}

if (($targets -contains 'code-index') -and -not $SkipNpm) {
  Write-Head '3. code-index 依赖（约 661 MB；已装过可加 -SkipNpm）'
  $dst = Join-Path $BundleRoot $plugins['code-index'].Pkg
  if ($DryRun) {
    Write-Step "(DryRun：会在 $dst 执行 npm install)"
  } elseif (Test-Path (Join-Path $dst 'node_modules\onnxruntime-node')) {
    Write-Step '  已存在，跳过'
  } else {
    Push-Location $dst
    try {
      & npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
      & npm install-scripts approve onnxruntime-node
      & npm rebuild onnxruntime-node --foreground-scripts --registry=https://registry.npmmirror.com
    } finally { Pop-Location }
    if (Test-Path (Join-Path $dst 'node_modules\onnxruntime-node\bin\napi-v6\win32\x64\DirectML.dll')) {
      Write-Step '  DirectML.dll 就位'
    } else { Write-Step '  ⚠️ 未找到 DirectML.dll（GPU 路径会退化为 CPU）' }
  }
}

if ($FetchModel -and ($targets -contains 'code-index')) {
  Write-Head '4. 拉取嵌入模型'
  $md = Join-Path $env:USERPROFILE '.dsh\models\bge-small-zh-v1.5'
  $base = 'https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master'
  if ($DryRun) { Write-Step "(DryRun：会下载到 $md)" }
  else {
    New-Item -ItemType Directory -Path $md -Force | Out-Null
    foreach ($f in @('onnx/model_fp16.onnx', 'onnx/model_int8.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json')) {
      $out = Join-Path $md (Split-Path $f -Leaf)
      if (Test-Path $out) { Write-Step "  已有 $(Split-Path $f -Leaf)"; continue }
      & curl.exe -sSL -o $out "$base/$f"
      Write-Step "  下载 $(Split-Path $f -Leaf)"
    }
  }
}

Write-Head '5. 写 file:// 补丁行（非官方路径）'
$text = [System.IO.File]::ReadAllText($ProfileConfig)
foreach ($name in $targets) {
  $spec = $plugins[$name]
  if ($text -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($spec.Id))\s*$") {
    Write-Step "$($spec.Id)：已存在，跳过"
    continue
  }
  $bundle = Join-Path $BundleRoot $spec.Pkg
  $block = @(
    ''
    "# $(Get-Date -Format 'yyyy-MM-dd') —— install.ps1 -Mode Legacy 插入（非官方路径）"
    '- insert:'
    "    - id: $($spec.Id)"
    "      name: `"file:///$(($bundle -replace '\\', '/'))/index.js`""
  )
  if ($DryRun) { $block | ForEach-Object { Write-Step "  将追加: $_" } }
  else {
    [System.IO.File]::AppendAllText($ProfileConfig, ($block -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $text += ($block -join "`n")
    Write-Step "$($spec.Id)：已追加（记得按需补 config）"
  }
}
Write-Step ''
Write-Step '⚠️ 这是退路：手写行绕过了 install_bundle 的清单/patch/校验与结构化回执，'
Write-Step '   历史上正因此出现过"插件静默不生效"的排查困难。能用官方路径时请优先用它。'
Write-Step '   改完补丁层需要重启应用（cordis 不会重新 import 已加载的模块）。'
