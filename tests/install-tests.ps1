<#
  Behaviour tests for install.ps1 - the same suite on every platform.

  Hermetic: a stub "spicetify" is put on PATH, the client is never touched (NOADS_NO_APP_CONTROL=1),
  and the extension is fetched from the published URL - which also proves the URL in the guide works.

  Run:  pwsh -NoProfile -File tests/install-tests.ps1

  Covered: missing Spicetify, happy path, second run (already enabled), apply failing with and
  without a backup present, and the dry run.
#>

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installer = Join-Path $root 'install.ps1'
$pwshPath  = (Get-Process -Id $PID).Path
$rawUrl    = 'https://raw.githubusercontent.com/geranton93/spotify-no-ads/main'

$script:failures = 0
function Pass($msg) { Write-Host "  ok    $msg" }
function Fail($msg) { Write-Host "  FAIL  $msg"; $script:failures++ }
function Check($msg, $condition) { if ($condition) { Pass $msg } else { Fail $msg } }

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('no-ads-tests-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$bin     = Join-Path $sandbox 'bin'
$cfg     = Join-Path $sandbox 'cfg'
$config  = Join-Path $cfg 'config-xpui.ini'
$calls   = Join-Path $sandbox 'calls.log'
New-Item -ItemType Directory -Force -Path $bin, $cfg, (Join-Path $sandbox 'home') | Out-Null

# --- stub spicetify: records every call, emulates what the installer relies on --------------------
$stubBody = @'
$line = ($args -join ' ')
Add-Content -Path $env:SPICETIFY_CALLS -Value $line
switch ($args[0]) {
    '--version' { Write-Output 'stub 9.9.9'; exit 0 }
    '-c'        { Write-Output $env:SPICETIFY_CONFIG; exit 0 }
    'config'    {
        if ($args[1] -eq 'extensions' -and $args[2]) {
            $text = Get-Content -Raw $env:SPICETIFY_CONFIG
            if ($text -notmatch [regex]::Escape($args[2])) {
                $text = $text -replace '(?m)^extensions *=.*', ('extensions = other.js|' + $args[2])
                Set-Content -NoNewline -Path $env:SPICETIFY_CONFIG -Value $text
            }
        }
        exit 0
    }
    'apply'  { if (Test-Path (Join-Path $env:SANDBOX 'apply_fail')) { exit 1 }; exit 0 }
    'backup' { if (Test-Path (Join-Path $env:SANDBOX 'backup_fail')) { exit 1 }; exit 0 }
}
exit 0
'@

if ($IsWindows) {
    Set-Content -Path (Join-Path $bin 'spicetify-stub.ps1') -Value $stubBody -Encoding UTF8
    $cmd = "@echo off`r`n`"$pwshPath`" -NoProfile -File `"%~dp0spicetify-stub.ps1`" %*`r`n"
    Set-Content -Path (Join-Path $bin 'spicetify.cmd') -Value $cmd -Encoding ASCII
} else {
    # a POSIX shim so the same suite also runs on macOS/Linux during development
    $shStub = @'
#!/bin/sh
printf '%s\n' "$*" >> "$SPICETIFY_CALLS"
case "$1" in
  --version) echo "stub 9.9.9"; exit 0 ;;
  -c)        echo "$SPICETIFY_CONFIG"; exit 0 ;;
  config)
    if [ "${2:-}" = "extensions" ] && [ -n "${3:-}" ]; then
      cur="$(grep '^extensions' "$SPICETIFY_CONFIG" | sed 's/^extensions *= *//')"
      case "$cur" in *"$3"*) : ;; *) sed -i.bak "s@^extensions *=.*@extensions = ${cur}|$3@" "$SPICETIFY_CONFIG" ;; esac
    fi
    exit 0 ;;
  apply)  [ -f "$SANDBOX/apply_fail" ] && exit 1; exit 0 ;;
  backup) [ -f "$SANDBOX/backup_fail" ] && exit 1; exit 0 ;;
esac
exit 0
'@
    $stubPath = Join-Path $bin 'spicetify'
    Set-Content -Path $stubPath -Value $shStub -Encoding UTF8
    & /bin/chmod +x $stubPath
}

function Reset-State {
    Remove-Item -Recurse -Force (Join-Path $cfg 'Extensions'), (Join-Path $cfg 'Backup') -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path $sandbox 'apply_fail'), (Join-Path $sandbox 'backup_fail') -ErrorAction SilentlyContinue
    Set-Content -Path $config -Value 'extensions            = other.js'
    Set-Content -Path $calls -Value ''
}

