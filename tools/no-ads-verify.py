#!/usr/bin/env python3
"""Check that the no-ads extension is live and doing its job.

Talks to the Spotify client over its devtools protocol (loopback only) and prints a compact
verdict. Requires the client to be running with a devtools port; use no-ads-check.sh to open one
temporarily and close it again afterwards.

    uv run --with websocket-client python tools/no-ads-verify.py
    NO_ADS_PORT=9333 uv run --with websocket-client python tools/no-ads-verify.py

Read-only: it never writes to the client.
"""
import json
import os
import sys
import urllib.request

import websocket

PORT = int(os.environ.get("NO_ADS_PORT", "9228"))

JS = r"""
(async () => {
  const S = window.Spicetify;
  const t = async (fn) => { try { return await fn(); } catch (e) { return null; } };
  const safe = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint') ? v.toString() : v);
  const acc = S?.Platform?.AdManagers?.audio?.inStreamApi?.adsCoreConnector;
  const out = {};
  out.noAds = await t(() => globalThis.NoAds ? JSON.parse(globalThis.NoAds.verify()) : null);
  const st = await t(async () => (await acc.getAdState())?.state || null);
  out.engine = st ? { ad_enabled: st.ad_enabled?.value ?? null,
                      last_impression_epoch: st.unix_epoch_of_last_impression?.value ?? null } : null;
  out.slot = await t(async () => {
    const s = (await acc.getSlotSettings('stream')).slotSettings[0];
    return { stream_interval: String(s.streamTimeInterval), expiry: String(s.expiryTimeInterval) };
  });
  out.adContainers = await t(() => ({
    leaderboard: document.querySelectorAll('.main-leaderboardComponent-container').length,
    sponsor: document.querySelectorAll('.sponsor-container').length,
    hpto: document.querySelectorAll('div[data-testid*="hpto"]').length,
    upgradeButton: document.querySelectorAll('.mainTopBar-UpgradeButton, .main-topBar-UpgradeButton').length }));
  out.player = await t(() => ({ playing: S.Player.isPlaying(),
                                item: S.Player.data?.item?.name ?? null,
                                is_ad: String(S.Player.data?.item?.metadata?.is_advertisement) === 'true',
                                volume: S.Player.getVolume(),
                                progress_ms: S.Player.getProgress() }));
  return safe(out);
})()
"""


def main():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5) as r:
            targets = json.load(r)
    except Exception as exc:
        print(f"cannot reach the client devtools port {PORT}: {exc}")
        print("Start Spotify with --remote-debugging-port=%d (see tools/no-ads-check.sh)." % PORT)
        return 1
    pages = [t for t in targets if t.get("type") == "page" and "xpui" in t.get("url", "")]
    page = (pages or [t for t in targets if t.get("type") == "page"])[0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": JS, "returnByValue": True,
                                       "awaitPromise": True, "userGesture": False}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                value = msg.get("result", {}).get("result", {}).get("value")
                break
    finally:
        ws.close()

    data = json.loads(value or "{}")
    no_ads = data.get("noAds")
    engine = data.get("engine") or {}
    counters = (no_ads or {}).get("counters") or {}
    managers = (no_ads or {}).get("managers") or {}

    print("no-ads extension :", (no_ads or {}).get("version") or "NOT LOADED")
    print("ad managers off  :", managers, "| enable blocks:", counters.get("enableBlocks"),
          "| manager re-asserts:", counters.get("managerReasserts"))
    print("native layer     :", "settings service reachable"
          if (no_ads or {}).get("settingsServiceReachable") else "NOT REACHABLE (native kill inactive)")
    print("stream slot      :", data.get("slot"), "(expect stream_interval=86400000, expiry=1800000)")
    print("engine ad_enabled:", engine.get("ad_enabled"),
          "| last ad impression epoch:", engine.get("last_impression_epoch"))
    print("ad containers    :", data.get("adContainers"))
    print("playback         :", data.get("player"))
    print("ad reached player:", counters.get("guards"), "guards /", counters.get("mutes"), "mutes /",
          counters.get("adMessages"), "ad messages")
    print("warnings         :", (no_ads or {}).get("lastError") or "none")

    ok = bool(no_ads) and engine.get("ad_enabled") == "false" and \
        all(v is False for v in managers.values()) and counters.get("guards", 0) == 0
    print("VERDICT          :", "PASS" if ok else "CHECK ABOVE")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
