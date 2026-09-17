# Verification

"Installed" is not "working". This project exists because an ad blocker can stop blocking without
telling anyone, so the checks below are part of the deliverable.

## The falsifier

The native ads engine stamps `unix_epoch_of_last_impression` every time an ad impression happens.
That gives an independent, cheap signal that does not depend on the extension's own counters:

```
frozen unix_epoch_of_last_impression  +  advancing playback  =  no ads were served
```

Read it with:

```js
const acc = Spicetify.Platform.AdManagers.audio.inStreamApi.adsCoreConnector;
(await acc.getAdState()).state.unix_epoch_of_last_impression.value
```

Pair it with a real playback check — `Player.isPlaying()` alone is not enough, because a stalled
player also produces no ads. Use `Player.getProgress()` and confirm it advances.

## Three levels of checking

| Level | Tool | What it proves |
|---|---|---|
| State | `NoAds.verify()` (in the client) | Which layers applied, counters, last error, whether the ads `Settings` service is reachable |
| Mechanism | `tools/no-ads-verify.py` | Independent read-back: native slot values, engine state, manager flags, ad containers in the DOM |
| Behaviour | `tools/no-ads-monitor.py` | Over hours: the impression counter stays frozen while playback progresses, and none of `guards` / `mutes` / `adMessages` increase |

`tools/no-ads-check.sh` wraps level 2 in one command on macOS: it quits the client, relaunches it
with a **loopback-only** devtools port, runs the verification, relaunches normally (closing the port)
and resumes playback.

### Reading the counters

| Counter | Meaning |
|---|---|
| `nativeApplies`, `stateApplies` | Native settings / engine state re-asserted (start + watchdog) |
| `managerDisables`, `managerReasserts` | The client re-arms ad managers and the extension puts them back |
| `enableBlocks` | The client itself called `enable()` on an ad manager; blocked |
| `adMessages`, `guards`, `mutes` | **The falsifiers.** Any non-zero value means an ad got as far as the player |

In healthy operation `managerReasserts` and `enableBlocks` may be non-zero (the client tries; the
extension wins). `guards`/`mutes`/`adMessages` should stay at 0.

## Independent read paths

Every claim in this repository was checked through at least two paths, because a single client object
can cache stale values:

- slot settings read via the connector (`connector.getSlotSettings`) **and** via a freshly
  constructed `Settings` client;
- volume read as `Player.getVolume()` (0..1) **and** `PlaybackService.getVolume()` **and**
  `getRawVolume()` (0..65535) **and** the OS output volume;
- ads state via `getAdState()` **and** via the extension's own counters.

## The acoustic method, and its limits

To answer "is anything actually audible", the maintainers also measured the output with a room
microphone (250 ms RMS windows, search for the largest sustained step). Two things that method taught:

1. **It needs a control run.** Music dynamics alone produce sustained 2–3 dB shifts; a launch run
   showing a 4 dB "step" is not evidence of anything without a mid-session control recording of the
   same material.
2. **It cannot resolve the client's startup transient.** Across instrumented launches the largest
   detected step appeared anywhere between ~9 s and ~18 s after process start, at 4–7 dB, while the
   control floor was 2.9 dB — enough to say "something happens shortly after launch", not enough to
   name a second.

What that investigation *did* establish (all by A/B, not by inference): the post-launch level step is
not the app volume slider, not the raw device volume, not the OS output volume, not any JS volume or
`duck` call, not the "Normalize volume" preference, and not this extension. It happens inside the
native audio pipeline during the client's own startup sequence, and it stabilises within the first
half-minute. For millisecond-accurate measurement, capture the client's digital output through a
loopback device instead of a microphone.

## Signals that are NOT proof

- The extension file being present in the bundle folder.
- `index.html` containing the loader tag.
- The extension logging "no-ads active".
- `Player.isPlaying()` on its own.
- A single quiet listening session: ads are scheduled over hours, so a short sample proves little.
