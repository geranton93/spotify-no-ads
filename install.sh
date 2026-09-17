#!/bin/sh
# spotify-no-ads - one-line installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.sh | sh
#
# It does four things and nothing else:
#   1. checks that Spicetify is installed (and prints the exact command if it is not)
#   2. downloads extensions/no-ads.js into your Spicetify Extensions folder
#   3. enables it in the Spicetify config, keeping the extensions you already have
#   4. applies the patch, restarting Spotify once
#
# Nothing is uploaded anywhere, no account is touched, and no other extension is modified.
# Dry run (changes nothing, just explains): NOADS_DRY_RUN=1 sh install.sh

set -eu

RAW="${NOADS_SOURCE_URL:-https://raw.githubusercontent.com/geranton93/spotify-no-ads/main}"
EXT_FILE="no-ads.js"
DRY="${NOADS_DRY_RUN:-}"

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

say ""
say "spotify-no-ads installer"
say "========================"

# ---------------------------------------------------------------- 1. Spicetify
if ! command -v spicetify >/dev/null 2>&1; then
  say ""
  say "Spicetify is not installed yet. It is the free tool that lets the Spotify desktop app"
  say "load add-ons; our add-on cannot work without it."
  say ""
  say "Install Spicetify first - copy this whole line into Terminal and press Enter:"
  say ""
  say "    curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh"
  say ""
  say "Then close this window, open a new Terminal window and run the installer again."
  exit 1
fi
say "1/4  Spicetify found: $(spicetify --version 2>/dev/null | tail -1)"

# ------------------------------------------------------- 2. where files live
CONFIG_FILE="$(spicetify -c 2>/dev/null | tail -1 || true)"
if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
  CONFIG_DIR="$(dirname "$CONFIG_FILE")"
else
  CONFIG_DIR="$HOME/.config/spicetify"
  CONFIG_FILE="$CONFIG_DIR/config-xpui.ini"
fi
EXT_DIR="$CONFIG_DIR/Extensions"
say "2/4  Spicetify folder: $CONFIG_DIR"

if [ -n "$DRY" ]; then
  say "     (dry run) would download $RAW/extensions/$EXT_FILE -> $EXT_DIR/$EXT_FILE"
else
  mkdir -p "$EXT_DIR"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$RAW/extensions/$EXT_FILE" -o "$EXT_DIR/$EXT_FILE"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$EXT_DIR/$EXT_FILE" "$RAW/extensions/$EXT_FILE"
  else
    die "Neither curl nor wget is available, so the file cannot be downloaded."
  fi
  SIZE="$(wc -c < "$EXT_DIR/$EXT_FILE" | tr -d ' ')"
  say "     downloaded $EXT_FILE ($SIZE bytes)"
fi

# ------------------------------------------------------------- 3. turn it on
if [ -f "$CONFIG_FILE" ] && grep -q "^extensions.*${EXT_FILE}" "$CONFIG_FILE" 2>/dev/null; then
  say "3/4  already enabled in the Spicetify config"
elif [ -n "$DRY" ]; then
  say "3/4  (dry run) would run: spicetify config extensions $EXT_FILE"
else
  spicetify config extensions "$EXT_FILE" >/dev/null 2>&1 || true
  say "3/4  enabled: $(grep '^extensions' "$CONFIG_FILE" 2>/dev/null | head -1 || echo "$EXT_FILE")"
fi

# ----------------------------------------------------------------- 4. apply
if [ -n "$DRY" ]; then
  say "4/4  (dry run) would run: spicetify apply"
  say ""
  say "Dry run finished - nothing on this computer was changed."
  exit 0
fi

OSTYPE_KIND="$(uname -s)"
quit_spotify() {
  [ -n "${NOADS_NO_APP_CONTROL:-}" ] && return 0
  case "$OSTYPE_KIND" in
    Darwin) osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1 || true ;;
    *)      pkill -u "$(id -u)" -x spotify >/dev/null 2>&1 || true ;;
  esac
  i=0
  while [ "$i" -lt 25 ]; do
    pgrep -x Spotify >/dev/null 2>&1 || pgrep -x spotify >/dev/null 2>&1 || break
    sleep 1
    i=$((i + 1))
  done
}
start_spotify() {
  [ -n "${NOADS_NO_APP_CONTROL:-}" ] && return 0
  [ -n "${NOADS_SKIP_LAUNCH:-}" ] && return 0
  case "$OSTYPE_KIND" in
    Darwin) open -a Spotify >/dev/null 2>&1 || true ;;
    *)      if command -v spotify >/dev/null 2>&1; then
              nohup spotify >/dev/null 2>&1 &
            fi ;;
  esac
}

say "4/4  patching Spotify (it closes and reopens once; an untouched backup copy is kept) ..."

# "spicetify backup apply" is the right command when Spotify was just updated (the patch is gone and
# the client is unpatched again), but running it on an already-patched client would refresh the
# backup with patched files. So only fall back to it when no backup exists yet.
backup_exists() {
  [ -d "$CONFIG_DIR/Backup" ] && return 0
  [ -d "$HOME/.local/state/spicetify/Backup" ] && return 0
  return 1
}

quit_spotify
if spicetify apply >/tmp/no-ads-apply.log 2>&1; then
  say "     done"
elif ! backup_exists && spicetify backup apply >/tmp/no-ads-apply.log 2>&1; then
  say "     done (first run: backup created, then patched)"
else
  say "     something went wrong. The last lines of the log:"
  tail -5 /tmp/no-ads-apply.log | sed 's/^/       /'
  die "Run 'spicetify backup apply' by hand to see the full error, or read INSTALL.md."
fi
start_spotify

say ""
say "Finished - Spotify now starts without ads."
say ""
say "Check it any time: in Spotify press Ctrl+Shift+I (Cmd+Option+I on macOS), type  NoAds.verify()"
say "Ads come back after a Spotify update: just run this installer again."
say "Remove everything:  spicetify restore   and delete  $EXT_DIR/$EXT_FILE"
say ""
