# spotify-no-ads

A [Spicetify](https://spicetify.app) extension that removes ads from the **Spotify desktop client**
(free tier): no audio ads between tracks, no in-app ad surfaces. Client-side only — it blocks ad
*delivery* instead of muting playback.

```
no ads fetched → no ads scheduled → no ads played → nothing to mute
```

---

# Install (no coding needed)

**You need:** the Spotify desktop app (the one you already use) and about five minutes.
**You do not need:** any programming knowledge, a paid Spotify plan, or any other program.

Everything here is copy-and-paste. You paste **two lines** into a text window and press Enter. After
the second one, Spotify closes and reopens by itself once — that is expected. The only thing that
changes on your computer is Spotify, and an untouched backup of it is kept, so you can undo all of it
at any time.

## What is what (30 seconds)

| Thing | What it is |
|---|---|
| **Spotify desktop** | the app you already have |
| **Spicetify** | a free, widely used tool ([spicetify.app](https://spicetify.app)) that lets the Spotify desktop app load add-ons. It is what makes any customization possible. |
| **spotify-no-ads** | this add-on — one text file. It stops ads from being fetched and played, and it stops Spotify from silently lowering the sound quality. |

## Step 1 — install Spicetify

### macOS

1. Press **⌘ + Space**, type `Terminal`, press **Enter**. A small text window opens.
2. Copy this whole line, paste it into that window (⌘V) and press **Enter**:

```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
```

3. Wait until the text stops scrolling (a few seconds). Then check that it worked — paste this and
   press Enter:

```bash
spicetify --version
```

If a version number appears (for example `2.45.1`), Step 1 is done. If instead you see
`command not found: spicetify`, close the window, open a new Terminal window (⌘Space → `Terminal`)
and try this last command again.

### Windows

1. Press **Win**, type `PowerShell`, and press **Enter**.
2. Copy this whole line, paste it (Ctrl+V) and press **Enter**:

```powershell
iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex
```

3. Close PowerShell, open it again the same way (so the new command is picked up), and check:

```powershell
spicetify --version
```

A version number means Step 1 is done.

> **Important for Windows:** Spicetify does **not** work with the Spotify version from the Microsoft
> Store. In Spotify open `Settings → About` and look at the version. If it came from the Microsoft
> Store, remove it and install the normal one from
> [spotify.com](https://www.spotify.com/download/windows/), then repeat Step 1.

### Linux

Same two commands as macOS (open a Terminal, paste, press Enter): the `curl … | sh` line above, then
`spicetify --version`.

## Step 2 — install the ad-free add-on

This one line downloads the add-on, switches it on **without touching your other Spicetify
extensions**, and patches Spotify once. Spotify will close and reopen by itself — that is expected.

**macOS and Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.sh | sh
```

**Windows:**

```powershell
iwr -useb https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.ps1 | iex
```

You should see something like this at the end:

```
Finished - Spotify now starts without ads.
```

<details>
<summary><b>If the script does not work, do these three commands by hand</b></summary>

**macOS / Linux** — these three commands do exactly what the script does:

```bash
curl -fsSL -o "$HOME/.config/spicetify/Extensions/no-ads.js" \
  https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/extensions/no-ads.js
spicetify config extensions no-ads.js
spicetify apply
```

If the last command complains about a missing backup, run `spicetify backup apply` instead.

**Windows** (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/extensions/no-ads.js `
  -OutFile "$env:APPDATA\spicetify\Extensions\no-ads.js"
spicetify config extensions no-ads.js
spicetify apply
```

**Prefer clicking?** You can also save
[`extensions/no-ads.js`](https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/extensions/no-ads.js)
into the `Extensions` folder inside your Spicetify folder (on macOS/Linux:
`~/.config/spicetify/Extensions`, on Windows: `%APPDATA%\spicetify\Extensions`), then run the last two
commands by hand.

</details>

## Step 3 — check that it works

**The simple check.** Play music for a few minutes, then let an album run to its end. Where Spotify
used to cut in with an ad, it now keeps playing.

**The exact check (optional, 10 seconds).** Spotify has a hidden developer console:

1. Click once inside the Spotify window.
2. Press **Ctrl + Shift + I** (**⌘ + Option + I** on macOS). A panel appears.
3. Click the `Console` tab, type this and press **Enter**:

```js
NoAds.verify()
```

You want to see `"version": "1.3.0"` and, in the counters, `"guards": 0`, `"mutes": 0`,
`"adMessages": 0`. That means no ad has reached the player.

Press **Esc** (or click the ✕) to close the panel.

## After a Spotify update: run Step 2 again

Spotify replaces its own files with every update, and that removes the patch. When you notice ads
again, the add-on is not broken — the patch is simply gone:

1. Quit Spotify completely.
2. Run the Step 2 line again.
3. Spotify comes back ad-free.

That is the whole maintenance. Nothing else to remember.

## Troubleshooting

| What you see | What to do |
|---|---|
| Ads came back | Run the Step 2 line again (normal after a Spotify update) |
| `command not found: spicetify` | Close the window, open a new Terminal/PowerShell, try again. Still missing → repeat Step 1 |
| `spicetify` says it cannot find Spotify, or Spotify does not start | Run `spicetify restore` (this puts the original Spotify back), then run the Step 2 line again |
| Nothing works, Spotify looks broken | `spicetify restore` returns Spotify to its untouched state; you can stop there or ask on the project's Issues page |
| Windows: Spotify came from the Microsoft Store | Not supported by Spicetify — install Spotify from [spotify.com](https://www.spotify.com/download/windows/) instead |
| You want to be sure the patch is active | Run `spicetify config extensions` — `no-ads.js` should be in the list |

## How to remove everything

Two commands, and Spotify is exactly as it was before:

```bash
spicetify restore
rm "$HOME/.config/spicetify/Extensions/no-ads.js"     # macOS with an older layout:
                                                      #   "$HOME/Library/Application Support/spicetify/Extensions/no-ads.js"
```

On Windows:

```powershell
spicetify restore
Remove-Item "$env:APPDATA\spicetify\Extensions\no-ads.js"
```

To keep Spicetify and drop only this add-on:

```bash
spicetify config extensions no-ads.js-
spicetify apply
```

## Honest notes before you install

- **No account is touched.** Nothing is uploaded anywhere; no password, no payment, no subscription
  change. The add-on works on the Spotify desktop app you already have.
- **It does not give you paid features.** Ads are removed and silent quality downgrades are stopped —
  that is all. It does not raise the sound quality above what your plan allows (a free plan streams
  160 kbps; Premium streams 320 kbps), and it does not download music.
- **It may conflict with Spotify's Terms of Service.** It changes your own app on your own computer;
  you do it at your own risk.

---

# Technical documentation

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
| **An honest report** | `NoAds.quality()` prints what the setting asks for, the account's own ceiling (`audio-quality`, `high-bitrate`) and what is actually streaming (codec, target bitrate, advised bitrate) - in one command. The same report is a panel on `Ctrl/Cmd+Shift+Q` (or `NoAds.qualityPanel()`), with the current source (local file / cached copy / network stream) and a read-back switch for the auto-downgrade setting. |
| **No tier spoofing** | The ceiling is served by Spotify, not decided by the client. A free account streams 160 kbps Ogg, and the extension says so out loud. Faking a Premium product state would be entitlement circumvention, would not survive server-side enforcement, and is not what this project is. |

### Full quality for the music you own

The tier ceiling applies to *streams from Spotify*. Your own files are a different path, and the
client already ships the feature for it:

1. Turn the feature on and enable the built-in source - in the client: `Settings → Show local files`,
   or through its own API: `Spicetify.Platform.LocalFilesAPI.setIsEnabled(true)` followed by
   `mutateDefaultSource({ id: 'my_music', enabled: true })` for `~/Music` (`'downloads'` for
   `~/Downloads`; both default sources ship disabled, which is why a fresh client lists nothing).
2. Your files then appear in **Your Library → Local files** as `spotify:local:` items and play at
   their own bitrate - 320 kbps MP3 or better - with no tier cap, and they play offline because they
   are already on disk. `NoAds.quality()` says `Source: local file (own bitrate, plays offline)` when
   one is playing.
3. Buying elsewhere (Bandcamp, Qobuz, iTunes, or ripping your own CDs) is the licence-clean way to
   fill that folder. Nothing here downloads from Spotify's catalogue: that is DRM circumvention, it
   is not what this project does, and it would not work client-side - the offline keys are issued by
   the service to a paying session.

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

- Spotify desktop **1.3.x** with **Spicetify 2.4x** (verified on Spotify 1.3.0.277 with Spicetify
  2.45.x on macOS, and on a Windows runner with a real client + Spicetify install).
- The extension is plain JavaScript and is not platform-specific.
- The tooling in `tools/` is macOS-oriented (AppleScript + loopback devtools port).

## Manual install (advanced)

The one-line installers above do exactly this:

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
NoAds.quality()         // setting, the account's ceiling, what is actually streaming
NoAds.qualityPanel()    // the same on screen - also Ctrl/Cmd+Shift+Q
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
| [`INSTALL.md`](INSTALL.md) | Pointer to the install guide above (kept so links and the installers' messages keep working) |
| `install.sh` / `install.ps1` | The one-line installers themselves (macOS/Linux and Windows) |
| `tests/install-tests.sh` / `tests/install-tests.ps1` | Behaviour tests for both installers (stubbed `spicetify`, no real client touched). CI runs them on Linux **and on a real Windows runner** |
| `.github/workflows/windows-e2e.yml` | On-demand Windows end-to-end (real Spotify + real Spicetify + the published installer, then verifies the patched bundle): `gh workflow run windows-e2e.yml` |
| `docs/how-it-works.md` | The client architecture it targets, exact API surface, the traps (unit conversions, settings that look writable but are not), and how each layer was verified |
| `docs/verification.md` | Independent evidence: the ad engine's impression counter as the falsifier, the acoustic method and its calibration limits, and how the installers are verified |
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

Verified on Spotify 1.3.0.277 / Spicetify 2.45.x (macOS):

- ad-server endpoint redirected for all 15 slots; in-stream break interval persisted (read back);
- native engine state `ad_enabled=false` (read back);
- all ad managers read back as disabled; `enableBlocks` counts the client's attempts to re-arm them;
- zero ad impressions and zero ads reaching playback across instrumented listening sessions.

The quality panel was verified live (Spotify 1.3.0.277): a real `Ctrl+Shift+Q` opens and closes it,
it reports `Spotify Free (audio-quality=0, high-bitrate=0)` against `160 kbps vorbis`, and its toggle
writes through the client's API and reads the value back (`false -> true -> false`) with the
extension's error counter at zero.

The installers themselves are covered by behaviour tests on Linux and on a real Windows runner, plus
an on-demand Windows end-to-end that installs a real Spotify client and verifies the extension
reached the patched bundle — see `docs/verification.md`.

Not proven: that it will block a *future* ad format. That is why layers D/E and the monitoring tool
exist — if Spotify introduces a new delivery path, it degrades visibly instead of silently.

## License

MIT — see `LICENSE`.

## Disclaimer

This modifies your local Spotify client through Spicetify. It does not touch your account, your
subscription, or Spotify's servers, but it does change how the client behaves, and it may conflict
with Spotify's Terms of Service. Use at your own risk.
