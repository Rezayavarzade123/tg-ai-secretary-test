#!/usr/bin/env bash
#
# install.sh — put the Telegram AI secretary on this machine.
#
# What it does, in order:
#   1. checks the machine (Linux, 64-bit, Node ≥ 18.19, git, systemd)
#   2. puts the code in one directory (a git clone where possible, so /update works)
#   3. writes a private settings file with your bot token (0600), never into the repo
#   4. installs a systemd service that restarts on crash and after /update
#   5. starts it and waits until the control panel answers
#
# It does not download a model: the right GGUF depends on the CPU here, and it is
# a ~1 GB download, so it prints the exact command instead (docs/local.md §3).
#
# Run it from a clone (`./install.sh`) or standalone:
#   curl -fsSLO https://raw.githubusercontent.com/ygasaino1/tg-ai-secretary/main/install.sh
#   less install.sh && bash install.sh
#
# Nothing here requires root. With root it installs a system unit; without it,
# a systemd --user unit or a plain start command.
#
set -euo pipefail
IFS=$'\n\t'

REPO_URL="${SECRETARY_REPO:-https://github.com/ygasaino1/tg-ai-secretary.git}"
BRANCH="${SECRETARY_BRANCH:-main}"
SERVICE_NAME="secretary"
LLAMA_SERVICE="llama-server"
DEFAULT_PORT="${PANEL_PORT:-8787}"

# --- output -------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=''; D=''; G=''; Y=''; R=''; C=''; N=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$C" "$*" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%s✖ %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Every mutating command goes through this, so --dry-run is honest about what it
# would do without doing any of it.
run() {
  if $DRY_RUN; then
    printf '  %s[dry]%s' "$D" "$N"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# --- defaults -----------------------------------------------------------------

ASSUME_YES=false
DRY_RUN=false
DO_SERVICE=auto       # auto | yes | no
FORCE=false
INSTALL_DIR=""
RUN_USER=""
BOT_TOKEN_ARG=""
PANEL_PORT_ARG=""
MODEL_PATH=""
LLAMA_BIN=""
TIMEZONE_ARG=""
PANEL_HOST_ARG=""
FROM_SOURCE=""
DO_LINK=yes            # put `tg-secretary` on PATH

usage() {
  cat <<USAGE
${B}Telegram AI secretary — installer${N}

Usage: bash install.sh [options]

  --dir PATH           where to install        (default: /opt/tg-ai-secretary as root,
                                                ~/tg-ai-secretary otherwise)
  --user NAME          run the service as NAME (default: the user who invoked sudo,
                                                or a dedicated "secretary" user as root)
  --token TOKEN        bot token from @BotFather (default: ask, or keep the existing one)
  --port N             control panel port      (default: $DEFAULT_PORT)
  --listen ADDR        panel bind address      (default: 0.0.0.0; 127.0.0.1 keeps it local)
  --timezone TZ        e.g. Europe/London      (default: this machine's timezone)
  --model PATH         local GGUF for llama.cpp; also writes a llama-server service
  --llama PATH         path to llama-server    (default: found in PATH)
  --service / --no-service   install a systemd service, or don't
                             (default: yes when systemd is running)
  --no-link            do not put the tg-secretary command on PATH
  --dry-run            print every step, change nothing
  --force              install into a non-empty directory that is not ours
  --yes, -y            never ask; take the defaults (for scripts)
  --help, -h           this text

After it finishes: open the panel URL, then send /claim to the bot in Telegram.

  Upgrade:    bash install.sh --dir <same path>
  Uninstall:  bash uninstall.sh --dir <same path>          (keeps your data)
              bash uninstall.sh --dir <same path> --purge  (deletes it too)
USAGE
}

# --- arguments ----------------------------------------------------------------

need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        need_value "$@"; INSTALL_DIR=$2; shift 2 ;;
    --user)       need_value "$@"; RUN_USER=$2; RUN_USER_EXPLICIT=1; shift 2 ;;
    --token)      need_value "$@"; BOT_TOKEN_ARG=$2; shift 2 ;;
    --port)       need_value "$@"; PANEL_PORT_ARG=$2; shift 2 ;;
    --listen)     need_value "$@"; PANEL_HOST_ARG=$2; shift 2 ;;
    --timezone)   need_value "$@"; TIMEZONE_ARG=$2; shift 2 ;;
    --model)      need_value "$@"; MODEL_PATH=$2; shift 2 ;;
    --llama)      need_value "$@"; LLAMA_BIN=$2; shift 2 ;;
    --service)    DO_SERVICE=yes; shift ;;
    --no-service) DO_SERVICE=no; shift ;;
    --no-link)    DO_LINK=no; shift ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --force)      FORCE=true; shift ;;
    --yes|-y)     ASSUME_YES=true; shift ;;
    --help|-h)    usage; exit 0 ;;
    *)            die "Unknown option: $1 (see --help)" ;;
  esac
