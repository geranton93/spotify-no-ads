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
