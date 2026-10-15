<#
.SYNOPSIS
  安装本仓库里的 DSH 插件：源码 → bundle 目录 → 幂等写入 profile 的 cordis.patch.yml。

.DESCRIPTION
  两个插件各自的两步都做完：
    1. 把 plugins/<name>/ 复制到 <BundleRoot>/dsh-<name>/（跳过 node_modules / dist）
    2. 在 profile 补丁层里插入一条 `- insert: - id: <name>` 行（已存在则跳过）

  为什么需要第 2 步：本机没有任何插件安装入口（`plugin_manager` 工具默认 disabled、
  `dsh plugin --profile desktop` 被应用独占管理拒绝、Web 侧没有插件页），
  cordis.patch.yml 就是这个 profile 的用户补丁层 —— 直接插入插件行是既定做法。

  注意：补丁层对**已存在的行**是热加载的，但**新插入的行要重启应用**才生效。

.PARAMETER Plugin
  all（默认）| memory-archive | code-index

.PARAMETER BundleRoot
  插件安装目录，默认 C:\Users\you\dsh-bundles

.PARAMETER ProfileConfig
  要写入的补丁层，默认 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml

.PARAMETER SkipNpm
  跳过 code-index 依赖安装（onnxruntime-node 原生二进制约 661 MB，已装过就不必重复）

.PARAMETER SkipPatch
  只复制文件，不改 cordis.patch.yml

.PARAMETER FetchModel
  code-index 额外从 ModelScope 拉取 bge-small-zh-v1.5 的 ONNX 模型到 ~/.dsh/models/

.PARAMETER DryRun
  只打印将要做什么，不落盘

.EXAMPLE
  pwsh -File install.ps1 -Plugin all
  pwsh -File install.ps1 -Plugin code-index -SkipNpm -DryRun
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'memory-archive', 'code-index')]
  [string]$Plugin = 'all',
  [string]$BundleRoot = 'C:\Users\you\dsh-bundles',
  [string]$ProfileConfig = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'),
  [switch]$SkipNpm,
  [switch]$SkipPatch,
  [switch]$FetchModel,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Head($msg) { Write-Host "`n=== $msg ===" }

# 每个插件的补丁配置块。archiveDir / indexDirBase 放在用户 DSH 目录，不放工作区：
# 这些是运行期数据（逐字工具输出、向量索引），不该进代码仓库也不该被工作区清理波及。
$plugins = @{
  'memory-archive' = @{
    Dir  = 'plugins\dsh-memory-archive'
    Id   = 'memory-archive'
    Pkg  = 'dsh-memory-archive'
    Patch = @(
      '        archiveDir: "C:/Users/you/.dsh/archive"'
      '        includeToolResults: true'
      '        redact: true'
      '        announce: true'
    )
  }
  'code-index' = @{
    Dir  = 'plugins\dsh-code-index'
    Id   = 'code-index'
    Pkg  = 'dsh-code-index'
    Patch = @(
      '        indexDirBase: "C:/Users/you/.dsh/code-index"'
      '        roots:'
      '          - "D:/Code"'
      '        embedding:'
      '          backend: "auto"'
      '          modelDir: "C:/Users/you/.dsh/models/bge-small-zh-v1.5"'
    )
  }
}

$targets = if ($Plugin -eq 'all') { @('memory-archive', 'code-index') } else { @($Plugin) }

function To-FileUrl([string]$p) { 'file:///' + ($p -replace '\\', '/') }

# ---------------------------------------------------------------- 1. 复制源码
Write-Head '1. 复制源码到 bundle 目录'
foreach ($name in $targets) {
  $spec = $plugins[$name]
  $src = Join-Path $repoRoot $spec.Dir
  $dst = Join-Path $BundleRoot $spec.Pkg
  if (-not (Test-Path (Join-Path $src 'index.js'))) { throw "源码缺 index.js：$src" }
  Write-Step "$name : $src"
  Write-Step "        → $dst"
  if ($DryRun) { Write-Step '        (DryRun：跳过复制)'; continue }
  # /E 递归但不 purge：目标目录里的 _loaded.json 会被插件自己在加载时重建
  robocopy $src $dst /E /XD node_modules dist release .git /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  Write-Step '        完成'
}