done

if $DRY_RUN; then ASSUME_YES=true; fi   # a dry run must never block on a prompt

# --- prompts ------------------------------------------------------------------

# ask "question" "default" -> echoes the answer. Never prompts with --yes, and
# reads the terminal rather than stdin, so a piped script can still ask questions.
ask() {
  local question=$1 default=${2:-} answer=''
  if $ASSUME_YES; then printf '%s' "$default"; return 0; fi
  if [ -t 0 ]; then
    printf '  %s%s%s %s[%s]%s ' "$B" "$question" "$N" "$D" "${default:-}" "$N" >&2
    IFS= read -r answer || answer=''
  elif [ -r /dev/tty ]; then
    printf '  %s%s%s %s[%s]%s ' "$B" "$question" "$N" "$D" "${default:-}" "$N" >&2
    IFS= read -r answer < /dev/tty || answer=''
  else
    printf '%s' "$default"; return 0
  fi
  printf '%s' "${answer:-$default}"
}

# ask_secret "question" -> the token, echoed to stdout but not to the screen
ask_secret() {
  local question=$1 answer=''
  if $ASSUME_YES; then return 0; fi
  if [ -r /dev/tty ]; then
    printf '  %s%s%s ' "$B" "$question" "$N" >&2
    IFS= read -rs answer < /dev/tty || answer=''
    printf '\n' >&2
  fi
  printf '%s' "$answer"
}

confirm() {
  local question=$1 default=${2:-y} answer
  if $ASSUME_YES; then return 0; fi
  answer=$(ask "$question (y/n)" "$default")
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- 1. the machine -----------------------------------------------------------

step "Checking this machine"

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Linux) ok "Linux, $ARCH" ;;
  *)
    warn "This is $OS. install.sh is the Linux installer: it writes a systemd unit."
    if [ "$OS" = "MINGW64_NT-10.0" ] || [ "$OS" = "MSYS_NT-10.0" ] || [ -n "${MSYSTEM:-}" ] || [ -d /c/Windows ]; then
      warn "On Windows use install.ps1 instead - it schedules a Task and sets an ACL:"
      say "    powershell -ExecutionPolicy Bypass -File .\install.ps1"
      die "Nothing was installed."
    fi
    warn "The bot is plain Node and should run, but the service install assumes Linux."
    ;;
esac
case "$ARCH" in
  x86_64|amd64|aarch64|arm64|armv7l) ;;
  *) warn "Untested architecture: $ARCH. Small models are slow but possible; see docs/local.md." ;;
esac

IS_ROOT=false
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=true; fi

if [ -z "$RUN_USER" ]; then
  if $IS_ROOT; then
    RUN_USER="${SUDO_USER:-secretary}"
  else
    RUN_USER=$(id -un)
  fi
fi
if [ "$RUN_USER" = "root" ]; then
  warn "Running the bot as root. It reads your messages; a normal user is safer."
fi
if [ -n "${RUN_USER_EXPLICIT:-}" ] && ! $IS_ROOT; then
  warn "--user only applies when installing as root; without root the service runs as $(id -un)."
fi

if [ -z "$INSTALL_DIR" ]; then
  if $IS_ROOT; then INSTALL_DIR=/opt/tg-ai-secretary; else INSTALL_DIR="$HOME/tg-ai-secretary"; fi
fi
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
INSTALL_DIR=${INSTALL_DIR%/}
ok "Install directory: $INSTALL_DIR"
ok "Service user: $RUN_USER"

# Node. `--import` (used by every npm script) needs 18.19 or newer.
NODE_BIN=$(command -v node 2>/dev/null || true)
node_version_ok() {
  local v major minor
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}
  major=${v%%.*}
  minor=${v#*.}; minor=${minor%%.*}
  { [ "$major" -gt 18 ] || { [ "$major" -eq 18 ] && [ "$minor" -ge 19 ]; }; } 2>/dev/null
}

if [ -n "$NODE_BIN" ] && node_version_ok "$NODE_BIN"; then
  ok "Node $("$NODE_BIN" -v) at $NODE_BIN"