function Run-Installer {
    param([hashtable]$Extra = @{}, [switch]$WithoutStub)

    if ($WithoutStub) {
        $env:PATH = if ($IsWindows) { "$env:SystemRoot\System32" } else { '/usr/bin:/bin' }
    } else {
        $env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
    }
    $env:SPICETIFY_CALLS    = $calls
    $env:SPICETIFY_CONFIG   = $config
    $env:SANDBOX            = $sandbox
    $env:NOADS_NO_APP_CONTROL = '1'
    $env:NOADS_SOURCE_URL   = $rawUrl
    Remove-Item Env:NOADS_DRY_RUN -ErrorAction SilentlyContinue
    foreach ($k in $Extra.Keys) { Set-Item -Path "Env:$k" -Value $Extra[$k] }

    $out = & $pwshPath -NoProfile -File $installer 2>&1 | Out-String
    return @{ Output = $out; Code = $LASTEXITCODE }
}

# Line-ending agnostic: Get-Content splits lines and drops CRLF, so -contains works on Windows too.
$getCalls = {
    if (Test-Path $calls) { @(Get-Content $calls | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
}
$getConfig = { if (Test-Path $config) { Get-Content -Raw $config } else { '' } }
$hasCall = { param($needle) (& $getCalls) -contains $needle }

Write-Host ''
Write-Host 'install.ps1 behaviour tests'
Write-Host "===========================  (platform: $([System.Environment]::OSVersion.Platform), pwsh $($PSVersionTable.PSVersion))"

try {
    # 1. Spicetify missing --------------------------------------------------
    Reset-State
    $r = Run-Installer -WithoutStub
    Check 'missing Spicetify: exits non-zero'            ($r.Code -ne 0)
    Check 'missing Spicetify: prints the install command' ($r.Output -match 'spicetify/cli/main/install.ps1')
    Check 'missing Spicetify: installs nothing'           (-not (Test-Path (Join-Path $cfg 'Extensions')))

    # 2. Happy path ---------------------------------------------------------
    Reset-State
    $r = Run-Installer
    Check 'happy path: exits 0'                          ($r.Code -eq 0)
    Check 'happy path: extension file landed'            (Test-Path (Join-Path $cfg 'Extensions/no-ads.js'))
    Check 'happy path: file is the published one'        ((Get-Item (Join-Path $cfg 'Extensions/no-ads.js')).Length -gt 10000)
    Check 'happy path: enabled in the config'            ((& $getConfig) -match 'no-ads\.js')
    Check 'happy path: existing extension preserved'     ((& $getConfig) -match 'other\.js')
    Check 'happy path: config extensions was called'     (& $hasCall 'config extensions no-ads.js')
    Check 'happy path: apply was called'                 (& $hasCall 'apply')
    Check 'happy path: tells the user it finished'       ($r.Output -match 'Finished')

    # 3. Second run: already enabled, nothing duplicated ---------------------
    Reset-State
    $null = Run-Installer
    Set-Content -Path $calls -Value ''
    $r = Run-Installer
    Check 'second run: exits 0'                          ($r.Code -eq 0)
    Check 'second run: does not enable it again'         (-not ((& $getCalls) | Where-Object { $_ -like 'config extensions*' }))
    Check 'second run: says it is already enabled'       ($r.Output -match 'already enabled')
    Check 'second run: still applies the patch'          (& $hasCall 'apply')

    # 4. apply fails, no backup -> falls back to backup apply ----------------
    Reset-State
    Set-Content -Path (Join-Path $sandbox 'apply_fail') -Value ''
    $r = Run-Installer
    Check 'apply fails, no backup: falls back to backup apply' (& $hasCall 'backup apply')
    Check 'apply fails, no backup: exits 0 after fallback'     ($r.Code -eq 0)

    # 5. apply fails, backup present -> never refresh the backup ------------
    Reset-State
    New-Item -ItemType Directory -Force -Path (Join-Path $cfg 'Backup') | Out-Null
    Set-Content -Path (Join-Path $sandbox 'apply_fail') -Value ''
    $r = Run-Installer
    Check 'apply fails, backup present: no backup apply'  (-not (& $hasCall 'backup apply'))
    Check 'apply fails, backup present: exits non-zero'   ($r.Code -ne 0)
    Check 'apply fails, backup present: points at INSTALL.md' ($r.Output -match 'INSTALL\.md')

    # 6. Dry run changes nothing -------------------------------------------
    Reset-State
    $r = Run-Installer -Extra @{ 'NOADS_DRY_RUN' = '1' }
    Check 'dry run: exits 0'                             ($r.Code -eq 0)
    Check 'dry run: downloads nothing'                   (-not (Test-Path (Join-Path $cfg 'Extensions')))
    Check 'dry run: runs no mutating spicetify command'  (-not ((& $getCalls) | Where-Object { $_ -match '^(config|apply|backup)' }))
    Check 'dry run: says nothing was changed'            ($r.Output -match 'nothing on this computer was changed')
}
finally {
    Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures -eq 0) { Write-Host 'all tests passed'; exit 0 }
Write-Host "$($script:failures) test(s) FAILED"
exit 1
