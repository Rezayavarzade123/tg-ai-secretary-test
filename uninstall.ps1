#Requires -Version 5.1
<#
.SYNOPSIS
    Remove the Telegram secretary from this machine (Windows).

.DESCRIPTION
    Default: stop and unregister the Scheduled Task(s). Your code, settings and
    messages stay where they are, so you can start it again or re-run install.ps1.

    -Purge: also delete the install directory and the settings file, after showing
    you exactly what will go.

.EXAMPLE
    .\uninstall.ps1 -Dir "$env:LOCALAPPDATA\Programs\tg-ai-secretary"
    .\uninstall.ps1 -Dir <path> -Purge
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Dir,
    [switch] $Purge,
    [switch] $NoPath,
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'

$ServiceName = 'tg-secretary'
$LlamaTask   = 'tg-secretary-model'

function Write-Step($T) { Write-Host ''; Write-Host "> $T" -ForegroundColor Cyan }
function Write-Ok($T)   { Write-Host "  [ok] $T" -ForegroundColor Green }
function Write-Info($T) { Write-Host "  $T" -ForegroundColor DarkGray }
function Write-Warn($T) { Write-Host "  [!!] $T" -ForegroundColor Yellow }
function Fail($T) { Write-Host ''; Write-Host "  [xx] $T" -ForegroundColor Red; Write-Host ''; exit 1 }

function Invoke-Step {
    param([string] $Label, [scriptblock] $Action)
    if ($WhatIfPreference) { Write-Host "  [whatif] $Label" -ForegroundColor DarkGray; return }
    & $Action
}

function Confirm-Ask([string] $Question, [string] $Default = 'n') {
    if ($Yes) { return $true }
    $answer = Read-Host "  $Question [$Default]"
    if (-not $answer) { $answer = $Default }
    return ($answer -match '^(y|yes)$')
}

if (-not $Dir) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\tg-ai-secretary'),
        (Join-Path $env:ProgramData 'tg-ai-secretary')
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'package.json')) { $Dir = $c; break }
    }
    if (-not $Dir) { Fail 'Could not guess the install directory. Pass -Dir (the one you gave install.ps1).' }
}
$Dir = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')

$EnvFiles = @()
$machineEnv = Join-Path $env:ProgramData 'tg-ai-secretary\bot.env'
if (Test-Path $machineEnv) { $EnvFiles += $machineEnv }
$localEnv = Join-Path $Dir 'bot\.env'
if (Test-Path $localEnv) { $EnvFiles += $localEnv }

# --- the task -----------------------------------------------------------------

Write-Step 'The Scheduled Task'

$removed = $false
foreach ($name in @($ServiceName, $LlamaTask)) {
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $task = $null }
    if (-not $task) { continue }

    # Only touch tasks this project wrote: a hand-made task with the same name is
    # not ours to delete.
    $ours = $task.Description -like '*Telegram AI secretary*' -or $task.Description -like '*llama.cpp server for the Telegram secretary*'
    if (-not $ours) {
        Write-Warn "Task '$name' was not written by install.ps1; leaving it alone"
        continue
    }
    Invoke-Step "stop and unregister '$name'" {
        try { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue } catch { }
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    Write-Ok "removed task '$name'"
    $removed = $true
}
if (-not $removed) { Write-Info 'No task installed by this project was found.' }

# Anything left running by hand from this directory.
$leftover = @()
foreach ($p in (Get-Process node -ErrorAction SilentlyContinue)) {
    $cmd = $null
    try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue).CommandLine } catch { }
    if ($cmd -and $cmd -like "*$Dir*" -and $cmd -like '*bot/runner.mjs*') { $leftover += $p.Id }
}
if ($leftover.Count -gt 0) {
    if (-not $Purge) {
        Write-Warn "A bot is still running from this directory (pid $($leftover -join ', '))."
        Write-Info 'Stop it with: tg-secretary stop'
    } else {
        Invoke-Step "stop pid $($leftover -join ', ')" {
            foreach ($procId in $leftover) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
        }
        Write-Ok 'stopped the running bot'
    }
}

# --- the PATH entry -----------------------------------------------------------

Write-Step 'The tg-secretary command'
$binDir = Join-Path $Dir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $parts = $userPath -split ';' | Where-Object { $_.Trim() -and ($_.TrimEnd('\') -ine $binDir.TrimEnd('\')) }
    if (($parts -join ';') -ne $userPath.TrimEnd(';')) {
        if ($NoPath) {
            Write-Info 'left it on PATH (-NoPath)'
        } else {
            Invoke-Step "remove $binDir from the user PATH" {
                [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
            }
            Write-Ok "$binDir removed from your PATH (new terminals only)"
        }
    } else {
        Write-Info "$binDir was not on your PATH"
    }
}

if (-not $Purge) {
    Write-Step 'Done - your data is still there'
    Write-Host "  code      $Dir"
    Write-Host "  settings  $(if ($EnvFiles) { $EnvFiles -join ', ' } else { 'none' })"
    Write-Host "  messages  $(Join-Path $Dir 'bot\state')"
    Write-Host ''
    Write-Host "  To remove everything as well: .\uninstall.ps1 -Dir `"$Dir`" -Purge"
    Write-Host ''
    exit 0
}

# --- purge --------------------------------------------------------------------

Write-Step 'Removing everything (-Purge)'

if (-not (Test-Path $Dir) -and -not $EnvFiles) {
    Write-Ok 'Nothing left to remove'
    exit 0
}

Write-Host '  This deletes:'
$sizeText = ''
if (Test-Path $Dir) {
    try {
        $bytes = (Get-ChildItem $Dir -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($bytes) { $sizeText = " ({0:N0} MB)" -f ($bytes / 1MB) }
    } catch { }
}
Write-Host "    $Dir$sizeText"
Write-Host '      - code, settings and every message the bot stored'
foreach ($file in $EnvFiles) {
    if ($file -ne $localEnv) { Write-Host "    $file`n      - the settings file with your bot token" }
}
Write-Host ''
if (-not (Confirm-Ask 'Delete all of it? This cannot be undone.' 'n')) { Fail 'Nothing deleted.' }

Invoke-Step "delete $Dir" {
    # The state lock and mmap'd files do not survive a recursive delete while a
    # process holds them; the processes were stopped above.
    if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
}
foreach ($file in $EnvFiles) {
    if ($file -ne $localEnv) { Invoke-Step "delete $file" { if (Test-Path $file) { Remove-Item $file -Force } } }
}

Write-Ok 'Removed'
Write-Host ''
Write-Host '  Left behind, deliberately:'
Write-Host '    - the model files and llama.cpp, wherever you put them'
Write-Host '    - the bot itself in Telegram: /deletebot in @BotFather'
Write-Host ''