else
  if [ -n "$NODE_BIN" ]; then
    warn "Node $("$NODE_BIN" -v) is too old; this needs 18.19 or newer (20+ recommended)."
  else
    warn "Node.js is not installed."
  fi
  INSTALLED_NODE=false
  if $IS_ROOT && have apt-get && confirm "Install Node.js with apt-get now?" y; then
    run apt-get update -qq || true
    run apt-get install -y nodejs && INSTALLED_NODE=true
  elif $IS_ROOT && have dnf && confirm "Install Node.js with dnf now?" y; then
    run dnf install -y nodejs && INSTALLED_NODE=true
  elif $IS_ROOT && have pacman && confirm "Install Node.js with pacman now?" y; then
    run pacman -S --noconfirm nodejs && INSTALLED_NODE=true
  fi
  NODE_BIN=$(command -v node 2>/dev/null || true)
  if $INSTALLED_NODE && [ -n "$NODE_BIN" ] && node_version_ok "$NODE_BIN"; then
    ok "Node $("$NODE_BIN" -v) installed"
  elif [ -z "$NODE_BIN" ] || ! node_version_ok "$NODE_BIN"; then
    die "Install Node.js 20 (or 18.19+) and run this again:
     Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
     Fedora:         sudo dnf install nodejs
     Arch:           sudo pacman -S nodejs
     Any distro:     https://nodejs.org/en/download"
  fi
fi
$DRY_RUN || "$NODE_BIN" -e 'process.exit(0)' || die "Node at $NODE_BIN does not run."

have git || warn "git is not installed. The install still works, but /update needs it (apt install git)."

# Which systemd we can actually talk to. A directory existing is not enough:
# inside a container with no init, systemctl exists and every call fails, and
# pretending otherwise leaves a "service installed" that never starts.
systemd_system_running() {
  local s
  have systemctl || return 1
  [ -d /run/systemd/system ] || return 1
  s=$(systemctl is-system-running 2>/dev/null || true)
  case "$s" in running|degraded|starting|initializing|maintenance) return 0 ;; esac
  return 1
}

systemd_user_running() {
  local s
  have systemctl || return 1
  s=$(systemctl --user is-system-running 2>/dev/null || true)
  case "$s" in running|degraded|starting|initializing|maintenance) return 0 ;; esac
  return 1
}

# Root gets a system unit; anyone else needs a working --user bus. Linger is what
# keeps that unit alive after logout, and it is enabled below.
SYSTEMD_SCOPE=""
if $IS_ROOT && systemd_system_running; then
  SYSTEMD_SCOPE=system
elif ! $IS_ROOT && systemd_user_running; then
  SYSTEMD_SCOPE=user
fi

if [ "$DO_SERVICE" = auto ]; then
  if [ -n "$SYSTEMD_SCOPE" ]; then DO_SERVICE=yes; else DO_SERVICE=no; fi
fi
if [ "$DO_SERVICE" = yes ] && [ -z "$SYSTEMD_SCOPE" ]; then
  if systemd_system_running; then
    warn "systemd is running, but not for this user: a service needs root, or a login session with a user bus."
  else
    warn "systemd is not running here, so no service will be installed."
  fi
  warn "The bot will run from the command line instead (see the end of this output)."
  DO_SERVICE=no
fi
if [ "$DO_SERVICE" = yes ] && [ "$SYSTEMD_SCOPE" = user ]; then
  info "No root: the service is installed as a systemd --user unit for $RUN_USER."
fi

PARENT=$(dirname "$INSTALL_DIR")
run mkdir -p "$PARENT" 2>/dev/null || true
if have df && [ -d "$PARENT" ]; then
  # `|| true`: df on a path that does not exist yet (dry run) must not kill the script.
  FREE_MB=$(df -Pm "$PARENT" 2>/dev/null | awk 'NR==2 {print $4}' || true)
  if [ -n "${FREE_MB:-}" ] && [ "${FREE_MB:-0}" -lt 200 ] 2>/dev/null; then
    warn "Only ${FREE_MB} MB free in $PARENT. The bot needs ~50 MB; the model ~1 GB more."
  fi
fi

# --- 2. the code --------------------------------------------------------------

step "Getting the code"

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$SRC_DIR/bot/runner.mjs" ] && [ -f "$SRC_DIR/package.json" ]; then
  FROM_SOURCE=$SRC_DIR
  if [ "$(cd "$FROM_SOURCE" && pwd -P)" = "$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P)" ]; then
    die "--dir is the checkout you are running from ($FROM_SOURCE).
     Install somewhere else: --dir /opt/tg-ai-secretary"
  fi
  ok "Installing from this checkout: $FROM_SOURCE"
else
  info "No checkout next to this script; will clone $REPO_URL"
fi

