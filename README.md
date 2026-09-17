# spotify-no-ads

A [Spicetify](https://spicetify.app) extension that removes ads from the **Spotify desktop client**
(free tier): no audio ads between tracks, no in-app ad surfaces. Client-side only — it blocks ad
*delivery* instead of muting playback.

```
no ads fetched → no ads scheduled → no ads played → nothing to mute
```

---

## Install (no coding needed)

**[Step-by-step guide for everyone → INSTALL.md](INSTALL.md)** — two copy-paste lines, no programming
required, undoable at any time.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.ps1 | iex
```

The installer checks that Spicetify is present, downloads this extension into your Spicetify
`Extensions` folder, enables it without touching your other extensions, and applies the patch. The
manual three-command path (copy the file, `spicetify config extensions no-ads.js`, `spicetify apply`)
is under [Install](#install) below, and the guide explains both.

## Why this exists

Every Spicetify ad blocker in the wild silently died on Spotify 1.3.x. Two independent reasons:

1. **Module discovery broke.** Extensions reach Spotify's internal services by enumerating the
   client's module registry through a build-specific global. The old name
   (`webpackChunkclient_web` / `rspackChunkclient_web`) no longer exists; the 1.3.x build exposes
   `rspackChunk` + `__webpack_modules__`. An extension that looks for the old global finds nothing
   and stops working **without any error the user can see**.
2. **Manager names changed.** Existing blockers hard-required `AdManagers.billboard` and
   `AdManagers.sponsoredPlaylist`, which were removed. The code throws on the first missing key —
   *before* it reaches the audio ad managers — so in-stream audio ads keep playing.

Muting ads is a workaround, not a solution: the ad still occupies its slot, the player still ducks
for it, and any code that touches the volume can leave the app silent after a crash.

This extension attacks the ad pipeline at its source: the ad-server endpoint and the client's own
ad orchestration.

## What it does

Five layers, most upstream first. Every call is feature-detected, idempotent, and re-asserted by a
watchdog because the client re-enables its ad managers after player/product-state updates.

| # | Layer | Mechanism |
|---|---|---|
| A | **Native delivery kill** | Reaches the client's ads `Settings` service through the current module registry and points **every ad slot** at a dead loopback endpoint, so ad inventory can never be fetched. Also pushes the in-stream break interval a day out. |
| B | **Engine state** | Publishes `ad_enabled=false` into the native ads engine's state store. |
| C | **Orchestration shutdown** | Calls `disable()` on every ad manager that exposes it (`audio`, `inStreamApi`, `vto.manager`, `leaderboard`, `embeddedAd`…) and replaces their `enable()` with a no-op, so the client cannot re-arm them. |
| D | **Interception** | Wraps `createSlot` (new slots immediately get the dead endpoint) and `subscribeToInStreamAds` (any ad message → clear the slot, ask the engine to skip). |
| E | **Last resort** | If an ad ever becomes the current playback item, end it and — only while it is current — force output volume to 0 so nothing is audible. Restores from a persisted checkpoint, so a restart can never strand the player muted. |

Plus top-bar hygiene: the upgrade CTA / in-app messaging flags, CSS for ad containers, and three chrome repairs - the action-area separator that rendered as an 8x25 white block instead of a 1px hairline, the history spacer that was 24px too narrow on macOS so the back/forward buttons crowded the traffic lights, and the Marketplace nav entry whose filled chip stood out among the plain icons of the cluster it lives in (see `docs/how-it-works.md#ui-hygiene`).

## Quality (the second goal)

Removing ads is half the job; the other half is not lying about quality. What this extension does
about it, and what it will never do:

| | |
|---|---|
| **No silent downgrades** | The client ships an "adjust quality automatically" switch (native key `audio.allow_downgrade`). It is switched off at every launch, so a momentary bad-network heuristic can never drop the stream below what the account is allowed. |
| **An honest report** | `NoAds.quality()` prints what the setting asks for, what the account allows and what is actually streaming (codec, bitrate, advised bitrate) - visible without a debugger, in one command. |
| **No tier spoofing** | The ceiling is served by Spotify, not decided by the client. A free account streams 160 kbps Ogg, and the extension says so out loud. Faking a Premium product state would be entitlement circumvention, would not survive server-side enforcement, and is not what this project is. |

Measured on a free account: setting `Very high` (3), account cap `0`, network advice 1,400,000 bps,
delivered `vorbis 160000` - the ceiling is the tier, not the client and not the connection. For full
quality, play local files (they go through the same pipeline at their native bitrate) or use Premium.
On Bluetooth headphones the codec re-encode (~256 kbps AAC; macOS does not support LDAC) masks much of
the difference anyway - wired output is what reveals it.

## What it deliberately does NOT do

- **No ad-testing service calls** (`addPlaytime`, `insertAd`). That is ad-fraud tooling, and the
  layers above make it unnecessary.
- **No entitlement or product spoofing**, including the audio-quality tier. The account ceiling is
  enforced when the stream is issued, so a client-side fake would change nothing except the truth.
- **Nothing leaves your machine.** No account changes, no server-side requests beyond what the
  client already makes. The only network effect is that ad requests now fail.

## Requirements

- Spotify desktop **1.3.x** with **Spicetify 2.4x** (verified on Spotify 1.3.0.277 + Spicetify 2.45.0,
  macOS).
- The extension is plain JavaScript and is not platform-specific.
- The tooling in `tools/` is macOS-oriented (AppleScript + loopback devtools port).

## Install

```bash
# 1. copy the extension into your Spicetify Extensions directory
cp extensions/no-ads.js "$HOME/.config/spicetify/Extensions/"     # Linux
cp extensions/no-ads.js "$HOME/Library/Application Support/spicetify/Extensions/"   # macOS (older layout)

# 2. enable it (keeps existing extensions, add one)
spicetify config extensions no-ads.js

# 3. apply
spicetify apply
```

If you already use other extensions, the config keeps them:

```bash
spicetify config | grep '^extensions'     # e.g. hidePodcasts.js | no-ads.js
```

## Verify that it actually works

Being installed is not the same as working — this is the failure mode that this project exists to
fix. Three ways to check, cheapest first:

```js
// 1. in the client: DevTools console (Ctrl/Cmd+Shift+I) or via CDP
NoAds.verify()          // extension state, counters, which layers applied
```

```bash
# 2. one command, self-contained check (macOS): opens a loopback-only devtools port,
#    verifies, relaunches without the port, resumes playback
tools/no-ads-check.sh
```

```bash
# 3. long observation with evidence — samples the native ad engine over hours
uv run --with websocket-client python tools/no-ads-monitor.py 7200 60
#    the falsifier: unix_epoch_of_last_impression must stay frozen while playback progresses
```

See `docs/verification.md` for what each signal proves and what it does not.

## Documentation

| Document | Contents |
|---|---|
| [`INSTALL.md`](INSTALL.md) | **Install guide for non-programmers** — the one-line installer, the manual path, troubleshooting, uninstall |
| `install.sh` / `install.ps1` | The one-line installers themselves (macOS/Linux and Windows) |
| `docs/how-it-works.md` | The client architecture it targets, exact API surface, the traps (unit conversions, settings that look writable but are not), and how each layer was verified |
| `docs/verification.md` | Independent evidence: the ad engine's impression counter as the falsifier, the acoustic method and its calibration limits |
| `docs/maintenance.md` | What to re-check after a Spotify update, how to reinstall, how to roll back |

## Maintenance after a Spotify update

Spotify updates replace the patched bundle, and they also rename internals. Both are expected:

```bash
spicetify backup apply     # reinstall the patched bundle + this extension
tools/no-ads-check.sh      # confirm it is live again
```

If `NoAds.verify()` reports `settingsServiceReachable: false`, the client moved the ads `Settings`
service: layers C–E still hold, but the native delivery kill needs an update — open an issue with the
output of `NoAds.verify()`.

## Status and honest calibration

Verified on Spotify 1.3.0.277 / Spicetify 2.45.0 (macOS):

- ad-server endpoint redirected for all 15 slots; in-stream break interval persisted (read back);
- native engine state `ad_enabled=false` (read back);
- all ad managers read back as disabled; `enableBlocks` counts the client's attempts to re-arm them;
- zero ad impressions and zero ads reaching playback across instrumented listening sessions.

Not proven: that it will block a *future* ad format. That is why layers D/E and the monitoring tool
exist — if Spotify introduces a new delivery path, it degrades visibly instead of silently.

## License

MIT — see `LICENSE`.

## Disclaimer

This modifies your local Spotify client through Spicetify. It does not touch your account, your
subscription, or Spotify's servers, but it does change how the client behaves, and it may conflict
with Spotify's Terms of Service. Use at your own risk.
