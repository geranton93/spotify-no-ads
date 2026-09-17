# How it works

Everything here was derived by inspecting the running client (module registry, service protos, live
state) — not from documentation, which does not exist for these internals. Anything below marked
*verified* was read back from the live client.

## The client's ad architecture (Spotify 1.3.x)

Ads on desktop are orchestrated by a native **ads engine** that the web layer talks to through
gRPC-web services under the `spotify.ads.esperanto.proto.*` namespace:

| Service | Role |
|---|---|
| `Settings` | Per-slot settings: ad-server endpoint, in-stream interval, display interval, expiry, enabled flag |
| `Slots` | Slot lifecycle: create, fetch, trigger, clear |
| `State` | Engine state store (`getState` / `subState` / `putState`) and device state |
| `InStream` | In-stream ad messages pushed to the client |
| `DeviceState` | `setDeviceVolume` / `getDeviceVolume` — how the client *reports* volume to the engine |
| `Ads`, `AdOpportunity`, `Targeting`, `Formats`, `Events`, `Preview`, `Testing`, `PodcastTesting` | request/inventory, targeting, event reporting, preview, ad-mocker testing |

The web layer reaches them through one object:

```js
Spicetify.Platform.AdManagers.audio.inStreamApi.adsCoreConnector
// createSlot, clearSlot, enableSlot, getSlotSettings, getSlot, fetchSlot, getAd,
// putState, putTargeting, subscribeToProductState, subscribeToInStreamAds, subscribeToSlot,
// triggerSlot, skipToNext, setRequestHeader, removeRequestHeader,
// updateAdServerEndpoint, updateAdStateEndpoint, subscribeToAdState, getAdState, logAudioVolume
```

Around it sit the managers the app toggles in response to product state:

```
AdManagers = { config, adOpportunityLogger, audio, vto, leaderboard, home, survey,
               inStreamApi, adStateReporter, embeddedAd, embeddedPlaylist }
```

Key detail: **the client creates its own slots.** `AdManagers.audio.enable()` calls
`inStreamApi.enable()`, which calls `adsCoreConnector.createSlot('preroll')` and subscribes to
in-stream ads. So if the managers are never enabled, no slot is created and no ad message arrives.

## Reaching the services in 1.3.x

The old global (`webpackChunkclient_web` / `rspackChunkclient_web`) is gone. The current build
exposes `rspackChunk` (an array with a custom `push`) and `__webpack_modules__`:

```js
const require = window.rspackChunk.push([[Symbol()], {}, (n) => n]);   // module map + loader
for (const id of Object.keys(require.m)) {
  for (const value of Object.values(require(id) || {})) {
    if (typeof value === 'function' && typeof value.SERVICE_ID === 'string') {
      // value is a service client class; instantiate with the transport:
      //   new value(Spicetify.Platform.ProductStateAPI.productStateApi.transport)
    }
  }
}
```

This is the single point of failure that killed the older extensions: with the wrong global name the
scan returns nothing and the blocker becomes a no-op **silently**.

## What actually works, and what only looks writable

| Lever | Call | Verified behaviour |
|---|---|---|
| Ad-server endpoint | `settings.updateAdServerEndpoint({slotIds, url})` | **Honoured.** With a dead loopback URL no ad inventory can be fetched — this is the primary kill. |
| In-stream break spacing | `settings.updateStreamTimeInterval({slotId, timeInterval})` | **Honoured.** Default on 1.3.0.277 is `825000` (ms). |
| Slot list | `settings.getAllSlotSettings({})` | Authoritative slot ids (includes `stream-user-actions`, which is easy to miss). |
| Engine state | `connector.putState('ad_enabled', 'false')` | **Honoured** and readable back through `getAdState()`. |
| Manager shutdown | `manager.disable()`, `leaderboard.disableLeaderboard()` | Works, but the client re-enables managers on player/product-state updates → re-assert. |
| Slot enable flag | `settings.updateSlotEnabled({slotId, enabled:false})` | **Accepted but NOT honoured** on this build: the engine re-derives `enabled:true` for an active free session. Do not rely on it. |
| Product-state override | `productStateApi.putOverridesValues({pairs:{ads:'0'}})` | **Inert**: `getValues` and the connector's `subscribeToProductState('ads')` still report `"1"`. The app's internal `adsEnabled` gate cannot be flipped this way. |
| Ad-testing service | `Testing.addPlaytime`, `insertAd` | Deliberately unused — that is ad-fraud tooling, and the layers above make it unnecessary. |

### Unit trap

`getSlotSettings` reports **milliseconds**, while the `update*` methods treat their input as
**microseconds** (write `444` → read back `444000`). To store a value you read as `V` ms, send
`V / 1000`, and verify by reading back:

```js
const toSetterUnits = (ms) => BigInt(Math.round(ms / 1000));
```

### Hazards

- **Never set `displayTimeInterval` to 0.** It is a *refresh* interval (the leaderboard uses it as
  `viewTimer = displayTimeIntervalMs`, default `20000`); zero makes the ad view refresh in a busy
  loop. The extension restores the default instead.
- **Do not zero `expiryTimeInterval`**: it makes the client re-request inventory in a loop.
- `inStreamApi.enable()` itself calls `createSlot('preroll')` — so neutralising `enable()` (layer C)
  is what keeps slots from being recreated behind you.

## The layers, and why they are ordered this way