# Put the code in place.
#
# First install, from a clean checkout of this project: a local `git clone`, because
# it is fast (hardlinks), keeps the history, and leaves a checkout the built-in
# updater can fast-forward. Its `origin` is re-pointed at the real remote, so
# `/update` pulls from GitHub and not from the directory you installed from.
#
# Everything else (a dirty checkout, a downloaded tarball, a directory that is
# already installed) is a file copy that leaves `bot/state/`, `bot/.env`, `.git`
# and `node_modules` alone.
copy_code() {
  local dest=$1
  if $DRY_RUN; then
    if [ -n "$FROM_SOURCE" ]; then
      printf '  %s[dry] copy %s -> %s (no .git, state or settings)%s\n' "$D" "$FROM_SOURCE" "$dest" "$N"
    else
      printf '  %s[dry] git clone --depth 1 --branch %s %s %s%s\n' "$D" "$BRANCH" "$REPO_URL" "$dest" "$N"
    fi
    return 0
  fi
  if [ -n "$FROM_SOURCE" ]; then
    tar -C "$FROM_SOURCE" -cf - \
      --exclude=.git --exclude=node_modules --exclude=.tgcloud \
      --exclude='bot/state' --exclude='bot/state-*' --exclude='bot/.env' \
      --exclude='*.log' . | tar -x -C "$dest"
  else
    run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest"
  fi
}

clone_from_source() {
  local dest=$1 src_origin
  if $DRY_RUN; then
    printf '  %s[dry] git clone %s %s (then set origin to the real remote)%s\n' "$D" "$FROM_SOURCE" "$dest" "$N"
    return 0
  fi
  git clone --quiet "$FROM_SOURCE" "$dest"
  src_origin=$(git -C "$FROM_SOURCE" config --get remote.origin.url 2>/dev/null || true)
  if [ -n "$src_origin" ] && [ "$src_origin" != "$FROM_SOURCE" ]; then
    git -C "$dest" remote set-url origin "$src_origin"
  else
    git -C "$dest" remote set-url origin "$REPO_URL"
  fi
}

source_is_clean_checkout() {
  [ -n "$FROM_SOURCE" ] && have git \
    && git -C "$FROM_SOURCE" rev-parse --git-dir >/dev/null 2>&1 \
    && [ -z "$(git -C "$FROM_SOURCE" status --porcelain 2>/dev/null)" ]
}

if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ] && [ -d "$INSTALL_DIR/bot" ]; then
  ok "Already installed here; upgrading (your data and settings are kept)"
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Fast-forwarding the checkout (never a merge, never a reset)"
    if $DRY_RUN; then
      printf '  %s[dry] git -C %s fetch --prune && git -C %s merge --ff-only origin/%s%s\n' \
        "$D" "$INSTALL_DIR" "$INSTALL_DIR" "$BRANCH" "$N"
    else
      git -C "$INSTALL_DIR" fetch --prune || warn "git fetch failed; keeping the code that is there"
      git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" || {
        warn "Could not fast-forward: local changes, or your branch has moved."
        warn "Nothing was overwritten. Check: git -C $INSTALL_DIR status"
      }
    fi
  else
    warn "This install has no git history, so it is copied over in place"
    warn "(/update will not work here until it is reinstalled from a clone)"
    copy_code "$INSTALL_DIR"
  fi
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  if ! $FORCE; then
    die "$INSTALL_DIR is not empty and does not look like this project.
     Pick another place with --dir, or --force to install anyway."
  fi
  warn "Installing into a non-empty directory because --force was given"
  copy_code "$INSTALL_DIR"
else
  run mkdir -p "$INSTALL_DIR"
  if source_is_clean_checkout; then
    info "Cloning from $FROM_SOURCE (keeps the history, so /update works)"
    clone_from_source "$INSTALL_DIR"
  elif [ -n "$FROM_SOURCE" ]; then
    warn "This checkout has uncommitted changes, so it is copied as files."
    warn "The installed copy will not be a git checkout, so /update will not work here."
    warn "Commit and re-install from a clone if you want self-updates."
    copy_code "$INSTALL_DIR"
  else
    copy_code "$INSTALL_DIR"
  fi
fi

if ! $DRY_RUN; then
  [ -f "$INSTALL_DIR/package.json" ] || die "The copy failed: $INSTALL_DIR/package.json is missing."
  [ -f "$INSTALL_DIR/bot/runner.mjs" ] || die "The copy failed: $INSTALL_DIR/bot/runner.mjs is missing."
  ok "Code in place ($(du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1) on disk)"
fi

# --- 3. settings --------------------------------------------------------------

step "Settings"

TZ_DEFAULT=$TIMEZONE_ARG
if [ -z "$TZ_DEFAULT" ]; then
  if have timedatectl; then TZ_DEFAULT=$(timedatectl show -p Timezone --value 2>/dev/null || true); fi
  if [ -z "$TZ_DEFAULT" ]; then TZ_DEFAULT="${TZ:-UTC}"; fi
fi

if [ -z "$PANEL_PORT_ARG" ]; then PANEL_PORT_ARG=$(ask "Control panel port" "$DEFAULT_PORT"); fi
case "$PANEL_PORT_ARG" in
  ''|*[!0-9]*) die "--port must be a number" ;;
esac
if [ "$PANEL_PORT_ARG" -lt 1024 ] || [ "$PANEL_PORT_ARG" -gt 65535 ]; then
  die "--port must be between 1024 and 65535 (below 1024 needs root)"
