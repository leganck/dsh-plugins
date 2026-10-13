<#
.SYNOPSIS
  Install or remove @local/dsh-memory-archive in a DSH profile.

.DESCRIPTION
  Copies the bundle to <DshHome>\bundles\dsh-memory-archive, backs up the target
  profile's cordis.patch.yml, and inserts one `memory-archive` row between
  managed begin/end markers. Idempotent: re-running without -Force reports the
  existing install instead of duplicating it.

  Deliberately does NOT touch the profile's package.json and does NOT run pnpm in
  the profile directory -- for a profile the Electron app manages exclusively
  (e.g. `desktop`), the user patch layer is the only supported install surface.

.PARAMETER Profile
  Profile name under <DshHome>\profiles. Defaults to $env:DSH_PROFILE, else 'desktop'.

.PARAMETER DshHome
  DSH home. Defaults to $env:DSH_HOME, else ~/.dsh.

.PARAMETER BundleDir
  Where to copy the bundle. Defaults to <DshHome>\bundles\dsh-memory-archive.

.PARAMETER ArchiveDir
  Value for the archiveDir config. Defaults to an absolute <DshHome>\archive with
  forward slashes (old plugin code does not expand `~`).

.PARAMETER Uninstall
  Remove the managed block from the profile patch.

.PARAMETER DryRun
  Print the planned changes and write nothing.

.PARAMETER Force
  Reinstall over an existing managed block.

.EXAMPLE
  pwsh -File install.ps1 -Profile desktop -DryRun
  pwsh -File install.ps1 -Profile desktop
  pwsh -File install.ps1 -Profile desktop -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [string]$DshHome,
  [string]$BundleDir,
  [string]$ArchiveDir,
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$BEGIN = '# >>> dsh-memory-archive (managed by install.ps1) >>>'
$END = '# <<< dsh-memory-archive <<<'
$ROW_ID = 'memory-archive'
$PLUGIN_ENTRY = 'index.js'

# --- resolve inputs ---------------------------------------------------------
if (-not $Profile) { $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' } }
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
if (-not $BundleDir) { $BundleDir = Join-Path (Join-Path $DshHome 'bundles') 'dsh-memory-archive' }
$BundleDir = [System.IO.Path]::GetFullPath($BundleDir)
$SourceDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not $ArchiveDir) { $ArchiveDir = ($DshHome -replace '\\', '/') + '/archive' }

Write-Host 'dsh-memory-archive installer'
Write-Host "  source     : $SourceDir"
Write-Host "  bundle dir : $BundleDir"
Write-Host "  profile    : $Profile  ($ProfileDir)"
Write-Host "  patch file : $PatchFile"
Write-Host "  archiveDir : $ArchiveDir"
if ($DryRun) { Write-Host '  mode       : DRY RUN (nothing will be written)' }
Write-Host ''

if (-not (Test-Path -LiteralPath $ProfileDir)) {
  throw "profile directory not found: $ProfileDir`n(create or boot the profile once first, or pass -DshHome/-Profile)"
}

# --- read the patch, matching its existing newline style --------------------
$existing = if (Test-Path -LiteralPath $PatchFile) { [System.IO.File]::ReadAllText($PatchFile) } else { '' }
$nl = if ($existing.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = if ($existing -eq '') { @() } else { $existing -split "`r?`n" }

function Get-ManagedRange {
  param([string[]]$AllLines)
  $beginAt = -1; $endAt = -1
  for ($i = 0; $i -lt $AllLines.Count; $i++) {
    if ($AllLines[$i].Trim() -eq $BEGIN) { $beginAt = $i; continue }
    if ($beginAt -ge 0 -and $AllLines[$i].Trim() -eq $END) { $endAt = $i; break }
  }
  if ($beginAt -ge 0 -and $endAt -ge $beginAt) { return @{ start = $beginAt; end = $endAt } }
  return $null
}

$managed = Get-ManagedRange -AllLines $lines

# --- uninstall --------------------------------------------------------------
if ($Uninstall) {
  if (-not (Test-Path -LiteralPath $PatchFile)) { throw "nothing to uninstall: $PatchFile does not exist" }
  if (-not $managed) {
    Write-Host "no managed block found in $PatchFile -- nothing to do."
    exit 0
  }
  $kept = @()
  if ($managed.start -gt 0) { $kept += $lines[0..($managed.start - 1)] }
  if ($managed.end + 1 -lt $lines.Count) { $kept += $lines[($managed.end + 1)..($lines.Count - 1)] }
  # drop a trailing run of blank lines, keep one
  while ($kept.Count -gt 1 -and $kept[-1].Trim() -eq '' -and $kept[-2].Trim() -eq '') { $kept = $kept[0..($kept.Count - 2)] }
  $backup = "$PatchFile.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  if (-not $DryRun) {
    Copy-Item -LiteralPath $PatchFile -Destination $backup -Force
    [System.IO.File]::WriteAllText($PatchFile, (($kept -join $nl) + $nl))
  }
  Write-Host "removed the managed block (lines $($managed.start + 1)..$($managed.end + 1))."
  if (-not $DryRun) {
    Write-Host "backup: $backup"
    Write-Host ''
    Write-Host 'RESTART the app to unload the plugin. The archive directory is left untouched:'
    Write-Host "  $ArchiveDir"
    Write-Host "The copied bundle is also left in place; delete it manually if you want it gone:"
    Write-Host "  $BundleDir"
  }
  exit 0
}

