#!/bin/sh
# Behaviour tests for install.sh - hermetic: a stub "spicetify" is put on PATH, the extension is
# served from a local file:// URL, and even "osascript"/"open" are stubbed, so nothing real (Spotify,
# your Spicetify install, the network) is touched. Run from anywhere:  sh tests/install-tests.sh
#
# Covered: missing Spicetify, happy path, second run (already enabled), apply failing with and without
# a backup present, and the dry run.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$ROOT/install.sh"
FAILURES=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1"; fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

BIN="$SANDBOX/bin"
CFGDIR="$SANDBOX/cfg"
FAKE_REPO="$SANDBOX/repo/extensions"
mkdir -p "$BIN" "$CFGDIR" "$FAKE_REPO" "$SANDBOX/home"
printf '// fake extension used by the tests\n' > "$FAKE_REPO/no-ads.js"

# --- stub spicetify: records every call, emulates what the installer relies on --------------------
cat > "$BIN/spicetify" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$SPICETIFY_CALLS"
case "$1" in
  --version) echo "stub 9.9.9"; exit 0 ;;
  -c)        echo "$SPICETIFY_CONFIG"; exit 0 ;;
  config)
    if [ "${2:-}" = "extensions" ] && [ -n "${3:-}" ]; then
      cur="$(grep '^extensions' "$SPICETIFY_CONFIG" | sed 's/^extensions *= *//')"
      case "$cur" in
        *"$3"*) : ;;
        *) sed -i.bak "s@^extensions *=.*@extensions = ${cur}|$3@" "$SPICETIFY_CONFIG" ;;
      esac
    fi
    exit 0 ;;
  apply)  [ -f "$SANDBOX/apply_fail" ] && exit 1; exit 0 ;;
  backup) [ -f "$SANDBOX/backup_fail" ] && exit 1; exit 0 ;;
esac
exit 0
STUB
chmod +x "$BIN/spicetify"

# --- stubs for the desktop app: the tests must never quit or launch a real Spotify ----------------
for app in osascript open; do
  cat > "$BIN/$app" <<APP
#!/bin/sh
printf '%s\n' "$app \$*" >> "\$SPICETIFY_CALLS"
exit 0
APP
  chmod +x "$BIN/$app"
done

# pgrep reports "nothing running" (so the wait loop returns immediately) and pkill is recorded only
cat > "$BIN/pgrep" <<'PG'
#!/bin/sh
exit 1
PG
cat > "$BIN/pkill" <<'PK'
#!/bin/sh
printf 'pkill %s\n' "$*" >> "$SPICETIFY_CALLS"
exit 0
PK
chmod +x "$BIN/pgrep" "$BIN/pkill"

reset_state() {
  rm -rf "$CFGDIR/Extensions" "$CFGDIR/Backup" \
         "$SANDBOX/apply_fail" "$SANDBOX/backup_fail"
  printf 'extensions            = other.js\n' > "$CFGDIR/config-xpui.ini"
  : > "$SANDBOX/calls.log"
}
clear_calls() { : > "$SANDBOX/calls.log"; }

run_installer() { # EXTRA_ENV carries extra variables (e.g. NOADS_DRY_RUN=1)
  env -i PATH="$BIN:/usr/bin:/bin:/usr/local/bin" HOME="$SANDBOX/home" \
      SPICETIFY_CALLS="$SANDBOX/calls.log" SPICETIFY_CONFIG="$CFGDIR/config-xpui.ini" \
      SANDBOX="$SANDBOX" NOADS_SKIP_LAUNCH=1 NOADS_SOURCE_URL="file://$SANDBOX/repo" \
      ${EXTRA_ENV:-} sh "$INSTALLER"
}

printf 'install.sh behaviour tests\n'
printf '==========================\n'

# 1. Spicetify missing ------------------------------------------------------
reset_state
OUT="$(env -i PATH="/usr/bin:/bin" HOME="$SANDBOX/home" sh "$INSTALLER" 2>&1)"
CODE=$?
check "missing Spicetify: exits non-zero"           "$([ "$CODE" -ne 0 ] && echo 0 || echo 1)"
check "missing Spicetify: prints the install command" "$(printf '%s' "$OUT" | grep -q 'spicetify/cli/main/install.sh' && echo 0 || echo 1)"
check "missing Spicetify: installs nothing"         "$([ ! -d "$CFGDIR/Extensions" ] && echo 0 || echo 1)"

