# Windows

The bot runs on Windows natively — Node, no service manager required, no WSL. The
installer is PowerShell, and the command is the same `tg-secretary` you get on Linux.

```powershell
git clone https://github.com/ygasaino1/tg-ai-secretary.git
cd tg-ai-secretary
notepad .\install.ps1        # it schedules a task; read it first
.\install.ps1
```

If PowerShell refuses to run the script (`... is not digitally signed`), that is the
execution policy, not a problem with the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It finishes by printing the panel URL and its token, and by telling you the two things
it deliberately did not do for you.

## What it does, and what each piece replaces

| Linux | Windows | Why it is the equivalent |
|---|---|---|
| systemd unit, `Restart=always` | **Scheduled Task** with `RestartCount 999` / 1-minute interval | This is what lets `/update` restart into new code: the bot exits 0, the task starts it again |
| `chmod 600 /etc/secretary-bot.env` | **`%ProgramData%\tg-ai-secretary\bot.env`** with an ACL (`icacls /inheritance:r`) | The token lives outside the checkout and only your account, SYSTEM and Administrators can read it |
| `journalctl -u secretary` | **`bot\state\bot.log`**, via `tg-secretary logs` | A task has no journal, so the bot's output is appended to a file |
| `/proc/cpuinfo` | **`IsProcessorFeaturePresent`** (kernel32), passed on as `SECRETARY_CPU_FLAGS` | Windows has no `/proc` and Node reports no CPU flags; guessing AVX2 is how people end up with a build that crashes |
| `/usr/local/bin/tg-secretary` symlink | the install's `bin` directory on your **user PATH**, with `tg-secretary.cmd` | A symlink needs elevation on Windows and does not survive copying |

## Options

```
-Dir PATH         where to install (default: %LOCALAPPDATA%\Programs\tg-ai-secretary;
                  %ProgramData%\tg-ai-secretary when run as Administrator)
-Token TOKEN      bot token from @BotFather (otherwise asked, hidden)
-Port N           control panel port (default 8787)
-Listen ADDR      panel bind address (default 0.0.0.0; 127.0.0.1 keeps it on this PC)
-TimeZone TZ      IANA name, e.g. Europe/London (default: read from Node)
-Model PATH       a local .gguf; writes a second Scheduled Task for llama-server
-LlamaPath PATH   llama-server.exe
-NoTask           files and settings only, no Scheduled Task
-NoPath           do not touch your user PATH
-Force            install into a non-empty directory that is not ours
-Yes              never ask (unattended)
-WhatIf           print every step, change nothing
```

`-WhatIf` is the same promise as `--dry-run` on Linux: nothing is written, nothing is
registered, and every step it would have taken is printed.

## After it finishes

1. **`/claim`** in Telegram — until an owner exists the bot answers `/id` and `/claim`
   and nothing else.
2. Start the model server, then press **Try the model** on the dashboard.

The model server is not installed for you. Download llama.cpp's Windows build
(`llama-server.exe`) and a GGUF, then either re-run the installer with `-Model`, or
start it yourself:

```powershell
.\llama-server.exe -m .\Qwen3-1.7B-Instruct-Q4_K_M.gguf -c 4096 -np 1 -t 4 `
  -b 256 -ub 256 --jinja --no-webui --host 127.0.0.1 --port 8080
```

Ollama works too: install it, `ollama pull qwen3:1.7b`, then set
`LLM_BASE_URL=http://127.0.0.1:11434/v1` in the settings file and
`tg-secretary restart`.

## The command

```powershell
tg-secretary status      # task state, version, panel, token, model server
tg-secretary panel       # the URL with its token
tg-secretary logs -f     # follow bot\state\bot.log
tg-secretary restart     # after editing the settings file
tg-secretary update      # what is on GitHub; then: tg-secretary update apply
tg-secretary hw          # what this machine can run
tg-secretary paths       # code, settings, data, log
```