# --- install ----------------------------------------------------------------
if ($managed -and -not $Force) {
  Write-Host "already installed: found the managed block at line $($managed.start + 1)."
  Write-Host 're-run with -Force to rewrite it (e.g. after moving the bundle), or -Uninstall to remove it.'
  exit 0
}

$srcEntry = Join-Path $SourceDir $PLUGIN_ENTRY
if (-not (Test-Path -LiteralPath $srcEntry)) { throw "not a bundle directory: $srcEntry not found" }

$fileUri = 'file:///' + (($BundleDir -replace '\\', '/').TrimStart('/'))
$rowName = "$fileUri/$PLUGIN_ENTRY"

$block = @(
  $BEGIN
  "# @local/dsh-memory-archive  (compaction archive + injected pointer)"
  "# written by install.ps1 on " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  "# rollback: pwsh -File install.ps1 -Profile $Profile -Uninstall"
  "# name must resolve to index.js itself; file:// needs no pnpm in the profile."
  '- insert:'
  "    - id: $ROW_ID"
  "      name: `"$rowName`""
  '      config:'
  "        archiveDir: `"$ArchiveDir`""
  '        includeToolResults: true'
  '        redact: true'
  '        announce: true'
  $END
) -join $nl

Write-Host '--- planned actions ---'
Write-Host "  1. copy bundle  $SourceDir"
Write-Host "                -> $BundleDir   (skips _loaded.json and .git)"
Write-Host "  2. backup      $PatchFile -> $PatchFile.bak-<timestamp>"
if ($managed) { Write-Host "  3. replace     managed block at line $($managed.start + 1)" }
else { Write-Host '  3. append      one managed block' }
Write-Host ''

if ($DryRun) {
  Write-Host '--- block that would be written ---'
  Write-Host $block
  exit 0
}

# 1. copy the bundle
if ($SourceDir -ne $BundleDir) {
  New-Item -ItemType Directory -Path $BundleDir -Force | Out-Null
  Get-ChildItem -LiteralPath $SourceDir -Recurse -File |
    Where-Object { $_.Name -ne '_loaded.json' -and $_.FullName -notmatch '\\\.git\\' } |
    ForEach-Object {
      $rel = $_.FullName.Substring($SourceDir.Length).TrimStart('\')
      $dst = Join-Path $BundleDir $rel
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
    }
  Write-Host "copied bundle -> $BundleDir"
} else {
  Write-Host 'source and bundle dir are the same; skipping the copy'
}

# 2. backup
if (Test-Path -LiteralPath $PatchFile) {
  $backup = "$PatchFile.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item -LiteralPath $PatchFile -Destination $backup -Force
  Write-Host "backup -> $backup"
}

# 3. insert or replace
if ($managed) {
  $new = @()
  if ($managed.start -gt 0) { $new += $lines[0..($managed.start - 1)] }
  $new += ($block -split "`r?`n")
  if ($managed.end + 1 -lt $lines.Count) { $new += $lines[($managed.end + 1)..($lines.Count - 1)] }
} else {
  $new = @($lines)
  while ($new.Count -gt 0 -and $new[-1].Trim() -eq '') { $new = $new[0..($new.Count - 2)] }
  if ($new.Count -gt 0) { $new += '' }
  $new += ($block -split "`r?`n")
}
[System.IO.File]::WriteAllText($PatchFile, (($new -join $nl) + $nl))
Write-Host "patched $PatchFile"

# 4. structural self-check (this file has no YAML parser available)
$verify = [System.IO.File]::ReadAllText($PatchFile)
$idCount = ([regex]::Matches($verify, "(?m)^\s*-?\s*id:\s*$([regex]::Escape($ROW_ID))\s*$")).Count
$beginCount = ([regex]::Matches($verify, [regex]::Escape($BEGIN))).Count
if ($idCount -ne 1 -or $beginCount -ne 1) {
  throw "self-check failed: id:$ROW_ID appears $idCount time(s), managed begin marker $beginCount time(s). Restore the backup and report this."
}
Write-Host "self-check ok: 1 row, 1 managed block"

Write-Host ''
Write-Host 'RESTART the app now -- code changes are not hot-applied (config edits are).'
Write-Host 'then verify the marker proves this build is loaded:'
Write-Host "  Get-Content `"$BundleDir\_loaded.json`""
Write-Host '  -> expect "build" and "archiveDirResolved"; either missing means the old module is still held.'
Write-Host ''
Write-Host 'rollback:'
Write-Host "  pwsh -File `"$PSCommandPath`" -Profile $Profile -Uninstall"
