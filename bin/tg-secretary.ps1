#Requires -Version 5.1
<#
.SYNOPSIS
    Control the Telegram secretary on this machine (Windows).

.DESCRIPTION
    The Windows twin of bin/tg-secretary. Same commands; a Scheduled Task instead
    of systemd, a log file instead of journalctl.

.EXAMPLE
    tg-secretary status
    tg-secretary panel
    tg-secretary logs -f
    tg-secretary update apply
#>
# Arguments are parsed by hand, on purpose. A [CmdletBinding()] param block binds
# before a single line of this script runs, so an undeclared "-n 50" or "-Purge"
# fails with "A parameter cannot be found" and there is nothing here to catch it.
# Everything is accepted as -flag and --flag, with -Dir/--dir=value and -n N as
# the only ones that take a value.
param()

$ErrorActionPreference = 'Stop'

$RawArgs = @($args)
$Command = 'status'
$Dir = ''
$Rest = @()

$ForegroundFlag = $false
$FollowFlag = $false
$LinesArg = $null
$PurgeFlag = $false
$YesFlag = $false
$HelpFlag = $false

$positional = New-Object System.Collections.ArrayList
$i = 0
while ($i -lt $RawArgs.Count) {
    $a = [string]$RawArgs[$i]
    $lower = $a.ToLower()
    if ($lower -eq '--') {
        # Everything after -- is positional, the usual way to pass words that
        # start with a dash.
        $i += 1
        while ($i -lt $RawArgs.Count) { [void]$positional.Add([string]$RawArgs[$i]); $i += 1 }
        break
    }
    if ($lower -match '^-{1,2}(dir|path)(=(.*))?$') {
        if ($Matches[3]) { $Dir = $Matches[3] }
        elseif (($i + 1) -lt $RawArgs.Count) { $i += 1; $Dir = [string]$RawArgs[$i] }
        else { Write-Host '[xx] -Dir needs a path' -ForegroundColor Red; exit 2 }
    }
    elseif ($lower -match '^-{1,2}(n|lines)(=(.*))?$') {
        if ($Matches[3]) { $LinesArg = $Matches[3] }
        elseif (($i + 1) -lt $RawArgs.Count) { $i += 1; $LinesArg = [string]$RawArgs[$i] }
        else { Write-Host '[xx] -n needs a number' -ForegroundColor Red; exit 2 }
    }
    elseif ($lower -in @('-f', '--f', '-follow', '--follow')) { $FollowFlag = $true }
    elseif ($lower -in @('-foreground', '--foreground', '-fg', '--fg')) { $ForegroundFlag = $true }
    elseif ($lower -in @('-purge', '--purge')) { $PurgeFlag = $true }
    elseif ($lower -in @('-yes', '--yes', '-y', '--y')) { $YesFlag = $true }
    elseif ($lower -in @('-h', '--h', '-help', '--help', '-?')) { $HelpFlag = $true }
    else { [void]$positional.Add($a) }
    $i += 1
}

if ($positional.Count -gt 0) {
    $Command = [string]$positional[0]
    if ($positional.Count -gt 1) { $Rest = @($positional[1..($positional.Count - 1)]) }
}

$TaskName  = 'tg-secretary'
$ModelTask = 'tg-secretary-model'
$DefaultPort = 8787

function Write-Ok($T)   { Write-Host "[ok] $T" -ForegroundColor Green }
function Write-Warn2($T) { Write-Host "[!!] $T" -ForegroundColor Yellow }
function Write-Dim($T)  { Write-Host "  $T" -ForegroundColor DarkGray }
function Fail($T) { Write-Host "[xx] $T" -ForegroundColor Red; exit 1 }

