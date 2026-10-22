#Requires -Version 5.1
<#
.SYNOPSIS
    Install the Telegram AI secretary on Windows.

.DESCRIPTION
    The Windows half of install.sh. Same steps, different plumbing:

      1. check the machine (Windows, 64-bit, Node >= 18.19, git, free space)
      2. measure this CPU's vector instructions with kernel32, because Windows has
         no /proc/cpuinfo and Node reports no flags
      3. put the code in one directory (a git clone where possible, so /update works)
      4. write the bot token outside the checkout, readable only by you (an ACL,
         not chmod)
      5. install a Scheduled Task that starts it at logon and restarts it if it
         exits - the Windows equivalent of "Restart=always", which is what makes
         /update restart into the new code
      6. start it, wait for the control panel to answer, print the URL and token

    It does not download a model: the right GGUF depends on the CPU and is a ~1 GB
    download, so it prints what this machine can run instead.

    Nothing here needs Administrator. Elevated, it installs for all users under
    ProgramData and C:\Program Files; otherwise into your own profile.

.PARAMETER Dir
    Where to install. Default: C:\ProgramData\tg-ai-secretary when elevated,
    $env:LOCALAPPDATA\Programs\tg-ai-secretary otherwise.

.PARAMETER Token
    Bot token from @BotFather. Asked for (hidden) when missing.

.PARAMETER Port
    Control panel port. Default 8787.

.PARAMETER Listen
    Panel bind address. Default 0.0.0.0 (your network). 127.0.0.1 keeps it local.

.PARAMETER TimeZone
    IANA name the bot uses for quiet hours, e.g. Europe/London. Default: this
    machine's Windows time zone, translated.

.PARAMETER Model
    Path to a local .gguf for llama.cpp. Also writes a Scheduled Task for
    llama-server when the binary can be found.

.PARAMETER LlamaPath
    Path to llama-server.exe.

.PARAMETER NoTask
    Do not create the Scheduled Task (files and settings only).

.PARAMETER NoPath
    Do not add the install's bin directory to your user PATH.

.PARAMETER Force
    Install into a non-empty directory that is not ours.

.PARAMETER Yes
    Never ask; take the defaults.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Port 8790 -Token '123456789:AA...'
    .\install.ps1 -WhatIf          # print every step, change nothing

.NOTES
    Uninstall: .\uninstall.ps1 -Dir <same path> [-Purge]
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Dir,
    [string] $Token,
    [int]    $Port = 8787,
    [string] $Listen = '0.0.0.0',
    [string] $TimeZone,
    [string] $Model,
    [string] $LlamaPath,
    [switch] $NoTask,
    [switch] $NoPath,
    [switch] $Force,
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ServiceName  = 'tg-secretary'
$LlamaTask    = 'tg-secretary-model'
$RepoUrl      = if ($env:SECRETARY_REPO) { $env:SECRETARY_REPO } else { 'https://github.com/ygasaino1/tg-ai-secretary.git' }
$RepoBranch   = if ($env:SECRETARY_BRANCH) { $env:SECRETARY_BRANCH } else { 'main' }
$MinNode      = [version]'18.19.0'

# --- output -------------------------------------------------------------------