fi

if [ -z "$PANEL_HOST_ARG" ]; then
  PANEL_HOST_ARG=$(ask "Panel bind address (0.0.0.0 = your network, 127.0.0.1 = this machine only)" "0.0.0.0")
fi
case "$PANEL_HOST_ARG" in
  *[!0-9.]*) die "--listen must be an IP address" ;;
esac
if [ "$PANEL_HOST_ARG" = "0.0.0.0" ]; then
  info "The panel is reachable from your network; the token is the only password."
fi

# Something already on that port would make the finished install look broken, so
# say it now rather than after the service fails to bind.
if (exec 3<>/dev/tcp/127.0.0.1/"$PANEL_PORT_ARG") 2>/dev/null; then
  exec 3<&- 2>/dev/null || true
  warn "Port $PANEL_PORT_ARG is already in use on this machine. Pick another with --port."
  if ! confirm "Continue anyway?" n; then die "Nothing was installed."; fi
fi

if [ -z "$BOT_TOKEN_ARG" ] && [ -n "${BOT_TOKEN:-}" ]; then BOT_TOKEN_ARG=$BOT_TOKEN; fi

if $IS_ROOT; then ENV_FILE=/etc/secretary-bot.env; else ENV_FILE="$INSTALL_DIR/bot/.env"; fi

if [ -f "$ENV_FILE" ]; then
  ok "Keeping the existing settings: $ENV_FILE"
  info "Change it there (sudo \$EDITOR $ENV_FILE) and restart; nothing was overwritten."
  if [ -n "$BOT_TOKEN_ARG" ] && ! grep -q "^BOT_TOKEN=$BOT_TOKEN_ARG\$" "$ENV_FILE" 2>/dev/null; then
    if confirm "Replace the token in $ENV_FILE with the one you passed?" n; then
      if $DRY_RUN; then
        printf '  %s[dry] update BOT_TOKEN in %s%s\n' "$D" "$ENV_FILE" "$N"
      else
        TMP_ENV=$(mktemp)
        awk -v tok="$BOT_TOKEN_ARG" '/^BOT_TOKEN=/ {print "BOT_TOKEN=" tok; next} {print}' "$ENV_FILE" > "$TMP_ENV"
        cat "$TMP_ENV" > "$ENV_FILE"
        rm -f "$TMP_ENV"
        chmod 600 "$ENV_FILE"
      fi
      ok "Token updated"
    fi
  fi
