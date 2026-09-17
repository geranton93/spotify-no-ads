# Maintenance

## After a Spotify update

A Spotify update does two things: it replaces the patched bundle (Spicetify's work is gone), and it
may rename the internals this extension talks to. Handle them in this order:

```bash
# 1. re-patch Spotify and reinstall the extension
spicetify backup apply

# 2. confirm the ad subsystem is still reachable and the layers applied
tools/no-ads-check.sh          # macOS; runs the verification with a temporary loopback port
```

Expected healthy output: extension version, `extensions loaded: [..., 'no-ads.js']`, all ad managers
`False`, `native layer: settings service reachable`, `engine ad_enabled: false`, and
`ad reached player: 0 guards / 0 mutes / 0 ad messages`.

### If the check says CHECK / NOT REACHABLE

| Symptom | Meaning | Action |
|---|---|---|
| `no-ads extension: NOT LOADED` | Spicetify did not install or enable it | `spicetify config extensions no-ads.js` then `spicetify apply` |
| `native layer: NOT REACHABLE` | The client renamed or removed the ads `Settings` service / the module registry global | Layers C–E still run. Report it with `NoAds.verify()` output; layer A needs an update |
| `engine ad_enabled: true` | `putState` is no longer honoured | The engine state key moved; layer C still applies |
| `ad reached player: N guards` | An ad got through and was skipped/muted | Working as designed, but report it — a new delivery path appeared |

Nothing here requires a jump to the extension being useless: each layer fails independently, and the
downstream layers keep the outcome inaudible.

## Updating the extension itself

```bash
git pull
cp extensions/no-ads.js "$HOME/.config/spicetify/Extensions/"
spicetify apply
tools/no-ads-check.sh
```

Note `spicetify apply` restarts the client.

## Inspecting at runtime

```js
NoAds.verify()      // full state: counters, applied layers, observed values, last log lines
NoAds.reapply()     // re-run every layer on demand
NoAds.counters      // quick look
```

The extension is also self-healing: a 2 s watchdog re-disables ad managers the client re-arms, and a
30 s watchdog re-asserts the native settings and engine state.

## Rollback / uninstall

```bash
spicetify config extensions no-ads.js-
spicetify apply

# or remove the file entirely and re-apply
rm "$HOME/.config/spicetify/Extensions/no-ads.js" && spicetify backup apply
```

Uninstalling leaves no residue in the client: the same layers that neutralise the ad managers are
only active while the extension is loaded. The only persisted value it ever writes is a
`localStorage` volume checkpoint (`no-ads.restore-volume.v1`) used by the last-resort guard; it is
removed as soon as the volume is restored, and can be deleted manually at any time.

## Development notes

- The extension is a single self-contained file; there is no build step.
- `node --check extensions/no-ads.js` is the syntax gate (also run in CI).
- Keep the header comment accurate: it documents the API surface and the traps that were verified or
  rejected, which is what makes future maintenance cheap.
- Never add calls to the ad-testing services (`addPlaytime`, `insertAd`) or entitlement overrides.