function Write-Step($Text) { Write-Host ''; Write-Host "> $Text" -ForegroundColor Cyan }
function Write-Ok($Text)   { Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Info($Text) { Write-Host "  $Text" -ForegroundColor DarkGray }
function Write-Warn($Text) { Write-Host "  [!!] $Text" -ForegroundColor Yellow }
function Write-Fail($Text) {
    Write-Host ''
    Write-Host "  [xx] $Text" -ForegroundColor Red
    Write-Host ''
    exit 1
}

# Every write goes through this, so -WhatIf is honest: it prints what it would do
# and does none of it.
function Invoke-Step {
    param([string] $Label, [scriptblock] $Action)
    if ($WhatIfPreference) {
        Write-Host "  [whatif] $Label" -ForegroundColor DarkGray
        return
    }
    & $Action
}

function Test-Command($Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Invoke-Native {
    param([string] $File, [string[]] $Arguments, [string] $WorkingDirectory)
    $push = $false
    if ($WorkingDirectory) { Push-Location $WorkingDirectory; $push = $true }
    try {
        $output = & $File @Arguments 2>&1
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    } finally {
        if ($push) { Pop-Location }
    }
}

# --- 1. the machine -----------------------------------------------------------

Write-Step 'Checking this machine'

if ($PSVersionTable.PSEdition -eq 'Desktop' -and $PSVersionTable.PSVersion.Major -lt 5) {
    Write-Fail 'PowerShell 5.1 or newer is required.'
}

$IsWindowsHost = $true
if (Test-Path Variable:\IsWindows) { $IsWindowsHost = $IsWindows }
if (-not $IsWindowsHost) {
    Write-Warn 'This is not Windows. On Linux and macOS use ./install.sh instead; this script will still run but the Scheduled Task half does not exist here.'
}

$IsAdmin = $false
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $IsAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $IsAdmin = $false }

$Arch = $env:PROCESSOR_ARCHITECTURE
if (-not $Arch) { $Arch = 'AMD64' }
Write-Ok "Windows, $Arch$(if ($IsAdmin) { ' (Administrator)' } else { ' (current user)' })"

# Where and as whom.
if (-not $Dir) {
    if ($IsAdmin) {
        $Dir = Join-Path $env:ProgramData 'tg-ai-secretary'
    } else {
        $Dir = Join-Path $env:LOCALAPPDATA 'Programs\tg-ai-secretary'
    }
}
$Dir = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
$StateDir = Join-Path $Dir 'bot\state'
Write-Ok "Install directory: $Dir"

# Node.
$Node = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($Node) { $Node.Source } else { '' }
$NodeVersion = $null
if ($NodePath) {
    $raw = (& $NodePath -v 2>$null)
    if ($raw -match 'v?(\d+\.\d+\.\d+)') { $NodeVersion = [version]$Matches[1] }
}

if ($NodePath -and $NodeVersion -and $NodeVersion -ge $MinNode) {
    Write-Ok "Node $NodeVersion at $NodePath"
} else {
    if ($NodePath) { Write-Warn "Node $NodeVersion is too old; this needs $MinNode or newer (20+ recommended)." }
    else { Write-Warn 'Node.js is not installed.' }

    $installed = $false
    if (Test-Command winget) {
        $answer = 'n'
        if ($Yes) { $answer = 'y' } else { $answer = Read-Host '  Install Node.js LTS with winget now? (y/n) [y]'; if (-not $answer) { $answer = 'y' } }
        if ($answer -match '^(y|yes)$') {
            Invoke-Step 'winget install OpenJS.NodeJS.LTS' { & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent }
            $installed = $true
            # A fresh install is not on this process's PATH yet.
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            $Node = Get-Command node -ErrorAction SilentlyContinue
            if ($Node) { $NodePath = $Node.Source; $raw = (& $NodePath -v 2>$null); if ($raw -match 'v?(\d+\.\d+\.\d+)') { $NodeVersion = [version]$Matches[1] } }
        }
    }

    if (-not $NodePath -or -not $NodeVersion -or $NodeVersion -lt $MinNode) {
        Write-Fail @"
Node.js $MinNode or newer is required.
     Install it, then run this again:
       winget install OpenJS.NodeJS.LTS
     or download it from https://nodejs.org/en/download
     (In an unattended script: .\install.ps1 -Yes installs it with winget when available.)
"@
    }
    Write-Ok "Node $NodeVersion installed"
}

$Git = Get-Command git -ErrorAction SilentlyContinue
if (-not $Git) {
    Write-Warn 'git is not installed. The install still works, but /update needs it (winget install Git.Git).'
}

# --- 2. this CPU --------------------------------------------------------------
# Windows has no /proc/cpuinfo and Node's os.cpus() carries no flags, so the bot
# would otherwise have to guess. IsProcessorFeaturePresent is the honest answer,
# and it is the same vocabulary /proc/cpuinfo uses.

Write-Step 'Measuring this CPU'

function Get-CpuFlags {
    if ($Arch -eq 'ARM64') {
        # NEON/ASIMD is mandatory on ARM64 Windows; there is no AVX to look for.
        return 'asimd'
    }
    $typeName = 'Secretary.NativeMethods'
    if (-not ($typeName -as [type])) {
        try {
            Add-Type -Namespace Secretary -Name NativeMethods -MemberDefinition @'
[DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(uint pf);
'@
        } catch {
            Write-Warn "Could not call kernel32 to measure the CPU: $($_.Exception.Message)"
            return ''
        }
    }

    # winnt.h: 36 SSSE3, 37 SSE4.1, 38 SSE4.2, 39 AVX, 40 AVX2, 41 AVX-512F.
    # FMA has no feature bit, so it is deliberately absent rather than guessed.
    $map = [ordered]@{ 36 = 'ssse3'; 37 = 'sse4_1'; 38 = 'sse4_2'; 39 = 'avx'; 40 = 'avx2'; 41 = 'avx512f' }
    $found = @()
    foreach ($bit in $map.Keys) {
        try {
            if ([Secretary.NativeMethods]::IsProcessorFeaturePresent([uint32]$bit)) { $found += $map[$bit] }
        } catch { }
    }
    return ($found -join ' ')
}

$CpuFlags = ''
if ($WhatIfPreference) { $CpuFlags = 'avx2' }   # only used to print a line
else { $CpuFlags = Get-CpuFlags }

if ($CpuFlags) {
    Write-Ok "Instructions: $CpuFlags"
    if ($CpuFlags -notmatch 'avx2') {
        Write-Warn 'No AVX2: prebuilt llama.cpp binaries assume it. Build from source with -DGGML_NATIVE=ON (see docs/local.md section 3).'
    }
} else {
    Write-Warn 'Could not measure the CPU instructions; the model report will say "not measured" rather than guessing.'
}

# Free space on the target volume.
try {
    $root = [System.IO.Path]::GetPathRoot($Dir)
    $drive = Get-PSDrive -Name $root.Substring(0, 1) -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free -lt 200MB) {
        Write-Warn ("Only {0:N0} MB free on {1}. The bot needs ~50 MB; the model ~1 GB more." -f ($drive.Free / 1MB), $root)
    }
} catch { }

# --- 3. the code --------------------------------------------------------------

Write-Step 'Getting the code'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FromSource = $null
if ((Test-Path (Join-Path $ScriptDir 'bot\runner.mjs')) -and (Test-Path (Join-Path $ScriptDir 'package.json'))) {
    $FromSource = $ScriptDir
    Write-Ok "Installing from this checkout: $FromSource"
    if ([System.IO.Path]::GetFullPath($FromSource) -eq [System.IO.Path]::GetFullPath($Dir)) {
        Write-Fail "-Dir is the checkout you are running from ($FromSource). Install somewhere else, e.g. -Dir `$env:LOCALAPPDATA\Programs\tg-ai-secretary"
    }
} else {
    Write-Info "No checkout next to this script; will clone $RepoUrl"
}

function Copy-Code([string] $Destination) {
    if ($FromSource) {
        Invoke-Step "copy $FromSource -> $Destination (without .git, state, settings)" {
            # robocopy: the only copier that exists on every Windows, and its
            # exit codes are a bitmask where anything under 8 is success.
            $null = robocopy $FromSource $Destination /E /NFL /NDL /NJH /NJS /NP `
                /XD '.git' 'node_modules' '.tgcloud' 'bot\state' 'bot\state-demo' 'backups' `
                /XF '.env' '*.log'
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
        }
        return
    }
    Invoke-Step "git clone --depth 1 --branch $RepoBranch $RepoUrl $Destination" {
        $r = Invoke-Native 'git' @('clone', '--depth', '1', '--branch', $RepoBranch, $RepoUrl, $Destination)
        if ($r.Code -ne 0) { throw "git clone failed: $($r.Output)" }
    }
}

function Test-InstallDir([string] $Path) {
    return ((Test-Path (Join-Path $Path 'package.json')) -and (Test-Path (Join-Path $Path 'bot\runner.mjs')))
}

$IsUpgrade = $false
if (Test-InstallDir $Dir) {
    $IsUpgrade = $true
    Write-Ok 'Already installed here; upgrading (your data and settings are kept)'

    if (Test-Path (Join-Path $Dir '.git')) {
        Write-Info 'Fast-forwarding the checkout (never a merge, never a reset)'
        Invoke-Step "git -C $Dir fetch --prune; git -C $Dir merge --ff-only origin/$RepoBranch" {
            $fetch = Invoke-Native 'git' @('-C', $Dir, 'fetch', '--prune')
            if ($fetch.Code -ne 0) { Write-Warn "git fetch failed; keeping the code that is there: $($fetch.Output)" }
            $merge = Invoke-Native 'git' @('-C', $Dir, 'merge', '--ff-only', "origin/$RepoBranch")
            if ($merge.Code -ne 0) {
                Write-Warn 'Could not fast-forward: local changes, or your branch has moved.'
                Write-Warn "Nothing was overwritten. Check: git -C `"$Dir`" status"
            }
        }
    } else {
        Write-Warn 'This install has no git history, so it is copied over in place'
        Write-Warn '(/update will not work here until it is reinstalled from a clone)'
        Copy-Code $Dir
    }
} elseif ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    if (-not $Force) {
        Write-Fail "$Dir is not empty and does not look like this project.`n     Pick another place with -Dir, or -Force to install anyway."
    }
    Write-Warn 'Installing into a non-empty directory because -Force was given'
    Copy-Code $Dir
} else {
    Invoke-Step "create $Dir" { $null = New-Item -ItemType Directory -Path $Dir -Force }

    $cleanCheckout = $false
    if ($FromSource -and $Git) {
        $inside = Invoke-Native 'git' @('-C', $FromSource, 'rev-parse', '--git-dir')
        if ($inside.Code -eq 0) {
            $statusOut = Invoke-Native 'git' @('-C', $FromSource, 'status', '--porcelain')
            $cleanCheckout = ($statusOut.Code -eq 0 -and -not $statusOut.Output)
        }
    }

    if ($cleanCheckout) {
        Write-Info "Cloning from $FromSource (keeps the history, so /update works)"
        Invoke-Step "git clone $FromSource $Dir, then point origin at $RepoUrl" {
            $clone = Invoke-Native 'git' @('clone', '--quiet', $FromSource, $Dir)
            if ($clone.Code -ne 0) { throw "git clone failed: $($clone.Output)" }
            $originOut = Invoke-Native 'git' @('-C', $FromSource, 'config', '--get', 'remote.origin.url')
            $target = if ($originOut.Code -eq 0 -and $originOut.Output -and $originOut.Output -ne $FromSource) { $originOut.Output } else { $RepoUrl }
            $null = Invoke-Native 'git' @('-C', $Dir, 'remote', 'set-url', 'origin', $target)
        }
    } elseif ($FromSource) {
        Write-Warn 'This checkout has uncommitted changes, so it is copied as files.'
        Write-Warn 'The installed copy will not be a git checkout, so /update will not work here.'
        Write-Warn 'Commit and re-install from a clone if you want self-updates.'
        Copy-Code $Dir
    } else {
        Copy-Code $Dir
    }
}

if (-not $WhatIfPreference) {
    if (-not (Test-Path (Join-Path $Dir 'package.json'))) { Write-Fail "The copy failed: $(Join-Path $Dir 'package.json') is missing." }
    if (-not (Test-Path (Join-Path $Dir 'bot\runner.mjs'))) { Write-Fail "The copy failed: $(Join-Path $Dir 'bot\runner.mjs') is missing." }
    Write-Ok 'Code in place'
}

# --- 4. settings --------------------------------------------------------------
# The token never goes into the checkout when we can help it: elevated installs
# keep it in ProgramData next to the machine-wide settings, per-user installs in
# <dir>\bot\.env. Either way the file is locked down with an ACL, which is the
# Windows version of chmod 600.

Write-Step 'Settings'

if (-not $TimeZone) {
    # Windows reports time zones as "GMT Standard Time"; the bot needs IANA names
    # (Europe/London) for Intl and for quiet hours. Node already knows the mapping,
    # and Node is a requirement here, so ask it instead of carrying a table.
    $TimeZone = 'UTC'
    try {
        $tz = (& $NodePath -e "process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)" 2>$null)
        if ($tz -and $tz -match '^[A-Za-z]+/[A-Za-z_+-]+$') { $TimeZone = $tz.Trim() }
    } catch { }
    if ($env:BOT_TIMEZONE) { $TimeZone = $env:BOT_TIMEZONE }
    if ($TimeZone -eq 'UTC') {
        Write-Warn "Could not work out this machine's IANA time zone; assuming UTC. Set it later in the panel, or with -TimeZone Europe/London."
    }
}

if ($Listen -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Fail '-Listen must be an IP address.' }
if ($Port -lt 1024 -or $Port -gt 65535) { Write-Fail '-Port must be between 1024 and 65535.' }
if ($Listen -eq '0.0.0.0') {
    Write-Info 'The panel is reachable from your network; the token is the only password.'
}

# Something already on that port would make a finished install look broken.
$inUse = $null
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try { $inUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue } catch { $inUse = $null }
}
if ($inUse) {
    Write-Warn "Port $Port is already in use on this machine. Pick another with -Port."
    if (-not $Yes) {
        $go = Read-Host '  Continue anyway? (y/n) [n]'
        if ($go -notmatch '^(y|yes)$') { Write-Fail 'Nothing was installed.' }
    }
}

if ($IsAdmin) {
    $SettingsDir = Join-Path $env:ProgramData 'tg-ai-secretary'
    $EnvFile = Join-Path $SettingsDir 'bot.env'
} else {
    $SettingsDir = Join-Path $Dir 'bot'
    $EnvFile = Join-Path $SettingsDir '.env'
}

function Protect-File([string] $Path) {
    # Break inheritance, then grant exactly what is needed: the current user, the
    # system, and Administrators. /inheritance:r with explicit grants is the
    # closest thing Windows has to chmod 600 for a service file.
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $null = & icacls $Path /inheritance:r 2>&1
    $null = & icacls $Path /grant:r "${user}:(R)" 2>&1
    $null = & icacls $Path /grant:r 'SYSTEM:(R)' 2>&1
    $null = & icacls $Path /grant:r 'BUILTIN\Administrators:(F)' 2>&1
}

if (Test-Path $EnvFile) {
    Write-Ok "Keeping the existing settings: $EnvFile"
    Write-Info 'Change it there and run: tg-secretary restart'
    if ($Token -and (Get-Content $EnvFile -Raw) -notmatch [regex]::Escape("BOT_TOKEN=$Token")) {
        Invoke-Step "replace BOT_TOKEN in $EnvFile" {
            $text = Get-Content $EnvFile -Raw
            $text = [regex]::Replace($text, '(?m)^BOT_TOKEN=.*$', "BOT_TOKEN=$Token")
            [System.IO.File]::WriteAllText($EnvFile, $text, (New-Object System.Text.UTF8Encoding($false)))
            Protect-File $EnvFile
        }
        Write-Ok 'Token updated'
    }
} else {
    if (-not $Token) {
        Write-Host '  The bot token comes from @BotFather in Telegram (/newbot), and looks like 123456789:AA...'
        Write-Info 'Leave it empty to paste it into the control panel later.'
        if (-not $Yes) {
            $secure = Read-Host '  Bot token (input is hidden)' -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        }
    }
    if ($Token) {
        if ($Token -notmatch '^\d+:[\w-]+$') { Write-Warn 'That does not look like a bot token (expected 123456789:AA...). Writing it anyway.' }
    } else {
        Write-Warn 'No token: the bot starts, waits, and lets you paste one into the control panel.'
    }

    Write-Info "Writing $EnvFile (readable only by you)"
    Invoke-Step "write $EnvFile" {
        $null = New-Item -ItemType Directory -Path $SettingsDir -Force
        $lines = @(
            '# Written by install.ps1. Keep this private (its ACL says so).',
            '# Every value can also be changed later in the control panel.',
            '',
            '# --- Telegram ---',
            "BOT_TOKEN=$Token",
            '',
            '# --- Model server (llama.cpp: :8080, Ollama: :11434/v1) ---',
            "LLM_BASE_URL=$(if ($env:LLM_BASE_URL) { $env:LLM_BASE_URL } else { 'http://127.0.0.1:8080' })",
            "BOT_MODEL=$(if ($env:BOT_MODEL) { $env:BOT_MODEL } else { 'qwen3-1.7b' })",
            'LLM_PROVIDER=local',
            '',
            '# --- Control panel ---',
            "PANEL_PORT=$Port",
            "PANEL_HOST=$Listen",
            '',
            '# --- This machine, measured by install.ps1 ---',
            '# Windows has no /proc/cpuinfo; these are what kernel32 reported, so',
            '# `npm run hw` gives the same answer the installer did.',
            "SECRETARY_CPU_FLAGS=$CpuFlags",
            'SECRETARY_CPU_FLAGS_SOURCE=kernel32',
            '',
            '# --- Behaviour ---',
            "BOT_TIMEZONE=$TimeZone"
        )
        [System.IO.File]::WriteAllText($EnvFile, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Protect-File $EnvFile
    }
    Write-Ok 'Settings written'
}

Invoke-Step "create $StateDir" {
    $null = New-Item -ItemType Directory -Path $StateDir -Force
    $stateFile = Join-Path $StateDir 'bot.json'
    if (-not (Test-Path $stateFile)) { [System.IO.File]::WriteAllText($stateFile, '{}') }
}

# --- 5. the task --------------------------------------------------------------
# A Scheduled Task is the Windows equivalent of the systemd unit: start at logon,
# restart when the process exits (which is how /update hands over to new code),
# no time limit, no "only while on AC power" surprise.

$LogFile = Join-Path $StateDir 'bot.log'
$RunCmd  = Join-Path $Dir 'bin\run-bot.cmd'
$TaskInstalled = $false

if (-not $NoTask) {
    Write-Step 'Installing the Scheduled Task'

    $cmdText = @"
@echo off
rem Written by install.ps1 - regenerate rather than hand-edit.
rem The bot's output goes to a file because Scheduled Tasks have no journal.
cd /d "%~dp0.."
if not exist "bot\state" mkdir "bot\state"
"$NodePath" --import ./bot/register.mjs bot/runner.mjs >> "bot\state\bot.log" 2>&1
exit /b %errorlevel%
"@
    if ($Dir -match '[^\x00-\x7F]' -or $NodePath -match '[^\x00-\x7F]') {
        Write-Warn 'The install path or the Node path contains non-ASCII characters.'
        Write-Warn 'cmd.exe reads its script in the system code page, so the task may fail to start;'
        Write-Warn 'a path like C:\tg-ai-secretary avoids it.'
    }

    Invoke-Step "write $RunCmd" {
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $RunCmd) -Force
        [System.IO.File]::WriteAllText($RunCmd, ($cmdText -replace "`n", "`r`n"), [System.Text.Encoding]::ASCII)
    }

    Invoke-Step "register the Scheduled Task '$ServiceName'" {
        try {
            $action = New-ScheduledTaskAction -Execute $RunCmd -WorkingDirectory $Dir
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
                -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
            if ($IsAdmin) {
                Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Settings $settings `
                    -Description 'Telegram AI secretary (local model)' -RunLevel Highest -Force | Out-Null
            } else {
                Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Settings $settings `
                    -Description 'Telegram AI secretary (local model)' -Force | Out-Null
            }
            # A scriptblock runs in a child scope, so this has to be $script: or the
            # health check below would think no task was installed.
            $script:TaskInstalled = $true
            Write-Ok "Task '$ServiceName' registered (starts at logon, restarts on exit)"
        } catch {
            Write-Warn "Could not register the Scheduled Task: $($_.Exception.Message)"
            Write-Warn 'The bot is installed and can be started by hand; see the end of this output.'
            $script:TaskInstalled = $false
        }
    }

    if ($TaskInstalled) {
        Invoke-Step "start the task" { Start-ScheduledTask -TaskName $ServiceName }
    }
} else {
    Write-Step 'No Scheduled Task (-NoTask)'
    Write-Info 'Start it with:'
    Write-Host "    $NodePath --import ./bot/register.mjs bot/runner.mjs" -ForegroundColor Gray
    Write-Info "(from $Dir; its output goes to the console)"
}

# The `tg-secretary` command: the install's bin directory goes on the user PATH, so
# tg-secretary.cmd resolves from anywhere. A symlink would need elevation and does
# not survive copying, which is why the PATH entry points at the real directory.
Write-Step 'The tg-secretary command'
if (-not $NoPath) {
    $binDir = Join-Path $Dir 'bin'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
        Write-Ok "$binDir is already on your PATH"
    } else {
        Invoke-Step "add $binDir to the user PATH" {
            $newPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        }
        Write-Ok "$binDir added to your PATH (new terminals only)"
        Write-Info 'In this window it is not there yet; use the full path or open a new terminal.'
    }
} else {
    Write-Info "Skipped (-NoPath). The command is $Dir\bin\tg-secretary.cmd"
}

# --- 6. the model -------------------------------------------------------------

Write-Step 'Model server'

$LlamaCmd = ''
if ($Model) {
    if (-not (Test-Path $Model)) { Write-Fail "No such model file: $Model" }
    if (-not $LlamaPath) {
        $found = Get-Command llama-server -ErrorAction SilentlyContinue
        if ($found) { $LlamaPath = $found.Source }
    }
    if (-not $LlamaPath -or -not (Test-Path $LlamaPath)) {
        Write-Warn 'llama-server.exe not found, so no model task was written. The model file is fine.'
        Write-Warn 'Build or download llama.cpp (docs/local.md section 3), then re-run with -LlamaPath.'
    } else {
        $threads = 4
        try {
            $cores = [int]$env:NUMBER_OF_PROCESSORS
            if ($cores -gt 0) { $threads = [Math]::Min(8, $cores) }
        } catch { }
        $LlamaCmd = "`"$LlamaPath`" -m `"$Model`" -c 4096 -np 1 -t $threads -b 256 -ub 256 --jinja --no-webui --host 127.0.0.1 --port 8080"

        if (-not $NoTask) {
            Invoke-Step "register the model task '$LlamaTask'" {
                try {
                    $llamaCmdFile = Join-Path $Dir 'bin\run-model.cmd'
                    $text = "@echo off`r`nrem Written by install.ps1`r`ncd /d `"%~dp0..`"`r`n" + $LlamaCmd.Replace('%', '%%') + " >> `"bot\state\llama.log`" 2>&1`r`n"
                    [System.IO.File]::WriteAllText($llamaCmdFile, $text, [System.Text.Encoding]::ASCII)
                    $a = New-ScheduledTaskAction -Execute $llamaCmdFile -WorkingDirectory $Dir
                    $t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
                    $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
                    Register-ScheduledTask -TaskName $LlamaTask -Action $a -Trigger $t -Settings $s `
                        -Description 'llama.cpp server for the Telegram secretary' -Force | Out-Null
                    Start-ScheduledTask -TaskName $LlamaTask
                    Write-Ok "Model task registered ($threads threads, 127.0.0.1:8080)"
                } catch {
                    Write-Warn "Could not register the model task: $($_.Exception.Message)"
                    Write-Info "Start it yourself: $LlamaCmd"
                }
            }
        } else {
            Write-Info 'Start the model server in another window:'
            Write-Host "    $LlamaCmd" -ForegroundColor Gray
        }
    }
} else {
    Write-Info 'No -Model given, so the model server is yours to start. That is deliberate:'
    Write-Info 'the right GGUF depends on this CPU, and it is a ~1 GB download.'
    Write-Host ''
    Write-Host "  What this machine can do:   tg-secretary hw" -ForegroundColor Gray
    Write-Host '  Then docs/local.md section 3: download Qwen3-1.7B Q4_K_M and run llama-server,'
    Write-Host "  or use Ollama and set LLM_BASE_URL=http://127.0.0.1:11434/v1 in $EnvFile."
}

# --- 7. does it answer? -------------------------------------------------------

Write-Step 'Checking it runs'

$PanelUrl = "http://127.0.0.1:$Port"

function Test-Panel {
    try {
        $r = Invoke-WebRequest -Uri "$PanelUrl/api/ping" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Wait-Panel([int] $Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Panel) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

if ($WhatIfPreference) {
    Write-Info 'Skipped in a dry run'
} elseif ($TaskInstalled) {
    if (Wait-Panel 20) {
        Write-Ok "The control panel answers on $PanelUrl"
    } else {
        Write-Warn 'The panel is not answering yet. Its log:'
        Write-Host "    Get-Content `"$LogFile`" -Tail 30" -ForegroundColor Gray
    }
} elseif (Test-Panel) {
    Write-Ok "Something already answers on $PanelUrl"
} else {
    Write-Info 'Starting the bot for a moment to see whether it comes up'
    $proc = $null
    try {
        $proc = Start-Process -FilePath $NodePath -ArgumentList '--import', './bot/register.mjs', 'bot/runner.mjs' `
            -WorkingDirectory $Dir -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $StateDir 'install-out.log') `
            -RedirectStandardError  (Join-Path $StateDir 'install-err.log')
        if (Wait-Panel 10) {
            Write-Ok "It runs: the control panel answers on $PanelUrl"
        } else {
            Write-Warn 'It did not answer within 10 seconds. Its output:'
            $out = Join-Path $StateDir 'install-out.log'
            $err = Join-Path $StateDir 'install-err.log'
            if (Test-Path $out) { Get-Content $out -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray } }
            if (Test-Path $err) { Get-Content $err -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray } }
        }
    } catch {
        Write-Warn "Could not start the bot: $($_.Exception.Message)"
    } finally {
        if ($proc -and -not $proc.HasExited) {
            # Let it shut down cleanly: it saves state and releases its lock.
            try { $proc.CloseMainWindow() | Out-Null } catch { }
            Start-Sleep -Seconds 1
            if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        }
    }
}

# --- done ---------------------------------------------------------------------

$TokenFile = Join-Path $StateDir 'panel-token'
$PanelToken = ''
if (Test-Path $TokenFile) { $PanelToken = (Get-Content $TokenFile -Raw).Trim() }

Write-Host ''
Write-Host '---------------------------------------------' -ForegroundColor DarkGray
Write-Host ' Installed' -ForegroundColor White
Write-Host '---------------------------------------------' -ForegroundColor DarkGray
Write-Host "  code        $Dir"
Write-Host "  settings    $EnvFile"
Write-Host "  data        $StateDir"
Write-Host "  panel       $PanelUrl"
if ($PanelToken) {
    Write-Host "  panel token $PanelToken"
    Write-Host "  open        $PanelUrl/?token=$PanelToken"
} else {
    Write-Host "  panel token printed at start-up, and kept in $TokenFile"
}
if ($TaskInstalled) {
    Write-Host "  task        $ServiceName (starts at logon)"
    Write-Host "  logs        tg-secretary logs"
}
Write-Host ''
Write-Host ' Two things to do now' -ForegroundColor White
Write-Host '  1. Send /claim to the bot in Telegram - it ignores everyone until it has an owner.'
Write-Host '  2. Make sure the model server is running (above), then press "Try the model"'
Write-Host '     in the dashboard.'
Write-Host ''
Write-Host ' Later' -ForegroundColor White
Write-Host '  tg-secretary status        is it running, and is the model server up'
Write-Host '  tg-secretary panel         the panel URL with its token'
Write-Host '  tg-secretary logs -f       follow the log'
Write-Host '  tg-secretary update        check GitHub, then: update apply'
Write-Host "  Re-run this script with -Dir `"$Dir`" to upgrade."
Write-Host '  .\uninstall.ps1 keeps your data; add -Purge to delete it.'
Write-Host ''

if ($WhatIfPreference) {
    Write-Host ' (what-if: nothing above was actually done)' -ForegroundColor Yellow
    Write-Host ''
}
