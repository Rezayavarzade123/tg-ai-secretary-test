#!/usr/bin/env bash
#
# uninstall.sh — remove the service, and optionally the data.
#
# Default: stop and remove the systemd unit(s). Your code, settings and messages
# stay where they are, so you can start it again by hand or re-run install.sh.
# --purge: also delete the install directory and the settings file, after showing
# you exactly what will go.
#
set -euo pipefail
IFS=$'\n\t'

SERVICE_NAME="secretary"
LLAMA_SERVICE="llama-server"
PURGE=false
ASSUME_YES=false
DRY_RUN=false
INSTALL_DIR=""

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

run() {
  if $DRY_RUN; then
    printf '  %s[dry]%s' "$D" "$N"; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

usage() {
  cat <<USAGE
${B}Telegram AI secretary — uninstaller${N}

Usage: bash uninstall.sh [--dir PATH] [--purge] [--yes] [--dry-run]

  --dir PATH    the install directory (same one you gave install.sh)
  --purge       also delete the code, the settings file and your messages
  --yes, -y     never ask
  --dry-run     show what would be removed
  --help, -h    this text

Without --purge this only stops and removes the service: your data stays.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     [ -n "${2:-}" ] || die "--dir needs a value"; INSTALL_DIR=$2; shift 2 ;;
    --purge)   PURGE=true; shift ;;
    --yes|-y)  ASSUME_YES=true; shift ;;
    --dry-run) DRY_RUN=true; ASSUME_YES=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *)         die "Unknown option: $1 (see --help)" ;;
  esac
done

IS_ROOT=false
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=true; fi

if [ -z "$INSTALL_DIR" ]; then
  if $IS_ROOT && [ -d /opt/tg-ai-secretary ]; then
    INSTALL_DIR=/opt/tg-ai-secretary
  elif [ -d "$HOME/tg-ai-secretary" ]; then
    INSTALL_DIR=$HOME/tg-ai-secretary
  else
    die "Could not guess the install directory. Pass --dir (the one you gave install.sh)."
  fi
fi
INSTALL_DIR=${INSTALL_DIR%/}

ENV_FILE=/etc/secretary-bot.env
if [ ! -f "$ENV_FILE" ]; then ENV_FILE="$INSTALL_DIR/bot/.env"; fi

confirm() {
  local question=$1 default=${2:-n} answer
  if $ASSUME_YES; then return 0; fi
  if [ -r /dev/tty ]; then
    printf '  %s%s%s %s[%s]%s ' "$B" "$question" "$N" "$D" "$default" "$N" >&2
    IFS= read -r answer < /dev/tty || answer=''
  else
    answer=$default
  fi
  case "${answer:-$default}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

step "The service"

removed=0
for scope in system user; do
  if [ "$scope" = system ] && ! $IS_ROOT; then continue; fi
  if $DRY_RUN; then
    info "(dry run) would stop and disable $SERVICE_NAME ($scope)"
  fi
  # `systemctl` on a machine without a running systemd prints nothing useful;
  # failures here are expected and not fatal.
  if [ "$scope" = system ]; then
    if ! $DRY_RUN && have systemctl; then
      systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
      systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    UNIT="/etc/systemd/system/$SERVICE_NAME.service"
    LLAMA_UNIT="/etc/systemd/system/$LLAMA_SERVICE.service"
  else
    if ! $DRY_RUN && have systemctl; then
      systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
      systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"
    LLAMA_UNIT=""
  fi

  if [ -f "$UNIT" ]; then
    # Only touch units this project wrote: a hand-made service with the same
    # name is not ours to delete.
    if grep -q "Installed by install.sh" "$UNIT" 2>/dev/null; then
      run rm -f "$UNIT"
      ok "removed $UNIT"
      removed=1
    else
      warn "$UNIT was not written by install.sh; leaving it alone"
    fi
  fi
  if [ -n "$LLAMA_UNIT" ] && [ -f "$LLAMA_UNIT" ] && grep -q "Installed by install.sh" "$LLAMA_UNIT" 2>/dev/null; then
    if ! $DRY_RUN && have systemctl; then
      systemctl stop "$LLAMA_SERVICE" >/dev/null 2>&1 || true
      systemctl disable "$LLAMA_SERVICE" >/dev/null 2>&1 || true
    fi
    run rm -f "$LLAMA_UNIT"
    ok "removed $LLAMA_UNIT (the model server)"
    removed=1
  fi
done

if ! $DRY_RUN && have systemctl; then
  if $IS_ROOT; then systemctl daemon-reload >/dev/null 2>&1 || true; else systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
fi
if [ "$removed" -eq 0 ]; then info "No service installed by this project was found."; fi

if ! $PURGE; then
  step "Done — your data is still there"
  say "  code      $INSTALL_DIR"
  say "  settings  $ENV_FILE"
  say "  messages  $INSTALL_DIR/bot/state/"
  say ""
  say "  To remove everything as well: bash uninstall.sh --dir $INSTALL_DIR --purge"
  say ""
  exit 0
fi

step "Removing everything (--purge)"

if [ ! -d "$INSTALL_DIR" ] && [ ! -f "$ENV_FILE" ]; then
  ok "Nothing left to remove"
  exit 0
fi

SIZE=$(du -sh "$INSTALL_DIR" 2>/dev/null | cut -f1 || true)
say "  This deletes:"
say "    $INSTALL_DIR  ${SIZE:+($SIZE)}   — code, settings and every message the bot stored"
if [ -f "$ENV_FILE" ] && [ "$ENV_FILE" != "$INSTALL_DIR/bot/.env" ]; then
  say "    $ENV_FILE    — the settings file with your bot token"
fi
say ""
if ! confirm "Delete all of it? This cannot be undone." n; then
  die "Nothing deleted."
fi

if ! $DRY_RUN; then
  # The state lock keeps a running bot from being copied mid-write; make sure
  # nothing is still running before the directory goes.
  if have pgrep && pgrep -f "$INSTALL_DIR/bot/runner.mjs" >/dev/null 2>&1; then
    warn "A bot is still running from $INSTALL_DIR; stopping it first"
    pkill -f "$INSTALL_DIR/bot/runner.mjs" >/dev/null 2>&1 || true
    sleep 2
  fi
fi

run rm -rf "$INSTALL_DIR"
if [ "$ENV_FILE" != "$INSTALL_DIR/bot/.env" ]; then run rm -f "$ENV_FILE"; fi

ok "Removed"
say ""
say "  Left behind, deliberately:"
say "    - the 'secretary' system user, if install.sh created one"
say "      (sudo userdel secretary)"
say "    - the model files and llama.cpp, wherever you put them"
say "    - the bot itself in Telegram: /deletebot in @BotFather"
say ""
