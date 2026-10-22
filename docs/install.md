# Installing

One script, one directory, one service. `install.sh` is meant to be read before it is
run: it is ~600 lines of plain bash with no downloads other than the code itself.

```bash
git clone https://github.com/ygasaino1/tg-ai-secretary.git
cd tg-ai-secretary
less install.sh          # it asks for root-ish things; look at them first
./install.sh             # or: sudo ./install.sh
```

Installing from a fork or your own copy works the same way — run `./install.sh` from that
checkout and the code is copied from there. `SECRETARY_REPO=<git url>` changes where a
standalone download of the script clones from.

It finishes by printing the panel URL and the panel token, and by telling you the two
things it deliberately did not do for you.

## What it actually does

| Step | Detail |
|---|---|
| **Checks the machine** | Linux/64-bit, free space, and Node ≥ 18.19 (every `npm` script uses `node --import`). If Node is missing and you are root, it offers to install it with your package manager — nothing is installed without a yes. |
| **Puts the code somewhere** | Default `/opt/tg-ai-secretary` as root, `~/tg-ai-secretary` otherwise. From a clean checkout it makes a local `git clone` and re-points `origin` at the real remote, so `/update` works in the installed copy. From a dirty checkout or a downloaded tarball it copies files instead, and says that `/update` will not work there. `bot/state/`, `bot/.env` and `node_modules` never travel. |
| **Writes the settings** | `/etc/secretary-bot.env` as root, `<dir>/bot/.env` otherwise. Mode `0600`, outside the repository, never printed except for the panel token. |
| **Installs a service** | A systemd unit with `Restart=always` — which is what makes `/update` restart into the new code by itself. `Nice=5`, so the bot yields to the model server. |
| **Starts it, then waits** | Polls `http://127.0.0.1:<port>/api/ping` and tells you whether it answered. If it did not, it prints the first lines of the log instead of claiming success. |

It does **not** download a model. The right GGUF depends on the CPU in the box, it is a
~1 GB download, and picking wrong is slower than doing nothing. It prints
`npm run hw` and the exact `llama-server` line instead — see [local.md](local.md) §3.

## Options

```
--dir PATH        where to install
--user NAME       run the service as NAME (default: $SUDO_USER, or "secretary" as root)
--token TOKEN     bot token from @BotFather (otherwise asked, or pasted into the panel later)
--port N          control panel port (default 8787)
--listen ADDR     panel bind address (default 0.0.0.0; 127.0.0.1 keeps it on this machine)
--timezone TZ     default: this machine's timezone
--model PATH      local GGUF; also writes a llama-server service if llama-server is found
--llama PATH      path to llama-server
--service         install a systemd service   } default: yes when systemd is actually
--no-service      don't                        } running, no otherwise
--dry-run         print every step, change nothing
--force           install into a non-empty directory that is not ours
--yes, -y         take the defaults, never ask
```

`--dry-run` is honest: every mutating action is printed instead of performed, and it
stops at the first thing that would have failed. It is the fastest way to see what an
install on *your* machine would do.

## After it finishes

1. **`/claim`** in Telegram — until an owner exists the bot answers `/id` and `/claim`
   and nothing else.
2. Start the model server, then press **Try the model** on the dashboard. A green
   `online · N ms` means the whole chain works.

## Upgrading

```bash
./install.sh --dir /path/to/install     # or just /update in Telegram
```

An existing install is detected and upgraded: settings and `bot/state/` are kept, and a
git checkout is fast-forwarded (`--ff-only`) rather than clobbered. If the branch has
diverged it says so and changes nothing.

## Uninstalling

```bash
bash uninstall.sh --dir /path/to/install          # stop and remove the service, keep data
bash uninstall.sh --dir /path/to/install --purge  # also delete the code, token and messages
```

It only removes unit files containing the line `# Installed by install.sh` — a service
you wrote yourself with the same name is left alone. `--purge` asks once, shows the size
of what is about to go, and stops any bot still running from that directory first.

## When there is no systemd

Containers and consoles often have `systemctl` but no init. The installer asks systemd
whether it is running (`systemctl is-system-running`) rather than trusting the directory,
and falls back to starting the bot once, checking the panel answers, then telling you how
to start it yourself:

```bash
cd /path/to/install && node --import ./bot/register.mjs bot/runner.mjs
```

The same happens without root: it will use `systemd --user` if that bus exists, and
enables lingering so the bot survives logout.

## What it deliberately leaves behind

- **The model and llama.cpp** — yours to place, because the right build depends on the CPU.
- **The bot in Telegram** — `/deletebot` in @BotFather, so removing a directory never
  silently keeps a live bot that still answers for you.
- **The `secretary` system user**, if it created one.

## If something goes wrong

| Symptom | What to do |
|---|---|
| `✖ … does not look like this project` | You pointed `--dir` at a directory with other files. Pick another place, or `--force` if you are sure. |
| `Node … is too old` | Needs 18.19+ (20 recommended). The message prints the exact command per distribution. |
| Panel does not answer | `journalctl -u secretary -n 50` (or `journalctl --user -u secretary`). The installer prints the same log tail when the check fails. |
| `EADDRINUSE` on the panel port | Something else owns 8787. Re-run the installer with `--port 8790`, or edit `PANEL_PORT` in the settings file and restart. |
| You lost the panel token | `cat /path/to/install/bot/state/panel-token` — or `PANEL_TOKEN` in the settings file. |
