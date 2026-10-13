<#
.SYNOPSIS
  Build the distributable artifacts for @local/dsh-memory-archive.

.DESCRIPTION
  Repeatable, and it refuses to ship an unverified build:

    1. runs the self-test (must be ALL PASSED)
    2. validates cordis.patch.yml with the loader's own YAML dialect
       (js-yaml, taken from the local dsh-src checkout)
    3. npm pack -> dist/<name>-<version>.tgz   (installable via pnpm / dsh plugin add)
    4. Compress-Archive -> dist/dsh-memory-archive-<version>.zip  (copy-the-files form)
    5. writes dist/SHA256SUMS.txt
    6. copies all three into the tracked release/ dir, so a plain browser link
       (-/raw/<tag>/release/<file> or the release downloads path) can serve them.
       The package-registry API URLs need a token and answer a browser with a
       401 JSON body -- that is NOT a usable download link.

  Run it with the bundled Node/npm, e.g.:
    pwsh -File build-plugin-dist.ps1
#>
[CmdletBinding()]
param(
  [string]$PackageDir,
  [string]$NodeExe,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
# Default to the bundle under plugins/, so the script can live at the repo root
# while the package stays self-contained.
$defaultPkg = Join-Path $PSScriptRoot 'plugins\dsh-memory-archive'
$root = if ($PackageDir) { [System.IO.Path]::GetFullPath($PackageDir) }
        elseif (Test-Path (Join-Path $defaultPkg 'package.json')) { [System.IO.Path]::GetFullPath($defaultPkg) }
        else { [System.IO.Path]::GetFullPath($PSScriptRoot) }
if (-not (Test-Path (Join-Path $root 'package.json'))) { throw "no package.json in $root" }

if (-not $NodeExe) {
  $candidate = 'C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  $NodeExe = if (Test-Path $candidate) { $candidate } else { (Get-Command node).Source }
}
if (-not (Test-Path $NodeExe)) { throw "node not found: $NodeExe" }
$nodeDir = Split-Path $NodeExe -Parent

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null

Write-Host "== @local/dsh-memory-archive $version =="
Write-Host "   package : $root"
Write-Host "   node    : $NodeExe ($(& $NodeExe -v))"
Write-Host ''

# --- 1. self-test ------------------------------------------------------------
if (-not $SkipTests) {
  Write-Host '--- 1/6 self-test ---'
  $test = & $NodeExe (Join-Path $root 'test.mjs') 2>&1
  $verdict = ($test | Where-Object { $_ -match 'CHECKS (PASSED|FAILED)' })
  $test | Where-Object { $_ -match '^FAIL' } | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0 -or $verdict -notmatch 'ALL .* CHECKS PASSED') {
    throw "self-test failed: $verdict"
  }
  Write-Host "  $verdict"
} else {
  Write-Host '--- 1/6 self-test SKIPPED (-SkipTests) ---'
}
Write-Host ''

# --- 2. validate the bundle patch under the loader dialect -------------------
Write-Host '--- 2/6 validate cordis.patch.yml ---'
$yamlCandidates = @(
  'C:\Users\you\Documents\deepseek-harness\default-workspace\dsh-comparison\dsh-src\dsh\node_modules\js-yaml\index.js'
)
$yaml = $yamlCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($null -eq $yaml) {
  Write-Host '  js-yaml not found locally; falling back to structural checks only'
} else {
  $probe = @"
import yaml from 'file:///$($yaml -replace '\\','/')'
import { readFileSync } from 'node:fs'
const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => d })
const doc = yaml.load(readFileSync(process.argv[2], 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([JsTag]) })
if (!Array.isArray(doc)) throw new Error('top level is not an array')
let rows = []
for (const e of doc) if (e && e.insert) rows = rows.concat(e.insert)
const mine = rows.filter((r) => r && r.id === 'memory-archive')
if (mine.length !== 1) throw new Error('expected exactly 1 memory-archive row, got ' + mine.length)
if (typeof mine[0].name !== 'string' || mine[0].name === '') throw new Error('row has no name')
if (typeof mine[0].config?.archiveDir !== 'string') throw new Error('row has no config.archiveDir')
console.log('OK ' + mine[0].name + '  archiveDir=' + mine[0].config.archiveDir)
"@
  $probeFile = Join-Path $env:TEMP ("validate-bundle-" + [guid]::NewGuid().ToString('N') + '.mjs')
  [System.IO.File]::WriteAllText($probeFile, $probe)
  try {
    $out = & $NodeExe $probeFile (Join-Path $root 'cordis.patch.yml') 2>&1
    if ($LASTEXITCODE -ne 0) { throw "patch validation failed: $out" }
    Write-Host "  $out"
  } finally { Remove-Item $probeFile -Force -ErrorAction SilentlyContinue }
}

# structural checks that must hold regardless of the YAML parser
$patchText = [System.IO.File]::ReadAllText((Join-Path $root 'cordis.patch.yml'))
if (([regex]::Matches($patchText, '(?m)^\s*-?\s*id:\s*memory-archive\s*$')).Count -ne 1) { throw 'cordis.patch.yml must contain exactly one memory-archive row' }
if (-not $patchText.Contains('archiveDir')) { throw 'cordis.patch.yml is missing archiveDir' }
if ($pkg.dsh.bundle.patch -ne './cordis.patch.yml') { throw 'package.json dsh.bundle.patch must point at ./cordis.patch.yml' }
Write-Host '  structural checks ok'
Write-Host ''

# --- 3. npm pack -------------------------------------------------------------
Write-Host '--- 3/6 npm pack ---'
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npm) { throw 'npm not found; cannot build the tarball' }
Get-ChildItem $dist -Filter '*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
Push-Location $root
try {
  $packed = & $npm pack --pack-destination $dist 2>&1
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "npm pack failed: $packed" }
$tgzName = ($packed | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1).Trim()
$tgz = Join-Path $dist $tgzName
if (-not (Test-Path $tgz)) { $tgz = (Get-ChildItem $dist -Filter '*.tgz' | Select-Object -First 1).FullName }
Write-Host "  $tgz  ($([int]((Get-Item $tgz).Length/1024)) KB)"
Write-Host ''

# --- 4. zip ------------------------------------------------------------------
Write-Host '--- 4/6 zip ---'
$zip = Join-Path $dist ("dsh-memory-archive-$version.zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
$stage = Join-Path $env:TEMP ("dsh-ma-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Get-ChildItem $root -Recurse -File |
  Where-Object {
    $_.FullName -notmatch '\\dist\\' -and $_.FullName -notmatch '\\node_modules\\' -and
    $_.Name -ne '_loaded.json' -and $_.Name -ne '.gitignore'
  } |
  ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    $target = Join-Path $stage $rel
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force
Write-Host "  $zip  ($([int]((Get-Item $zip).Length/1024)) KB)"
Write-Host ''

# --- 5. checksums ------------------------------------------------------------
Write-Host '--- 5/6 SHA256SUMS.txt ---'
$sums = Get-ChildItem $dist -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object Name | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  "$h  $($_.Name)"
}
$sums | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
$sums | ForEach-Object { Write-Host "  $_" }
Write-Host ''

# --- 6. copy into the tracked release/ dir -----------------------------------
Write-Host '--- 6/6 release/ (tracked static files) ---'
$rel = Join-Path $root 'release'
New-Item -ItemType Directory -Path $rel -Force | Out-Null
Get-ChildItem $dist -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $rel $_.Name) -Force
  Write-Host "  release/$($_.Name)"
}
Write-Host '  commit release/ -- the release download links resolve to these paths.'
Write-Host ''
Write-Host 'done.'
