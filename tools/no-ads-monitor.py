#!/usr/bin/env python3
"""Long-running observation: prove (or falsify) that no ad is served while music plays.

    uv run --with websocket-client python tools/no-ads-monitor.py 7200 60
    uv run --with websocket-client python tools/no-ads-monitor.py 600 60 --log /tmp/run.jsonl

Args: duration_seconds, sample_interval_seconds, --log PATH (default ./no-ads-monitor.jsonl).
One JSON object per sample is appended to the log; the console prints changes and a final verdict.

Falsifiers watched: the native impression counter moving, an item whose metadata says
is_advertisement=true, or the extension's guards/mutes/adMessages counters increasing.
"""
import json
import os
import sys
import time
import urllib.request

import websocket

PORT = int(os.environ.get("NO_ADS_PORT", "9228"))

JS = r"""
(async () => {
  const S = window.Spicetify, t = async (f) => { try { return await f(); } catch (e) { return null; } };
  const acc = S?.Platform?.AdManagers?.audio?.inStreamApi?.adsCoreConnector;
  const st = await t(async () => (await acc.getAdState())?.state || null);
  const item = await t(() => S.Player.data?.item);
  const c = (globalThis.NoAds && globalThis.NoAds.counters) || {};
  return JSON.stringify({
    t: Date.now() / 1000,
    playing: await t(() => S.Player.isPlaying()),
    progress_ms: await t(() => S.Player.getProgress()),
    track: item?.name ?? null,
    artists: (item?.artists || []).map(a => a.name).join(', ') || null,
    is_ad: String(item?.metadata?.is_advertisement) === 'true',
    volume: await t(() => S.Player.getVolume()),
    ad_enabled: st?.ad_enabled?.value ?? null,
    last_impression_epoch: st?.unix_epoch_of_last_impression?.value ?? null,
    elapsed_stream_time: st?.elapsed_stream_time?.value ?? null,
    guards: c.guards ?? null, mutes: c.mutes ?? null, adMessages: c.adMessages ?? null,
    enableBlocks: c.enableBlocks ?? null, managerReasserts: c.managerReasserts ?? null,
    lastError: (globalThis.NoAds && globalThis.NoAds.lastError) || null
  });
})()
"""


def evaluate(ws, expression, msg_id):
    ws.send(json.dumps({"id": msg_id, "method": "Runtime.evaluate",
                        "params": {"expression": expression, "returnByValue": True,
                                   "awaitPromise": True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == msg_id:
            return msg.get("result", {}).get("result", {}).get("value")


def connect():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5) as r:
        targets = json.load(r)
    pages = [t for t in targets if t.get("type") == "page" and "xpui" in t.get("url", "")]
    page = (pages or [t for t in targets if t.get("type") == "page"])[0]
    return websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 3600
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 60
    log_path = "./no-ads-monitor.jsonl"
    if "--log" in sys.argv:
        log_path = sys.argv[sys.argv.index("--log") + 1]
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)

    ws = connect()
    print(f"monitoring for {int(duration)}s every {int(interval)}s -> {log_path}")
    started = time.time()
    baseline = None
    ads_seen, progress_samples, msg_id = [], [], 0
    try:
        while time.time() - started < duration:
            msg_id += 1
            raw = evaluate(ws, JS, msg_id)
            if not raw:
                time.sleep(interval)
                continue
            s = json.loads(raw)
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(s) + "\n")
            if baseline is None:
                baseline = s
                print(f"baseline: ad_enabled={s['ad_enabled']} impressions={s['last_impression_epoch']} "
                      f"elapsed_stream_time={s['elapsed_stream_time']}")
            if s["last_impression_epoch"] != baseline["last_impression_epoch"]:
                ads_seen.append(s)
                print(f"  !! impression counter moved: {baseline['last_impression_epoch']} -> "
                      f"{s['last_impression_epoch']} ({time.strftime('%H:%M:%S')})")
            if s["is_ad"]:
                ads_seen.append(s)
                print(f"  !! current item is an advertisement: {s['track']}")
            for key in ("guards", "mutes", "adMessages"):
                if baseline.get(key) is not None and s.get(key) != baseline.get(key):
                    print(f"  !! {key}: {baseline.get(key)} -> {s.get(key)}")
            if s["progress_ms"] is not None:
                progress_samples.append((s["t"], s["progress_ms"]))
            time.sleep(interval)
    except KeyboardInterrupt:
        print("interrupted")
    finally:
        ws.close()

    advanced = 0
    if len(progress_samples) > 1:
        span = progress_samples[-1][0] - progress_samples[0][0]
        moved = progress_samples[-1][1] - progress_samples[0][1]
        advanced = moved if span > 0 else 0
        print(f"playback advanced {moved / 1000:.0f}s over {span / 1000:.0f}s of wall clock")
    print(f"samples: {len(progress_samples)} | ad evidence records: {len(ads_seen)}")
    if ads_seen:
        print("VERDICT: FAIL - ad evidence found (see the log)")
        return 2
    if advanced <= 0:
        print("VERDICT: INCONCLUSIVE - playback did not advance, so 'no ads' proves nothing")
        return 3
    print("VERDICT: PASS - impression counter frozen while playback progressed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