else
  if [ -z "$BOT_TOKEN_ARG" ]; then
    say "  The bot token comes from @BotFather in Telegram (/newbot), and looks like 123456789:AA…"
    info "Leave it empty to paste it into the control panel later."
    BOT_TOKEN_ARG=$(ask_secret "Bot token (input is hidden):")
  fi
  if [ -n "$BOT_TOKEN_ARG" ]; then
    case "$BOT_TOKEN_ARG" in
      *:*[0-9A-Za-z_-]*) ;;
      *) warn "That does not look like a bot token (expected 123456789:AA…). Writing it anyway." ;;
    esac
  else
    warn "No token: the bot starts, waits, and lets you paste one into the control panel."
  fi

  info "Writing $ENV_FILE (mode 0600, outside the repository)"
  if $DRY_RUN; then
    printf '  %s[dry] write %s%s\n' "$D" "$ENV_FILE" "$N"
  else
    mkdir -p "$(dirname "$ENV_FILE")"
    umask 077
    {
      echo "# Written by install.sh. Keep this private: chmod 600."
      echo "# Every value can also be changed later in the control panel."
      echo
      echo "# --- Telegram ---"
      echo "BOT_TOKEN=$BOT_TOKEN_ARG"
      echo
      echo "# --- Model server (llama.cpp: :8080, Ollama: :11434/v1) ---"
      echo "LLM_BASE_URL=${LLM_BASE_URL:-http://127.0.0.1:8080}"
      echo "BOT_MODEL=${BOT_MODEL:-qwen3-1.7b}"
      echo "LLM_PROVIDER=local"
      echo
      echo "# --- Control panel ---"
      echo "PANEL_PORT=$PANEL_PORT_ARG"
      echo "PANEL_HOST=$PANEL_HOST_ARG"
      echo
      echo "# --- Behaviour ---"
      echo "BOT_TIMEZONE=$TZ_DEFAULT"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  if $IS_ROOT && [ "$RUN_USER" != "root" ]; then
    # systemd reads the file as root; the bot user needs it too when started by hand.
    run chown "root:$RUN_USER" "$ENV_FILE" 2>/dev/null || run chown root:root "$ENV_FILE" || true
    run chmod 640 "$ENV_FILE" || true
  fi
  ok "Settings written"
fi

STATE_DIR="$INSTALL_DIR/bot/state"
run mkdir -p "$STATE_DIR"
if ! $DRY_RUN; then
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  [ -f "$STATE_DIR/bot.json" ] || echo '{}' > "$STATE_DIR/bot.json"
fi

if $IS_ROOT && [ "$RUN_USER" != "root" ]; then
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    info "Creating a system user '$RUN_USER' to run the bot"
    run useradd --system --home-dir "$INSTALL_DIR" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$RUN_USER" 2>/dev/null \
      || run useradd -r -d "$INSTALL_DIR" "$RUN_USER" 2>/dev/null \
      || warn "Could not create the user; the service will run as root."
  fi
  run chown -R "$RUN_USER" "$INSTALL_DIR" 2>/dev/null || true
fi

# --- 4. the service -----------------------------------------------------------

NODE_PATH_ABS=$(command -v node || echo /usr/bin/node)
START_CMD="$NODE_PATH_ABS --import ./bot/register.mjs bot/runner.mjs"

write_unit() {
  local dest=$1 mode=$2 user_line="" wanted="multi-user.target"
  if [ "$mode" = system ] && [ "$RUN_USER" != "root" ]; then user_line="User=$RUN_USER"; fi
  if [ "$mode" = user ]; then wanted="default.target"; fi

  if $DRY_RUN; then
    printf '  %s[dry] write %s%s\n' "$D" "$dest" "$N"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  {
    echo "# Installed by install.sh — regenerate rather than hand-edit."
    echo "[Unit]"
    echo "Description=Telegram AI secretary (local model)"
    echo "Documentation=file://$INSTALL_DIR/README.md"
    echo "Wants=network-online.target"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    [ -n "$user_line" ] && echo "$user_line"
    echo "WorkingDirectory=$INSTALL_DIR"
    echo "EnvironmentFile=$ENV_FILE"
    echo "ExecStart=$NODE_PATH_ABS --import ./bot/register.mjs bot/runner.mjs"
    echo "# Restart=always is what makes /update hands-free: the updater saves state,"
    echo "# releases its lock and exits 0, and systemd starts the new code."
    echo "Restart=always"
    echo "RestartSec=5"
    echo "Nice=5"
    echo "NoNewPrivileges=true"
    echo "PrivateTmp=true"
    echo
    echo "[Install]"
    echo "WantedBy=$wanted"
  } > "$dest"
  chmod 644 "$dest"
}

if [ "$DO_SERVICE" = yes ]; then
  step "Installing the service"
  if [ "$SYSTEMD_SCOPE" = system ]; then
    write_unit "/etc/systemd/system/$SERVICE_NAME.service" system
    ok "/etc/systemd/system/$SERVICE_NAME.service"
    if $DRY_RUN; then
      printf '  %s[dry] systemctl daemon-reload && systemctl enable --now %s%s\n' "$D" "$SERVICE_NAME" "$N"
    else
      systemctl daemon-reload
      systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
      systemctl restart "$SERVICE_NAME" || warn "The service did not start: systemctl status $SERVICE_NAME"
    fi
  else
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    write_unit "$UNIT_DIR/$SERVICE_NAME.service" user
    ok "$UNIT_DIR/$SERVICE_NAME.service (systemd --user)"
    if $DRY_RUN; then
      printf '  %s[dry] systemctl --user daemon-reload && systemctl --user enable --now %s%s\n' "$D" "$SERVICE_NAME" "$N"
    else
      systemctl --user daemon-reload
      systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
      if ! systemctl --user restart "$SERVICE_NAME"; then
        warn "Could not start the user service. Starting it by hand instead to check it works:"
        DO_SERVICE=no
      fi
    fi
    if have loginctl && ! $DRY_RUN; then
      # Without this the bot stops when the last SSH session ends. It can need
      # polkit, so it gets a timeout and a closed stdin: a hung installer is worse
      # than a bot that stops at logout.
      if have timeout; then
        if timeout 5 loginctl enable-linger "$RUN_USER" </dev/null >/dev/null 2>&1; then
          info "Lingering enabled, so the bot survives logout"
        else
          info "Could not enable lingering; enable it later with: loginctl enable-linger $RUN_USER"
        fi
      fi
    fi
  fi
else
  step "No service (--no-service)"
  info "Start it with:"
  say "    cd $INSTALL_DIR && $START_CMD"
fi

# --- 5. the command -----------------------------------------------------------

# `tg-secretary` is a symlink into the install, so it always runs the code that is
# there — including after /update. Root gets /usr/local/bin; anyone else gets
# ~/.local/bin, which is on PATH on most distributions.
step "The tg-secretary command"

LINK=""          # where the command ended up, if anywhere
LINK_DIR=""
if [ "$DO_LINK" = yes ]; then
  if $IS_ROOT; then LINK_DIR=/usr/local/bin; else LINK_DIR="$HOME/.local/bin"; fi
  LINK="$LINK_DIR/tg-secretary"
  if $DRY_RUN; then
    printf '  %s[dry] ln -sf %s/bin/tg-secretary %s%s\n' "$D" "$INSTALL_DIR" "$LINK" "$N"
  else
    mkdir -p "$LINK_DIR"
    if ln -sf "$INSTALL_DIR/bin/tg-secretary" "$LINK"; then
      ok "$LINK"
    else
      warn "Could not write to $LINK_DIR; the command is $INSTALL_DIR/bin/tg-secretary"
      LINK=""
    fi
  fi

  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *)
      if [ -n "$LINK" ] || $DRY_RUN; then
        SHELL_NAME=$(basename "${SHELL:-/bin/bash}")
        RC="$HOME/.profile"
        case "$SHELL_NAME" in
          zsh)  RC="$HOME/.zshrc" ;;
          bash) RC="$HOME/.bashrc" ;;
          fish) RC="$HOME/.config/fish/config.fish" ;;
        esac
        warn "$LINK_DIR is not on your PATH, so 'tg-secretary' will not be found yet."
        info "Add it for this shell:"
        if [ "$SHELL_NAME" = fish ]; then
          say "    fish_add_path $LINK_DIR"
        else
          say "    export PATH=\"$LINK_DIR:\$PATH\""
        fi
        info "or permanently, by adding that line to $RC (not done for you)."
      fi
      ;;
  esac
