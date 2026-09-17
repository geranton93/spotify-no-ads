#!/usr/bin/env bash
# Self-test for the no-ads extension (macOS).
#
#   tools/no-ads-check.sh
#
# Restarts Spotify with a temporary loopback-only devtools port, runs the verification probe,
# then relaunches Spotify normally (port closed) and resumes playback. Nothing else is modified:
# the port is open only for the few seconds the check takes.
set -euo pipefail

PORT="${NO_ADS_PORT:-9228}"
SPOTIFY_BIN="/Applications/Spotify.app/Contents/MacOS/Spotify"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$REPO_DIR/tools/no-ads-verify.py"

if [[ ! -x "$SPOTIFY_BIN" ]]; then
  echo "Spotify not found at $SPOTIFY_BIN"; exit 1
fi

echo "==> quitting Spotify"
osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f "$SPOTIFY_BIN" >/dev/null && sleep 1 || break; done
if pgrep -f "$SPOTIFY_BIN" >/dev/null; then echo "Spotify did not quit"; exit 1; fi

echo "==> launching with temporary devtools port $PORT"
open -a Spotify --args --remote-debugging-port="$PORT"
ready=""
for _ in $(seq 1 45); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  echo "devtools port did not open; relaunching normally"
  open -a Spotify
  exit 1
fi
sleep 12   # let Spicetify and the extension finish booting

echo "==> verification"
set +e
NO_ADS_PORT="$PORT" uv run --with websocket-client python "$VERIFY"
verdict=$?
set -e

echo "==> relaunching normally (port closed)"
osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f "$SPOTIFY_BIN" >/dev/null && sleep 1 || break; done
open -a Spotify
sleep 12
if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "WARNING: devtools port is still open"
else
  echo "devtools port closed"
fi
osascript -e 'tell application "Spotify" to play' >/dev/null 2>&1 || true

exit "$verdict"
