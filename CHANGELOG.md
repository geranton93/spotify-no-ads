# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/),
versioning: [SemVer](https://semver.org/).

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