else
  info "Skipped (--no-link). The command is $INSTALL_DIR/bin/tg-secretary"
fi

# --- 6. the model -------------------------------------------------------------

step "Model server"

LLAMA_CMD=""
if [ -n "$MODEL_PATH" ]; then
  [ -f "$MODEL_PATH" ] || die "No such model file: $MODEL_PATH"
  if [ -z "$LLAMA_BIN" ]; then LLAMA_BIN=$(command -v llama-server 2>/dev/null || true); fi
  if [ -z "$LLAMA_BIN" ] || [ ! -x "$LLAMA_BIN" ]; then
    warn "llama-server not found, so no model service was written. The model file is fine."
    warn "Build llama.cpp first (docs/local.md §3), then re-run with --llama /path/to/llama-server."
  else
    THREADS=${LLAMA_THREADS:-$(nproc 2>/dev/null || echo 4)}
    if [ "$THREADS" -gt 8 ]; then THREADS=8; fi
    LLAMA_CMD="$LLAMA_BIN -m $MODEL_PATH -c 4096 -np 1 -t $THREADS -b 256 -ub 256 --jinja --no-webui --host 127.0.0.1 --port 8080"

    if [ "$DO_SERVICE" = yes ] && $IS_ROOT; then
      if $DRY_RUN; then
        printf '  %s[dry] write /etc/systemd/system/%s.service%s\n' "$D" "$LLAMA_SERVICE" "$N"
      else
        cat > "/etc/systemd/system/$LLAMA_SERVICE.service" <<LLAMA
# Installed by install.sh
[Unit]
Description=llama.cpp server for the Telegram secretary
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
ExecStart=$LLAMA_CMD
Restart=always
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
LLAMA
        chmod 644 "/etc/systemd/system/$LLAMA_SERVICE.service"
      fi
      if $DRY_RUN; then
        printf '  %s[dry] systemctl enable --now %s%s\n' "$D" "$LLAMA_SERVICE" "$N"
      else
        systemctl daemon-reload
        systemctl enable --now "$LLAMA_SERVICE" \
          || warn "The model service did not start: journalctl -u $LLAMA_SERVICE -n 30"
      fi
      ok "llama-server service installed ($THREADS threads, 127.0.0.1:8080)"
    else
      info "Start the model server in another terminal:"
      say "    $LLAMA_CMD"
    fi
  fi
else
  info "No --model given, so the model server is yours to start. That is deliberate:"
  info "the right GGUF depends on this CPU, and it is a ~1 GB download."
  say ""
  say "  What this machine can do:   cd $INSTALL_DIR && npm run hw"
  say "  Then docs/local.md §3: download Qwen3-1.7B-Instruct Q4_K_M and run llama-server,"
  say "  or use Ollama and set LLM_BASE_URL=http://127.0.0.1:11434/v1 in $ENV_FILE."
fi

# --- 7. does it answer? -------------------------------------------------------

step "Checking it runs"

PANEL_URL="http://127.0.0.1:$PANEL_PORT_ARG"

# One short request, not two long ones: a panel that never answers must not look
# like a hung installer.
panel_answers() {
  if have curl; then
    curl -fsS --max-time 1 "$PANEL_URL/api/ping" >/dev/null 2>&1 && return 0
    return 1
  fi
  "$NODE_BIN" -e "
    require('node:http').get('$PANEL_URL/api/ping', { timeout: 800 }, (r) => process.exit(r.statusCode === 200 ? 0 : 1))
      .on('error', () => process.exit(1));
  " >/dev/null 2>&1
}

