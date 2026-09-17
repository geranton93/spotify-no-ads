# Install guide — for people who do not write code

You need: **Spotify desktop** (the app you already use) and about **5 minutes**.
You do **not** need: any programming knowledge, a paid Spotify plan, or any other program.

Everything below is copy-and-paste. You will paste **two lines** into a text window and press Enter.
The only thing that changes on your computer is Spotify itself (the ad-free add-on is one small file,
and an untouched backup of Spotify is kept so you can undo everything at any time).

---

## What is what (30 seconds)

| Thing | What it is |
|---|---|
| **Spotify desktop** | the app you already have |
| **Spicetify** | a free, widely used tool (spicetify.app) that lets the Spotify desktop app load add-ons. It is what makes any customization possible. |
| **spotify-no-ads** | our add-on — one text file. It stops ads from being fetched and played, and it stops Spotify from silently lowering the sound quality. |

---

## Step 1 — install Spicetify

### macOS

1. Press **⌘ + Space**, type `Terminal`, press **Enter**. A small text window opens.
2. Copy this whole line, paste it into that window (⌘V) and press **Enter**:

```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
```

3. Wait until the text stops scrolling (a few seconds). Then check it worked — paste this and press Enter:

```bash
spicetify --version
```

If a version number appears (for example `2.45.1`), Step 1 is done.
If instead you see `command not found: spicetify`, just close the window, open a new Terminal window
(⌘Space → `Terminal`) and try the second command again.

### Windows

1. Press **Win**, type `PowerShell`, and press **Enter**.
2. Copy this whole line, paste it (Ctrl+V) and press **Enter**:

```powershell
iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex
```

3. Close PowerShell, open it again the same way (this makes sure the new command is picked up), and check:

```powershell
spicetify --version
```

A version number means Step 1 is done.

> **Important for Windows:** Spicetify does **not** work with the Spotify version from the Microsoft
> Store. In Spotify open `Settings → About` and check. If it came from the Microsoft Store, remove it
> and install the normal one from spotify.com, then repeat Step 1.

### Linux

Same two commands as macOS (Terminal → paste → Enter):

```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
spicetify --version
```

---

## Step 2 — install the ad-free add-on

This line downloads our add-on, switches it on, and patches Spotify once. Spotify will close and
reopen by itself — that is expected.

### macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.sh | sh
```

### Windows

```powershell
iwr -useb https://raw.githubusercontent.com/geranton93/spotify-no-ads/main/install.ps1 | iex
```

You should see something like this at the end:

```
Finished - Spotify now starts without ads.
```

<details>
<summary><b>If the script does not work, do these three commands by hand</b></summary>

**macOS / Linux** — the three commands do exactly what the script does:

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
commands.

</details>

---

## Step 3 — check that it works

**The simple check.** Play music for a few minutes, then let an album run. Where Spotify used to cut
in with a voice ad, it now keeps playing. Ads do not come back.

**The exact check (optional, 10 seconds).** Spotify has a hidden developer console:

1. Click once inside the Spotify window.
2. Press **Ctrl + Shift + I** (**⌘ + Option + I** on macOS). A panel appears.
3. Click the `Console` tab, type this and press Enter:

```js
NoAds.verify()
```

You want to see `"version": "1.3.0"` and, in the counters, `"guards": 0`, `"mutes": 0`,
`"adMessages": 0`. That means no ad has reached the player.

Press **Esc** (or click the ✕) to close the panel.

---

## After a Spotify update: run Step 2 again

Spotify replaces its files with every update, and that removes the patch. When you notice ads again
(the add-on is not broken — the patch was simply gone):

1. Quit Spotify completely.
2. Run the Step 2 line again.
3. Spotify comes back ad-free.

That is the whole maintenance. Nothing else to remember.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Ads came back | Run the Step 2 line again (this is normal after a Spotify update) |
| `command not found: spicetify` | Close the window, open a new Terminal/PowerShell, try again. Still missing → repeat Step 1 |
| `spicetify` says it cannot find Spotify, or Spotify does not start | Run `spicetify restore` (this puts the original Spotify back), then run the Step 2 line again |
| Nothing works, Spotify looks broken | `spicetify restore` returns Spotify to its untouched state; you can stop there or ask in the project's Issues page |
| Windows: Spotify from the Microsoft Store | Not supported by Spicetify — install Spotify from spotify.com instead |
| You want to be sure the patch is active | `spicetify config extensions` — you should see `no-ads.js` in the list |

---

## How to remove everything

Two commands, and Spotify is exactly as it was before:

```bash
spicetify restore
rm "$HOME/.config/spicetify/Extensions/no-ads.js"        # Windows: delete %APPDATA%\spicetify\Extensions\no-ads.js
```

(On Windows use `Remove-Item "$env:APPDATA\spicetify\Extensions\no-ads.js"`.)

To keep Spicetify but drop only our add-on:

```bash
spicetify config extensions no-ads.js-
spicetify apply
```

---

## Honest notes

- **No account is touched.** Nothing is uploaded anywhere; no password, no payment, no subscription
  change. The add-on works on the Spotify desktop app you already have.
- **It does not give you paid features.** Ads are removed and silent quality downgrades are stopped —
  that is all. It does not raise the sound quality above what your plan allows (a free plan streams
  160 kbps; Premium streams 320 kbps), and it does not download music.
- **It may conflict with Spotify's Terms of Service.** It changes your own app on your own computer;
  you do it at your own risk.

*Advanced users: the technical details live in [`README.md`](README.md) and
[`docs/how-it-works.md`](docs/how-it-works.md). This page is deliberately written for everyone else.*