# ---------------------------------------------------------------- 2. 依赖
$needsNpm = $targets -contains 'code-index'
if ($needsNpm -and -not $SkipNpm) {
  Write-Head '2. 安装 code-index 依赖（第一次约 661 MB；之后可加 -SkipNpm）'
  $dst = Join-Path $BundleRoot $plugins['code-index'].Pkg
  $nm = Join-Path $dst 'node_modules\onnxruntime-node'
  if ($DryRun) {
    Write-Step "(DryRun：会在 $dst 执行 npm install)"
  } elseif (Test-Path $nm) {
    Write-Step '  已存在 node_modules/onnxruntime-node，跳过（要重装加 -Force 后手动删目录）'
  } else {
    Push-Location $dst
    try {
      & npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
      # 新版 npm 拦 postinstall，而 onnxruntime-node 的原生二进制（含 DirectML.dll）靠它下载
      & npm install-scripts approve onnxruntime-node
      & npm rebuild onnxruntime-node --foreground-scripts --registry=https://registry.npmmirror.com
    } finally { Pop-Location }
    $dml = Join-Path $nm 'bin\napi-v6\win32\x64\DirectML.dll'
    if (Test-Path $dml) { Write-Step '  DirectML.dll 就位（GPU 路径可用）' }
    else { Write-Step '  ⚠️ 未找到 DirectML.dll：GPU 路径会退化成 CPU' }
  }
} elseif ($needsNpm) {
  Write-Head '2. 依赖安装被 -SkipNpm 跳过'
}

# ---------------------------------------------------------------- 3. 模型（可选）
if ($FetchModel -and ($targets -contains 'code-index')) {
  Write-Head '3. 拉取嵌入模型（ModelScope 镜像）'
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

# ---------------------------------------------------------------- 4. 补丁层
if (-not $SkipPatch) {
  Write-Head '4. 写入 profile 补丁层（幂等）'
  if (-not (Test-Path $ProfileConfig)) { throw "找不到补丁层：$ProfileConfig" }
  $text = [System.IO.File]::ReadAllText($ProfileConfig)
  $added = 0
  foreach ($name in $targets) {
    $spec = $plugins[$name]
    if ($text -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($spec.Id))\s*$") {
      Write-Step "$($spec.Id)：已存在，跳过"
      continue
    }
    $bundle = Join-Path $BundleRoot $spec.Pkg
    $block = @(
      ''
      "# $(Get-Date -Format 'yyyy-MM-dd') —— install.ps1 插入：$($spec.Pkg)"
      '- insert:'
      "    - id: $($spec.Id)"
      "      name: `"$(To-FileUrl (Join-Path $bundle 'index.js'))`""
      '      config:'
    ) + ($spec.Patch | ForEach-Object { $_ })
    if ($DryRun) {
      Write-Step "$($spec.Id)：将追加以下内容"
      $block | ForEach-Object { Write-Step "      $_" }
    } else {
      [System.IO.File]::AppendAllText($ProfileConfig, ($block -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
      $text += ($block -join "`n")
      $added++
      Write-Step "$($spec.Id)：已追加"
    }
  }
  if ($added -gt 0 -or $DryRun) { Write-Step '提示：新插入的行需要**重启 DSH 应用**才会加载' }
}

# ---------------------------------------------------------------- 5. 小结
Write-Head '完成'
foreach ($name in $targets) {
  $spec = $plugins[$name]
  $dst = Join-Path $BundleRoot $spec.Pkg
  $marker = if ($name -eq 'memory-archive') { Join-Path $env:USERPROFILE '.dsh\archive\_loaded.json' } else { Join-Path $env:USERPROFILE '.dsh\code-index\_loaded.json' }
  Write-Step "$name → $dst"
  Write-Step "  加载标记（重启后应出现）：$marker"
}
Write-Step ''
Write-Step '下一步：重启 DSH 应用，然后确认加载标记出现。'
