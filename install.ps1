<#
  spotify-no-ads - one-line installer for Windows.

    iwr -useb https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.ps1 | iex

  It does four things and nothing else:
    1. checks that Spicetify is installed (and prints the exact command if it is not)
    2. downloads extensions/no-ads.js into your Spicetify Extensions folder
    3. enables it in the Spicetify config, keeping the extensions you already have
    4. applies the patch, restarting Spotify once

  Nothing is uploaded anywhere, no account is touched, and no other extension is modified.
#>

$ErrorActionPreference = 'Stop'
$Raw      = if ($env:NOADS_SOURCE_URL) { $env:NOADS_SOURCE_URL } else { 'https://raw.githubusercontent.com/geranton93/spotify-no-ads/main' }
$ExtFile  = 'no-ads.js'
# Dry run (changes nothing, just explains):  $env:NOADS_DRY_RUN=1; iwr -useb <this file> | iex
$DryRun   = ($env:NOADS_DRY_RUN -eq '1')

Write-Host ''
Write-Host 'spotify-no-ads installer'
Write-Host '========================'

# ---------------------------------------------------------------- 1. Spicetify
if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'Spicetify is not installed yet. It is the free tool that lets the Spotify desktop app'
    Write-Host 'load add-ons; our add-on cannot work without it.'
    Write-Host ''
    Write-Host 'Install Spicetify first - copy this whole line into PowerShell and press Enter:'
    Write-Host ''
    Write-Host '    iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex'
    Write-Host ''
    Write-Host 'Then close this window, open a new PowerShell window and run the installer again.'
    exit 1
}
$spicetifyVersion = (spicetify --version 2>$null | Select-Object -Last 1)
Write-Host "1/4  Spicetify found: $spicetifyVersion"

# ------------------------------------------------------- 2. where files live
$configFile = $null
try { $configFile = (spicetify -c 2>$null | Select-Object -Last 1) } catch { }
if ($configFile) { $configDir = Split-Path $configFile -Parent } else { $configDir = $null }
if (-not $configDir) {
    if ($env:APPDATA)     { $configDir = Join-Path $env:APPDATA 'spicetify' }
    elseif ($env:HOME)    { $configDir = Join-Path $env:HOME '.config/spicetify' }
    else                  { $configDir = Join-Path ([System.IO.Path]::GetTempPath()) 'spicetify' }
}
$extDir = Join-Path $configDir 'Extensions'
Write-Host "2/4  Spicetify folder: $configDir"

$target = Join-Path $extDir $ExtFile
if ($DryRun) {
    Write-Host "     (dry run) would download $Raw/extensions/$ExtFile -> $target"
} else {
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$Raw/extensions/$ExtFile" -OutFile $target
    Write-Host "     downloaded $ExtFile ($((Get-Item $target).Length) bytes)"
}

# ------------------------------------------------------------- 3. turn it on
$already = $false
$iniPath = Join-Path $configDir 'config-xpui.ini'
if (Test-Path $iniPath) {
    $line = Select-String -Path $iniPath -Pattern '^extensions.*' | Select-Object -First 1
    if ($line -and $line.Line -match [regex]::Escape($ExtFile)) { $already = $true }
}
if ($already) {
    Write-Host '3/4  already enabled in the Spicetify config'
} elseif ($DryRun) {
    Write-Host "3/4  (dry run) would run: spicetify config extensions $ExtFile"
} else {
    spicetify config extensions $ExtFile | Out-Null
    Write-Host '3/4  enabled in the Spicetify config'
}

# ----------------------------------------------------------------- 4. apply
if ($DryRun) {
    Write-Host '4/4  (dry run) would run: spicetify apply'
    Write-Host ''
    Write-Host 'Dry run finished - nothing on this computer was changed.'
    exit 0
}
Write-Host '4/4  patching Spotify (it closes and reopens once; an untouched backup copy is kept) ...'
if (-not $env:NOADS_NO_APP_CONTROL) {
    Get-Process Spotify -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
$logDir = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { [System.IO.Path]::GetTempPath() }
$log = Join-Path $logDir 'no-ads-apply.log'

# "spicetify backup apply" is correct right after a Spotify update (the client is unpatched again),
# but on an already-patched client it would refresh the backup with patched files. Only fall back to
# it when no backup exists yet. LocalAppData only exists on Windows, so it is probed carefully.
$backupDirs = @((Join-Path $configDir 'Backup'))
if ($env:LOCALAPPDATA) { $backupDirs += (Join-Path $env:LOCALAPPDATA 'spicetify\Backup') }
$backupExists = $false
foreach ($dir in $backupDirs) { if (Test-Path $dir) { $backupExists = $true; break } }

spicetify apply *> $log
$applied = ($LASTEXITCODE -eq 0)
$note = '     done'
if ((-not $applied) -and (-not $backupExists)) {
    spicetify backup apply *> $log
    $applied = ($LASTEXITCODE -eq 0)
    $note = '     done (first run: backup created, then patched)'
}
if (-not $applied) {
    Write-Host '     something went wrong. The last lines of the log:'
    Get-Content $log -Tail 5 | ForEach-Object { Write-Host "       $_" }
    Write-Host 'Run "spicetify backup apply" by hand to see the full error, or see the guide: https://github.com/geranton93/spotify-no-ads#troubleshooting'
    exit 1
}
Write-Host $note
if (-not $env:NOADS_NO_APP_CONTROL -and -not $env:NOADS_SKIP_LAUNCH) {
    try { Start-Process 'spotify:' } catch { Write-Host '     (could not start Spotify automatically - open it yourself)' }
}

Write-Host ''
Write-Host 'Finished - Spotify now starts without ads.'
Write-Host ''
Write-Host 'Check it any time: in Spotify press Ctrl+Shift+I, type  NoAds.verify()'
Write-Host 'Ads come back after a Spotify update: just run this installer again.'
Write-Host "Remove everything:  spicetify restore   and delete  $target"
Write-Host ''
