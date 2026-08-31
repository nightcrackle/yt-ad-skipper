# YouTube Ad Skipper

[![Validate extension](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml/badge.svg)](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Chrome extension (Manifest V3) that skips YouTube video ads by detecting
YouTube's own in-player ad state and driving the controls it already
exposes: clicking the "Skip Ad" button when available, or seeking an
unskippable ad's `<video>` element to the end of its duration so the
player advances to your content.

## What this extension actually does

- Watches the YouTube player's CSS state (`ad-showing` / `ad-interrupting`
  classes) to know when an ad is on screen.
- **Auto-skip mode (default on):** as soon as an ad is detected, it clicks
  the native "Skip Ad" button if present; if there's no skip button yet
  (e.g. the first few seconds of an unskippable ad), it seeks the ad's
  video to its end, which the player treats as the ad finishing.
- **Manual mode:** if you turn auto-skip off in the popup, the extension
  instead shows a small floating "Skip Ad" button over the player during
  ads that you click yourself.
- **Mute during ads:** optionally mutes the tab while an ad is playing and
  restores your previous volume/mute state once it ends.
- Tracks how many ads it has skipped (session count on the toolbar badge,
  all-time count in the popup).
- **Skip log:** every skip is recorded (time, video title/link, and whether
  it was auto or manual) in a full **Settings & skip logs** page, opened
  from the "Settings & skip logs" button in the popup. See below.
- **Ad-block warning removal:** if YouTube shows its "Ad blockers are not
  allowed on YouTube" dialog and pauses the video, the extension removes
  the dialog and, if playback is still stuck, reloads the page to recover
  it. See "Ad-block warning handling" below — this one is worth reading
  before you rely on it.

## Skip log, rotation, and clearing

The popup's **Settings & skip logs** button opens a full settings page
(`options.html`) with:

- The same Auto-skip / Mute toggles as the popup.
- **Max log entries** — a number field (10–5000, default 200) controlling
  how large the skip log is allowed to grow. Housekeeping is automatic:
  every time a new skip is logged, the background service worker checks
  the log against this cap and rotates out the *oldest* entries first once
  it's exceeded, so the log never grows unbounded. A live storage-usage
  line (entry count + approximate KB used) is shown under the setting.
- **Clear logs** — wipes the stored skip log immediately (after a confirm
  prompt). This only clears the detailed log; it does not reset the
  lifetime "ads skipped" counter shown in the popup, which is tracked
  separately on purpose (rotating/clearing the log shouldn't erase your
  lifetime stats).
- The log table itself: timestamp, auto/manual badge, and a link to the
  video, newest first.

Logs are stored in `chrome.storage.local` (this browser/profile only —
nothing is transmitted anywhere). All storage writes for the counter and
log go through a single serialized queue in `background.js` so that ads
skipped in two YouTube tabs at nearly the same moment can't race each
other and silently drop a log entry.

## Install (load unpacked, for personal use)

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the repository folder (`yt-ad-skipper`).
6. Open the extension's icon in the toolbar to configure auto-skip / mute
   settings.
7. Go to YouTube and play a video with ads to test.

## Privacy

- No network requests are made by this extension and no analytics/telemetry
  are collected.
- Settings live in `chrome.storage.sync` (auto-skip, mute, max log entries);
  the lifetime counter and skip log live in `chrome.storage.local`. Both are
  local to your browser profile — nothing leaves the machine.
- The skip log only ever contains what's visible on the YouTube page you're
  already on (video title/URL, timestamp, auto/manual). Use **Clear logs**
  in the settings page at any time to wipe it.

## Files

- `manifest.json` — extension manifest (MV3).
- `content.js` / `content.css` — runs on youtube.com, detects ads, skips
  them, shows the manual skip button and toast notifications, reports each
  skip (with video title/url) to the background worker, and detects/removes
  YouTube's ad-block warning dialog (reloading to recover playback if
  needed).
- `background.js` — service worker; tracks the all-time skip counter, the
  toolbar badge, and the skip log (append + rotate + clear), all through a
  single serialized write queue.
- `popup.html` / `popup.css` / `popup.js` — the quick-access popup
  (toggles, lifetime count, link to the full settings page). Follows the
  OS/browser's light/dark preference (`prefers-color-scheme`) via CSS
  custom properties defined in `popup.css`.
- `options.html` / `options.css` / `options.js` — the full settings page:
  ad-skip/mute toggles, ad-block-warning toggles, max-log-entries rotation
  setting, storage usage, clear-logs button, and the skip log table. Also
  follows light/dark preference the same way, via `options.css`.
- `icons/` — toolbar/extension icons (`icon16.png`, `icon48.png`,
  `icon128.png`), generated from `icons/icon-source.png` (which keeps its
  original opaque background — it's the raw artwork, not a runtime icon).
- `gen_icons.py` — regenerates the three icon sizes from
  `icons/icon-source.png`: removes the background (transparent, feathered
  edge, preserving enclosed shading), tight-crops with only enough padding
  (2%) to keep the rim below from clipping — the glyph otherwise fills the
  canvas, since a pinned toolbar icon reads as too small fast — then adds
  a soft light rim outside the silhouette sized for visibility on Chrome's
  dark toolbar theme (invisible on the light theme — see the icon note
  under Limitations). Not needed at runtime; re-run it
  (`python3 gen_icons.py`) after replacing the source artwork. Needs
  `requirements-dev.txt` installed (`pip install -r requirements-dev.txt`).

## Updating / debugging

If ads stop being detected after a YouTube update, open a YouTube tab,
right-click the player → Inspect, and check whether `.html5-video-player`
still gets an `ad-showing` class and what the current skip button's class
name is. Update the selectors near the top of `content.js` accordingly,
then click the refresh icon for the extension on `chrome://extensions`.

## Development

```sh
bash scripts/validate.sh
```

It validates `manifest.json`, checks JS syntax, and parses the HTML files.
A GitHub Actions workflow (`.github/workflows/validate.yml`) runs the same
script on every push and pull request — once this repo actually lives on
GitHub, that workflow's own run is the authoritative status, and the badge
at the top of this file will reflect it.

Do **not** commit a `.pem` file — Chrome generates one if you use
"Pack extension" in `chrome://extensions`, and it's your extension's private
signing key. `.gitignore` already excludes `*.pem`, `*.crx`, and `*.zip`.

### CI validation status

```text
$ bash scripts/validate.sh
== Validating manifest.json ==
OK
== Checking JavaScript syntax ==
  content.js
  background.js
  popup.js
  options.js
== Checking HTML parses ==
  popup.html OK
  options.html OK
== Checking for accidentally committed Chrome extension private keys (*.pem) ==
OK
All checks passed.
$ echo $?
0
```

## License

[MIT](LICENSE)

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Google or YouTube. All
trademarks belong to their respective owners. Provided as-is for personal,
educational use.

The ad-block-warning-handling feature specifically detects and works
around YouTube's countermeasure against ad blockers, which is a more
direct conflict with YouTube's enforcement than ad-skipping alone. This
project has no information on what account-level consequences, if any,
YouTube may apply for ad-blocker use or for circumventing this dialog —
don't assume there are none. If you'd rather avoid that risk entirely,
disable both ad-block-warning toggles in the options page and only use
the ad-skipping features.