```
A native delivery kill   →  the engine has nothing to fetch   (removes the cause)
B engine state off       →  the engine is told ads are off
C orchestration shutdown →  the app stops managing ads; enable() blocked
D interception           →  if a slot/ad message appears anyway, clear + skip
E playback guard         →  if an ad still reaches the player, end it and stay silent
```

A–C remove the cause. D and E exist because a client update can invalidate any single assumption:
the failure mode becomes "still inaudible" rather than "ads are back and nobody noticed".

The watchdog runs every 2 s: it re-disables managers the client re-armed (`enableBlocks` and
`managerReasserts` counters record this), re-asserts native settings every 30 s, and re-publishes the
engine state every 30 s.

## Things that were tried and rejected

- **Muting ads by player metadata** (the common workaround): keeps the ad slot, keeps the ducking, and
  any volume bug leaves the app silent. It is kept in layer E only as an invisible last resort, with a
  checkpoint persisted in `localStorage` so a crash cannot strand the volume at 0.
- **Faking premium / overriding product state**: inert for ads on this build, and it lies to the
  client about entitlements.
- **Blocking the ad host at the network layer**: the ad inventory is fetched through the same
  `spclient` host as normal API traffic; a hosts-file block would break more than it fixes.

## Playback quality

Ad blocking and quality are separate subsystems, and only the second one is entitlement-bound.

| Setting | Native identifier | Notes |
|---|---|---|
| Streaming quality | `audio.play_bitrate_non_metered_enumeration` | 3 = Very high (the client's own request) |
| Account cap | `audio-quality` (product state) | 0 on a free account; enforced by Spotify, not by the client |
| Download quality | `audio.sync_bitrate_enumeration` | downloads are Premium-only |
| Loudness normalisation | `audio.normalize_v2` | user setting |
| Volume level | `audio.loudness.environment` | 1 = Normal |
| Adjust quality automatically | `audio.allow_downgrade` | the one knob this extension flips: off at every launch |

All of them are readable at runtime through the client's own settings surface:

```js
Spicetify.Platform.SettingsAPI.quality.<field>.getValue()   // and .setValue(x) where writable
NoAds.quality()                                             // the combined report
```

The delivered stream is reported by the playback service (`getPlaybackInfo`): `codecName`,
`fileBitrate`, `targetBitrate`, `advisedBitrate`. `advisedBitrate` is what the *connection* would
support - on a healthy link it is an order of magnitude above `fileBitrate`, which is how you can
tell that the limit is the account and not the network.

**Why the extension does not raise the ceiling.** Requesting a higher tier means spoofing the product
state, which (a) is what this project publicly promises not to do, (b) does not survive server-side
enforcement - the file is issued per entitlement, and (c) was already measured to be inert for the
sibling case: `putOverridesValues` on the product state did not change what the client reported.
So the honest deliverable is: keep the client from asking for *less*, and make the truth visible.

## UI hygiene

Hiding an ad surface is not enough if the surface leaves a hole. Two things the extension touches:

- **Ad containers** (`.main-leaderboardComponent-container`, `.sponsor-container`, `hpto` testids, the
  top-bar upgrade button) are removed with `display: none !important`.
- **Spotify's own top-bar separator.** The clean bundle declares it as
  `.MtYp_qNgYodAxs42_Z7u { background: #fff; width: 1px; height: 25px; margin: 16px }` (Spicetify
  renames the class to `main-actionButtons-spacer` and rewrites `#fff` to `var(--spice-text)`, which
  its color scheme defines as `#ffffff` - a no-op for the colour). The same element also carries the
  action-buttons class, whose `padding-inline: 8px 0` beats `width: 1px` under
  `box-sizing: border-box`: the border box grows to 8px and the background paints the padding box, so
  the divider shows up as a solid 8x25 white block. The extension restores the declared geometry
  (`width: 1px`, no inline padding), which turns it back into a hairline. Set `display: none` on that
  selector instead if you prefer no separator at all.

- **The top bar history spacer.** Spotify ships two classes for it - `.GCNvWhUGp84HhAuncKQ1`
  (`height: calc(12px / zoom); width: calc(52px / zoom)`) for the macOS window-controls layout and
  `.bjRw1FNwvXxSrC054Bus` (`16px / 28px`) for the other layout. Spicetify's css-map renames *both* to
  `main-globalNav-historyButtonsSpacer`, so both rules match the single element and the later one
  (28px) wins on every platform. On macOS the spacer is therefore 24px too narrow and the
  back/forward buttons sit against the traffic lights. The extension re-applies the macOS variant
  (`52px / 12px`, zoom-aware). This is a Spicetify css-map collision, not a Spotify bug: in the
  unpatched bundle the two rules belong to two different class names.

- **Spicetify's custom nav links (Marketplace).** They are injected into the history cluster, where
  Spotify's own neighbours (back/forward) are plain icons, but the Marketplace app renders its entry
  with Encore's filled chip style (48x48, `rgb(36,36,36)`). The extension drops the resting fill
  (`[class*="custom-navlinks"] button:not(:hover)`) so the cluster is visually uniform, and leaves
  `:hover` intact so the button still responds. Only cosmetic: no state, routing or hit area changes.

Note that this element is a *placeholder*: Spotify only renders it while its action buttons (bell,
friends) are absent, so in a fully loaded top bar it is not in the DOM at all.