`tg-secretary.cmd` forwards to `tg-secretary.ps1`, so it works from `cmd.exe`, PowerShell
and Windows Terminal alike. Flags are read by the script itself rather than by PowerShell's
parameter binding, so `-f`, `-n 50`, `-Foreground` and `--purge` all work, in either
spelling, without the command stopping with *A parameter cannot be found*.

From the repository root, `tg-secretary` also works **before** you install anything: there is
a `tg-secretary.cmd` at the top of the checkout that runs the copy you are standing in.
It controls that copy, with its own state in `bot\state` — not the installed one.

A new terminal is needed once after installing, because the PATH change is per-user and
does not reach the window you installed from. The installer prints the full path of the
command for that window, and says when a fresh one will find it by itself.

## Upgrading and uninstalling

```powershell
.\install.ps1 -Dir "$env:LOCALAPPDATA\Programs\tg-ai-secretary"   # upgrade, keeps data
.\uninstall.ps1 -Dir <same path>                                   # stop + remove the task
.\uninstall.ps1 -Dir <same path> -Purge                            # also delete everything
```

`uninstall.ps1` only unregisters tasks whose description says this project wrote them,
and only removes the `bin` PATH entry that points at the install being removed.

## If the install path is not plain ASCII

`cmd.exe` reads the small `.cmd` shim that the Scheduled Task starts in the system code page,
so a path containing `é`, `ü` or a non-Latin user name can stop the task from starting the
bot. The installer warns when it sees one. The fix is a plain path:

```powershell
.\install.ps1 -Dir C:\tg-ai-secretary
```

## What the first real Windows run found

It found a bug the Linux checkout could not: `install.ps1` stopped at the git step with

```
git.exe : From https://github.com/...
    + CategoryInfo          : NotSpecified: (From ...:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

git writes its progress to stderr, and PowerShell 5.1 turns *redirected* native stderr into
an error record — which `$ErrorActionPreference = 'Stop'` then turns into a terminating
error, thrown before the script can look at the exit code. Everything native now goes
through one helper that relaxes that preference for the length of the call, and the exit
code decides. That is in 1.6.1; if you see the message above, you are running the old file.

## What is verified, and what is not

The JavaScript half — reading the settings file (including a UTF-8 BOM and CRLF, which
Windows PowerShell writes), and turning Windows CPU measurements into a model
recommendation — is tested for real, on every `npm test`.

The PowerShell half cannot be executed in the Linux checkout this project is developed
in. It is checked structurally instead: bracket balance with PowerShell's own string and
comment rules, no PowerShell 7-only syntax (the scripts declare `#Requires -Version 5.1`),
no writes to read-only automatic variables like `$pid`, the cmdlets it calls actually
exist, that `$script:` is used where a value has to survive a scriptblock, and both front
ends offering the same commands. That catches the mistakes that usually break installers,
but **the first real run on Windows is yours** — the same
honesty the README applies to Telegram and the model.

## When something goes wrong

| Symptom | What to do |
|---|---|
| `running scripts is disabled on this system` | `powershell -ExecutionPolicy Bypass -File .\install.ps1` |
| `Node.js 18.19 or newer is required` | `winget install OpenJS.NodeJS.LTS`, then open a new terminal |
| The panel does not answer | `tg-secretary logs -n 50`; the installer prints the same tail when its own check fails |
| `A parameter cannot be found that matches parameter name …` | You are running an older `tg-secretary.ps1`: flags are parsed by the script itself from v1.6 on |
| `git.exe : From https://…` then `NativeCommandError` | Fixed in 1.6.1: `install.ps1` in front of you is older. Re-run the newer one, or `git -C <install> pull` first |
| `'tg-secretary' is not recognized as an internal or external command` | Either the installer has not reached its PATH step yet, or this window predates the change. Open a new terminal, run the full path `"%LOCALAPPDATA%\Programs\tg-ai-secretary\bin\tg-secretary.cmd" status`, or — inside the checkout — use `.\tg-secretary.cmd status` |
| The task runs then stops immediately | `tg-secretary logs` — usually a missing token or a port already in use |
| "No AVX2" on a machine that has it | It cannot: the installer measures with kernel32. `npm run hw` without it says "not measured" instead of guessing |