wait_for_panel() {
  local tries=${1:-20} i=0
  while [ "$i" -lt "$tries" ]; do
    if panel_answers; then return 0; fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

if $DRY_RUN; then
  info "Skipped in a dry run"
elif [ "$DO_SERVICE" = yes ]; then
  if wait_for_panel 30; then
    ok "The control panel answers on $PANEL_URL"
  else
    warn "The panel is not answering yet. Check the log:"
    if [ "$SYSTEMD_SCOPE" = system ]; then say "    journalctl -u $SERVICE_NAME -n 50 --no-pager"; else say "    journalctl --user -u $SERVICE_NAME -n 50 --no-pager"; fi
  fi
elif panel_answers; then
  ok "Something already answers on $PANEL_URL"
else
  info "Starting the bot for a moment to see whether it comes up"
  LOG_FILE=$(mktemp 2>/dev/null || echo /tmp/secretary-install.log)
  if ( cd "$INSTALL_DIR" && exec "$NODE_BIN" --import ./bot/register.mjs bot/runner.mjs ) > "$LOG_FILE" 2>&1 &
  then
    TEST_PID=$!
    started=false
    # Poll rather than sleep: on a fast machine this is over in under a second.
    for _ in $(seq 1 24); do
      if panel_answers; then started=true; break; fi
      sleep 0.5
    done
    if $started; then
      ok "It runs: the control panel answers on $PANEL_URL"
    else
      warn "It did not answer within 10 seconds. Its output:"
      sed -n '1,25p' "$LOG_FILE" | sed 's/^/    /'
    fi
    kill "$TEST_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$TEST_PID" 2>/dev/null || true
  else
    warn "Could not start the bot."
  fi
  rm -f "$LOG_FILE" 2>/dev/null || true
fi

# --- done ---------------------------------------------------------------------

TOKEN_FILE="$STATE_DIR/panel-token"
PANEL_TOKEN_VALUE=""
if [ -f "$TOKEN_FILE" ]; then PANEL_TOKEN_VALUE=$(cat "$TOKEN_FILE" 2>/dev/null || true); fi

LOGS_CMD="journalctl --user -u $SERVICE_NAME -f"
if [ "$SYSTEMD_SCOPE" = system ]; then LOGS_CMD="journalctl -u $SERVICE_NAME -f"; fi

printf '\n%s─────────────────────────────────────────────%s\n' "$D" "$N"
printf '%sInstalled%s\n' "$B" "$N"
printf '%s─────────────────────────────────────────────%s\n' "$D" "$N"
say "  code        $INSTALL_DIR"
say "  settings    $ENV_FILE"
say "  data        $STATE_DIR"
say "  panel       $PANEL_URL"
if [ "$PANEL_HOST_ARG" = "0.0.0.0" ]; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  if [ -n "$LAN_IP" ]; then say "  from LAN    $LAN_IP:$PANEL_PORT_ARG (http://$LAN_IP:$PANEL_PORT_ARG/?token=…)"; fi
fi
if [ -n "$PANEL_TOKEN_VALUE" ]; then
  say "  panel token $PANEL_TOKEN_VALUE"
  say "  open        $PANEL_URL/?token=$PANEL_TOKEN_VALUE"
else
  say "  panel token printed at start-up, and kept in $TOKEN_FILE"
fi
if [ "$DO_SERVICE" = yes ]; then say "  logs        $LOGS_CMD"; fi
if [ -n "$LINK" ]; then
  say "  command     tg-secretary  ($LINK)"
else
  say "  command     $INSTALL_DIR/bin/tg-secretary"
fi
say ""
say "${B}Two things to do now${N}"
say "  1. Send /claim to the bot in Telegram — it ignores everyone until it has an owner."
say "  2. Make sure the model server is running (above), then press \"Try the model\""
say "     in the dashboard."
say ""
say "${B}Later${N}"
say "  tg-secretary status        is it running, and is the model server up"
say "  tg-secretary panel         the panel URL with its token"
say "  tg-secretary logs -f       follow the log"
say "  tg-secretary update        check GitHub, then: update apply"
say "  Re-run this script with --dir $INSTALL_DIR to upgrade."
say "  tg-secretary uninstall keeps your data; add --purge to delete it."
say ""
if [ -n "$LLAMA_CMD" ] && [ "$DO_SERVICE" != yes ]; then
  say "  Model server:  $LLAMA_CMD"
  say ""
fi

if $DRY_RUN; then
  printf '%s(dry run: nothing above was actually done)%s\n\n' "$Y" "$N"
fi