# 2. Happy path -------------------------------------------------------------
reset_state
OUT="$(run_installer 2>&1)"; CODE=$?
check "happy path: exits 0"                         "$([ "$CODE" -eq 0 ] && echo 0 || echo 1)"
check "happy path: extension file landed"           "$([ -f "$CFGDIR/Extensions/no-ads.js" ] && echo 0 || echo 1)"
check "happy path: extension enabled in the config" "$(grep -q 'no-ads.js' "$CFGDIR/config-xpui.ini" && echo 0 || echo 1)"
check "happy path: existing extension preserved"    "$(grep -q 'other.js' "$CFGDIR/config-xpui.ini" && echo 0 || echo 1)"
check "happy path: 'config extensions' was called"  "$(grep -q '^config extensions no-ads.js$' "$SANDBOX/calls.log" && echo 0 || echo 1)"
check "happy path: 'apply' was called"              "$(grep -q '^apply$' "$SANDBOX/calls.log" && echo 0 || echo 1)"
check "happy path: quit Spotify was attempted"      "$(grep -qE '^(osascript |pkill )' "$SANDBOX/calls.log" && echo 0 || echo 1)"
check "happy path: no real app was launched"        "$(grep -q '^open ' "$SANDBOX/calls.log" && echo 1 || echo 0)"
check "happy path: tells the user it finished"      "$(printf '%s' "$OUT" | grep -q 'Finished' && echo 0 || echo 1)"

# 3. Second run: already enabled, nothing duplicated ------------------------
reset_state
run_installer >/dev/null 2>&1
clear_calls
OUT="$(run_installer 2>&1)"; CODE=$?
check "second run: exits 0"                         "$([ "$CODE" -eq 0 ] && echo 0 || echo 1)"
check "second run: does not enable it again"        "$(grep -q '^config extensions' "$SANDBOX/calls.log" && echo 1 || echo 0)"
check "second run: says it is already enabled"      "$(printf '%s' "$OUT" | grep -q 'already enabled' && echo 0 || echo 1)"
check "second run: still applies the patch"         "$(grep -q '^apply$' "$SANDBOX/calls.log" && echo 0 || echo 1)"

# 4. apply fails and no backup exists -> falls back to 'backup apply' -------
reset_state
: > "$SANDBOX/apply_fail"
OUT="$(run_installer 2>&1)"; CODE=$?
check "apply fails, no backup: falls back to backup apply" "$(grep -q '^backup apply$' "$SANDBOX/calls.log" && echo 0 || echo 1)"
check "apply fails, no backup: exits 0 after fallback"     "$([ "$CODE" -eq 0 ] && echo 0 || echo 1)"

# 5. apply fails and a backup exists -> never refresh the backup, report it -
reset_state
mkdir -p "$CFGDIR/Backup"
: > "$SANDBOX/apply_fail"
OUT="$(run_installer 2>&1)"; CODE=$?
check "apply fails, backup present: no backup apply" "$(grep -q '^backup apply$' "$SANDBOX/calls.log" && echo 1 || echo 0)"
check "apply fails, backup present: exits non-zero"  "$([ "$CODE" -ne 0 ] && echo 0 || echo 1)"
check "apply fails, backup present: points at the guide" "$(printf '%s' "$OUT" | grep -q '#troubleshooting' && echo 0 || echo 1)"

# 6. Dry run changes nothing ------------------------------------------------
reset_state
OUT="$(EXTRA_ENV="NOADS_DRY_RUN=1" run_installer 2>&1)"; CODE=$?
check "dry run: exits 0"                            "$([ "$CODE" -eq 0 ] && echo 0 || echo 1)"
check "dry run: downloads nothing"                  "$([ ! -d "$CFGDIR/Extensions" ] && echo 0 || echo 1)"
# reading is fine (it asks spicetify where its config lives); changing anything is not
check "dry run: runs no mutating spicetify command" "$(grep -qE '^(config|apply|backup)' "$SANDBOX/calls.log" && echo 1 || echo 0)"
check "dry run: says nothing was changed"           "$(printf '%s' "$OUT" | grep -q 'nothing on this computer was changed' && echo 0 || echo 1)"

printf '\n%s\n' "$([ "$FAILURES" -eq 0 ] && echo 'all tests passed' || echo "$FAILURES test(s) FAILED")"
[ "$FAILURES" -eq 0 ]