function Show-Usage {
    @"
tg-secretary - control the Telegram secretary on this machine

Daily
  status                 is it running, which version, is the model server up
  panel                  print the panel URL with its token (paste into a browser)
  token                  print just the panel token
  start [-Foreground]    start the Scheduled Task, or run it in this window
  stop                   stop it
  restart                restart it (use this after editing the settings file)
  logs [-f] [-n N]       the bot's log file (-f follows it)

Maintenance
  update [check|apply|rollback]   update from GitHub; no argument means check
  selftest               run the end-to-end checks against a throwaway state dir
  hw                     what this machine can run
  paths                  where the code, settings and data are

Other
  version                installed version
  uninstall [-Purge]     remove the task (and everything, with -Purge)
  help                   this text

Flags work as -flag or --flag, and -Dir/--dir=value also works.

Where it looks
  -Dir PATH              an install somewhere unusual
  `$env:SECRETARY_HOME    the same thing, for a session
  otherwise: the directory this script lives in, then
  %LOCALAPPDATA%\Programs\tg-ai-secretary, then %ProgramData%\tg-ai-secretary.
"@ | Write-Host
}

# --- which install ------------------------------------------------------------

function Test-Install([string] $Path) {
    return ($Path -and (Test-Path (Join-Path $Path 'package.json')) -and (Test-Path (Join-Path $Path 'bot\runner.mjs')))
}

function Find-Install {
    if ($Dir) {
        if (-not (Test-Install $Dir)) { Fail "No installation at $Dir (expected package.json and bot\runner.mjs).`n     Check the path, or install first: .\install.ps1 -Dir `"$Dir`"" }
        return [System.IO.Path]::GetFullPath($Dir)
    }
    if ($env:SECRETARY_HOME) {
        if (-not (Test-Install $env:SECRETARY_HOME)) { Fail "SECRETARY_HOME=$($env:SECRETARY_HOME) is not an installation." }
        return [System.IO.Path]::GetFullPath($env:SECRETARY_HOME)
    }
    $self = $MyInvocation.MyCommand.Path
    if ($self) {
        $candidate = Split-Path -Parent (Split-Path -Parent $self)
        if (Test-Install $candidate) { return [System.IO.Path]::GetFullPath($candidate) }
    }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\tg-ai-secretary'),
        (Join-Path $env:ProgramData 'tg-ai-secretary')
    )
    foreach ($c in $candidates) { if (Test-Install $c) { return [System.IO.Path]::GetFullPath($c) } }
    Fail @"
