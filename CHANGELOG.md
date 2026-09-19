# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/),
versioning: [SemVer](https://semver.org/).

## [1.4.0] - 2026-09-19

### Added

- **Quality panel** - the numbers `NoAds.quality()` prints, on screen: `Ctrl/Cmd+Shift+Q`, or
  `NoAds.qualityPanel()` from the DevTools console. It puts the *setting* next to the **account's own
  ceiling pairs** (`audio-quality`, `high-bitrate`, read from the same product-state service the
  client reads) and next to what is actually streaming (`codecName`, `fileBitrate`, `targetBitrate`,
  `advisedBitrate`, `strategy`), plus where the sound comes from right now - `local file`, `cached
  copy of the stream` or `network stream`.
- The panel carries the one user-facing quality switch, wired to the client's own API and read back:
  "stop the client lowering quality on its own" (native key `audio.allow_downgrade`).

### Notes

- Measured on a free account while writing this: `Spotify Free (audio-quality=0, high-bitrate=0)`
  caps the stream at `160 kbps vorbis` while the connection advises `1400 kbps`. Those pairs arrive
  with the session, which is the structural reason the cap cannot be raised from the web layer: the
  call that tries (`putOverridesValues`) resolves without error and changes nothing - read-back and
  stream identical at +1.5 s and +8 s. The panel states that instead of pretending.
- Two Spicetify entry points were tried and dropped as unusable in this combination (Spotify
  1.3.0.277 + Spicetify 2.45.1), each measured: `Spicetify.Menu.Item.register()` funnels into
  `ContextMenuV2.registerItem` with an element the constructor builds through a `jsx` helper this
  build does not expose (`Cannot read properties of undefined (reading 'jsx')`), and
  `Spicetify.Keyboard.registerShortcut()` accepts a binding that no real keystroke reaches. The
  shortcut is therefore a plain DOM listener, verified with a real `Ctrl+Shift+Q` sent through the
  devtools Input domain.

## [1.3.0] - 2026-09-17

### Added

- **Quality is now a first-class goal, alongside ad removal.**
  - `NoAds.quality()` (and `NoAds.verify().quality`) reports the truth about the stream: the quality
    setting, the account's cap, the auto-downgrade switch, the delivered codec and bitrate, and the
    bitrate the connection would support.
  - The client's own "adjust quality automatically" switch (native key `audio.allow_downgrade`) is
    turned off at every launch, so the stream is never silently dropped below the tier. Applied once,
    read back, logged; it is a user-facing setting, not an entitlement change.
- Documented the boundary explicitly: the account ceiling is served by Spotify, so a free account
  stays at 160 kbps Ogg and the extension reports that instead of spoofing a product state. Measured
  on a free account: setting `3` (Very high), account cap `0`, network advice 1,400,000, delivered
  `vorbis 160000`.

## [1.2.3] - 2026-09-17

### Changed

- **Marketplace nav entry no longer looks like a stray chip.** Spicetify renders custom nav links
  inside the top bar's history cluster, where every neighbour is a plain icon, while the Marketplace
  app draws its entry as a filled 48x48 chip (`background: rgb(36,36,36)`). The resting fill is
  removed so the cluster reads as one group; the hit area and the `:hover` feedback are untouched
  (verified with a dispatched mouse move: resting `rgba(0,0,0,0)`, hover `rgb(42,42,42)`). The
  selector is class-based (`[class*="custom-navlinks"] button`), not label-based, because the label is
  localised.

### Notes

- Grouping the two nav chips together instead (moving the Marketplace entry next to Home) was also
  tested: clicks keep working and the search container stays centred, but it keeps the filled chip the
  user flagged, so the quieter fix was chosen.

## [1.2.2] - 2026-09-17

### Fixed

- **Back/forward buttons crowding the macOS window controls.** Spotify ships two classes for the top
  bar history spacer: one for the macOS window-controls layout (`width: calc(52px / zoom)`,
  `height: calc(12px / zoom)`) and one for the other layout (28px / 16px). Spicetify's css-map maps
  both obfuscated names onto the single class `main-globalNav-historyButtonsSpacer`, so the later
  rule (28px) wins everywhere and on macOS the spacer is 24px too narrow - the history buttons touch
  the traffic lights. The UI-hygiene CSS restores the macOS variant: measured at a 1512px viewport,
  the chevrons move from x=81 to x=105.

## [1.2.1] - 2026-09-17

### Fixed

- **Top bar white block.** Spotify's own separator between the action area and the profile avatar
  (`.main-actionButtons-spacer`) is declared as a 1px line, but the element also carries the
  action-buttons class whose `padding-inline: 8px 0` widens the border box to 8px under
  `box-sizing: border-box` - and the background paints the padding box, so the divider rendered as a
  solid 8x25 white block instead of a hairline. The UI-hygiene CSS now restores the declared 1px
  geometry. Applies only to that element; to drop the separator entirely, set `display: none` on it
  (the rule carries a comment saying so).
## [1.2.0] - 2026-09-17

First public release of the extension as maintained in this repository. Behavioural summary of the
development steps that led here:

- **Layer A** — native ad-server kill: discovered the ads `Settings` service through the 1.3.x module
  registry (`rspackChunk` / `__webpack_modules__`), redirects the endpoint for every ad slot the
  engine reports, and pushes the in-stream break interval a day out. Interval unit trap handled
  (setters take microseconds, getters return milliseconds).
- **Layer B** — `ad_enabled=false` published into the native ads engine state store, read back to
  confirm it sticks.
- **Layer C** — disables every ad manager that exposes `disable()`, and neutralises `enable()` so the
  client cannot re-arm them between watchdogs.
- **Layer D** — `createSlot` / `subscribeToInStreamAds` interception.
- **Layer E** — last-resort skip + mute with a persisted volume checkpoint.
- UI hygiene: `hideUpgradeCTA` / `enableInAppMessaging` flags and ad-container CSS.
- Watchdog re-asserts native settings and engine state; `enableBlocks` counter records the client's
  own attempts to re-enable ads.

Verified against Spotify 1.3.0.277 + Spicetify 2.45.0 on macOS: 15 slots redirected, engine state
`false`, all managers disabled, zero ad impressions across instrumented listening sessions.

### Known limitations at release

- `updateSlotEnabled({enabled:false})` is accepted by the engine but not honoured on this build (it
  re-derives `enabled=true`); the extension does not rely on it.
- The product-state override (`ads="0"`) is inert on this build — measured, not assumed.
- A future Spotify build could introduce an ad path that no current layer covers; layers D/E degrade
  that into "inaudible" rather than "silent failure".