I cannot find the installation.
     Run this again with -Dir <path>, or set `$env:SECRETARY_HOME.
     If nothing is installed yet: .\install.ps1
"@
}

$InstallDir = Find-Install
$StateDir   = Join-Path $InstallDir 'bot\state'
$Node       = (Get-Command node -ErrorAction SilentlyContinue)
$NodePath   = if ($Node) { $Node.Source } else { 'node' }

$Version = ''
try {
    $pkg = Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
    $Version = $pkg.version
} catch { $Version = 'unknown' }

# Settings: the machine-wide file wins when it exists (that is what an elevated
# install writes), otherwise the one inside the checkout.
$SettingsFile = ''
foreach ($candidate in @((Join-Path $env:ProgramData 'tg-ai-secretary\bot.env'), (Join-Path $InstallDir 'bot\.env'), (Join-Path $InstallDir '.env'))) {
    if ($candidate -and (Test-Path $candidate)) { $SettingsFile = $candidate; break }
}

function Get-Setting([string] $Key, [string] $Default = '') {
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv }
    if (-not $SettingsFile) { return $Default }
    foreach ($line in (Get-Content $SettingsFile)) {
        if ($line -match "^\s*(?:export\s+)?$([regex]::Escape($Key))=(.*)$") {
            $value = $Matches[1].Trim()
            $value = $value.Trim('"').Trim("'")
            return $value
        }
    }
    return $Default
}

$Port = 8787
$portText = Get-Setting 'PANEL_PORT' "$DefaultPort"
if ($portText -match '^\d+$') { $Port = [int]$portText }
$Listen = Get-Setting 'PANEL_HOST' '0.0.0.0'
$PanelUrl = "http://127.0.0.1:$Port"

$PanelToken = ''
$tokenFile = Join-Path $StateDir 'panel-token'
if (Test-Path $tokenFile) { $PanelToken = (Get-Content $tokenFile -Raw).Trim() }
if (-not $PanelToken) { $PanelToken = Get-Setting 'PANEL_TOKEN' '' }

$LogFile = Join-Path $StateDir 'bot.log'

# --- state --------------------------------------------------------------------

function Get-Task {
    param([string] $Name = $TaskName)
    try { return Get-ScheduledTask -TaskName $Name -ErrorAction Stop } catch { return $null }
}

function Test-Panel {
    try {
        $r = Invoke-WebRequest -Uri "$PanelUrl/api/ping" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-ManualPids {
    $pids = @()
    try {
        foreach ($p in (Get-Process node -ErrorAction SilentlyContinue)) {
            # There is no /proc/<pid>/cwd on Windows, so match the install path in
            # the process's command line instead.
            $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue).CommandLine
            if ($cmd -and $cmd -like "*$InstallDir*" -and $cmd -like '*bot/runner.mjs*') { $pids += $p.Id }
        }
    } catch { }
    return $pids
}

function Test-Running {
    $task = Get-Task
    if ($task) { return ($task.State -eq 'Running') }
    if (Test-Panel) { return $true }
    return ((Get-ManualPids).Count -gt 0)
}

# --- commands -----------------------------------------------------------------

function Show-Status {
    $running = Test-Running
    Write-Host "tg-secretary $Version"
    Write-Host "  code        $InstallDir"
    Write-Host "  settings    $(if ($SettingsFile) { $SettingsFile } else { 'none (defaults, plus the panel)' })"
    Write-Host "  data        $StateDir"

    $task = Get-Task
    if ($task) {
        $info = $null
        try { $info = Get-ScheduledTaskInfo -TaskName $TaskName } catch { }
        $last = if ($info) { "last result $($info.LastTaskResult)" } else { '' }
        Write-Host "  task        $($task.State) ($TaskName; $last)"
    } else {
        Write-Host '  task        not installed - started by hand'
    }

    if ($running) { Write-Host '  bot         running' -ForegroundColor Green }
    else { Write-Host '  bot         not running' -ForegroundColor Yellow }

    if (Test-Panel) {
        Write-Host "  panel       answering on $PanelUrl" -ForegroundColor Green
    } else {
        Write-Host "  panel       not answering on $PanelUrl" -ForegroundColor DarkGray
    }

    if ($PanelToken) { Write-Host "  token       $PanelToken" }
    else { Write-Host '  token       not created yet (it is written at first start)' -ForegroundColor Yellow }

    $base = Get-Setting 'LLM_BASE_URL' 'http://127.0.0.1:8080'
    $modelOk = $false
    try {
        $r = Invoke-WebRequest -Uri ($base.TrimEnd('/') + '/v1/models') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $modelOk = ($r.StatusCode -eq 200)
    } catch { $modelOk = $false }
    if ($modelOk) { Write-Host "  model       online at $base" -ForegroundColor Green }
    else { Write-Host "  model       not answering at $base (llama-server or Ollama not started?)" -ForegroundColor Yellow }

    $stateFile = Join-Path $StateDir 'bot.json'
    if (Test-Path $stateFile) {
        $size = [Math]::Round((Get-Item $stateFile).Length / 1KB, 0)
        $drafts = 0
        try {
            $json = Get-Content $stateFile -Raw
            $drafts = ([regex]::Matches($json, '"status"\s*:\s*"pending"')).Count
        } catch { }
        Write-Host "  data file   ${size}K - $drafts pending draft(s)"
    }
}

function Show-Panel {
    if (-not $PanelToken) { Fail 'No panel token yet. Start the bot once (tg-secretary start); the token is printed then.' }
    if (-not (Test-Panel) -and -not (Test-Running)) {
        Write-Warn2 "The panel is not answering; the bot may be stopped. Start it with: tg-secretary start"
    }
    Write-Host "$PanelUrl/?token=$PanelToken"
    if ($Listen -eq '0.0.0.0') {
        try {
            $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
                Select-Object -First 1).IPAddress
            if ($lan) { Write-Dim "from another device on your network: http://${lan}:$Port/?token=$PanelToken" }
        } catch { }
    }
}

function Start-Bot {
    $fg = $ForegroundFlag
    if (-not $fg -and (Test-Running)) {
        Write-Ok 'Already running'
        return
    }

    $task = Get-Task
    if ($fg -or -not $task) {
        if (-not $task) { Write-Dim 'No Scheduled Task; running in this window. Ctrl+C stops it.' }
        Push-Location $InstallDir
        try {
            & $NodePath --import ./bot/register.mjs bot/runner.mjs
        } finally { Pop-Location }
        return
    }

    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Test-Panel) { Write-Ok "Started - panel on $PanelUrl"; return }
        Start-Sleep -Milliseconds 500
    }
    Write-Warn2 "The task was started but the panel is not answering yet. Check: tg-secretary logs -n 30"
    exit 1
}

function Stop-Bot {
    $task = Get-Task
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $TaskName
            Write-Ok 'Stopped'
            return
        }
    }
    $pids = Get-ManualPids
    if ($pids.Count -gt 0) {
        # $pid in PowerShell is the current process id and cannot be assigned,
        # hence $procId here.
        foreach ($procId in $pids) { Stop-Process -Id $procId -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
        Write-Ok 'Stopped (it was running by hand)'
        return
    }
    Write-Host 'Not running.'
}

function Restart-Bot {
    $task = Get-Task
    if (-not $task) {
        Write-Host 'No task to restart; starting it instead.'
        Start-Bot
        return
    }
    # There is no Restart-ScheduledTask cmdlet; a restart is stop, wait, start -
    # which also gives the bot its SIGTERM-equivalent (a clean task stop) so it
    # can save state and release its lock.
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Test-Panel) { Write-Ok "Restarted - panel on $PanelUrl"; return }
        Start-Sleep -Milliseconds 500
    }
    Write-Warn2 'Restarted, but the panel is not answering yet. Check: tg-secretary logs -n 30'
    exit 1
}

function Show-Logs {
    $follow = $FollowFlag
    $lines = 50
    if ($LinesArg -and $LinesArg -match '^\d+$') { $lines = [int]$LinesArg }

    if (-not (Test-Path $LogFile)) {
        if (-not (Get-Task)) {
            Write-Warn2 'No log file yet, and no Scheduled Task: run it in this window to see output:'
            Write-Host '    tg-secretary start -Foreground'
        } else {
            Write-Warn2 "No log file yet at $LogFile - the task may not have started. Check the task history, or run: tg-secretary start -Foreground"
        }
        return
    }
    if ($follow) { Get-Content $LogFile -Tail $lines -Wait }
    else { Get-Content $LogFile -Tail $lines }
}

function Invoke-BotNode {
    param([string[]] $Arguments)
    Push-Location $InstallDir
    try { & $NodePath @Arguments; return $LASTEXITCODE }
    finally { Pop-Location }
}

function Invoke-Update {
    $code = Invoke-BotNode (@('bot/cli.mjs', 'update') + $Rest)
    exit $code
}

function Invoke-Selftest {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("secretary-selftest-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $old = $env:BOT_STATE_DIR
    $env:BOT_STATE_DIR = $temp
    try {
        $code = Invoke-BotNode @('--import', './bot/register.mjs', 'bot/selftest.mjs')
    } finally {
        if ($old) { $env:BOT_STATE_DIR = $old } else { Remove-Item Env:\BOT_STATE_DIR -ErrorAction SilentlyContinue }
        Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit $code
}

function Show-Paths {
    Write-Host "install   $InstallDir"
    Write-Host "settings  $(if ($SettingsFile) { $SettingsFile } else { 'none' })"
    Write-Host "state     $StateDir"
    Write-Host "token     $(Join-Path $StateDir 'panel-token')"
    Write-Host "log       $LogFile"
}

function Invoke-Uninstall {
    $script = Join-Path $InstallDir 'uninstall.ps1'
    if (-not (Test-Path $script)) { Fail "No uninstall.ps1 in $InstallDir." }
    $cliArgs = @('-Dir', $InstallDir)
    if ($PurgeFlag) { $cliArgs += '-Purge' }
    if ($YesFlag) { $cliArgs += '-Yes' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script @cliArgs
    exit $LASTEXITCODE
}

# --- dispatch -----------------------------------------------------------------

if ($HelpFlag) { Show-Usage; exit 0 }

switch ($Command.ToLower()) {
    'status'    { Show-Status }
    'panel'     { Show-Panel }
    'open'      { Show-Panel }
    'token'     {
        if (-not $PanelToken) { Fail 'No panel token yet. Start the bot once (tg-secretary start).' }
        Write-Host $PanelToken
    }
    'start'     { Start-Bot }
    'stop'      { Stop-Bot }
    'restart'   { Restart-Bot }
    'logs'      { Show-Logs }
    'update'    { Invoke-Update }
    'selftest'  { Invoke-Selftest }
    'hw'        { exit (Invoke-BotNode (@('bot/hardware.mjs') + $Rest)) }
    'paths'     { Show-Paths }
    'version'   { Write-Host "tg-secretary $Version" }
    'uninstall' { Invoke-Uninstall }
    'help'      { Show-Usage }
    '--help'    { Show-Usage }
    '-h'        { Show-Usage }
    default {
        Write-Warn2 "Unknown command: $Command"
        Write-Host ''
        Show-Usage
        exit 2
    }
}
