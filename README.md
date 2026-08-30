# YouTube Ad Skipper

[![Validate extension](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml/badge.svg)](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Chrome extension (Manifest V3) that skips YouTube video ads by detecting
YouTube's own in-player ad state and driving the controls it already
exposes: clicking the "Skip Ad" button when available, or seeking an
unskippable ad's `<video>` element to the end of its duration so the
player advances to your content.

## Limitations (read before relying on this)

- This is DOM-based: it reacts to YouTube's existing player markup and
  class names. It is not a network-level ad blocker (like uBlock Origin) —
  it doesn't stop ad requests, it shortens/skips ads after they start.
- Very short unskippable pre-roll ads may still play briefly before the
  extension can act.
- Ads longer than 10 minutes (`MAX_PLAUSIBLE_AD_SECONDS` in `content.js`)
  are not fast-forwarded to their end — this is a deliberate guard against
  a misclassified real video getting jumped to "ended" instead of an
  actual ad, not a real-world limitation, since ads that long essentially
  don't exist. If YouTube ever ships a genuinely longer unskippable ad,
  this would need to be raised.
- If YouTube changes its player's HTML/class structure, the selectors in
  `content.js` (`SKIP_BUTTON_SELECTORS`, `ad-showing`/`ad-interrupting`,
  `ADBLOCK_SPECIFIC_SELECTOR`, `ADBLOCK_GENERIC_DIALOG_SELECTOR`) may need
  to be updated to match.
- The ad-block warning dialog is a moving target even more than the skip
  button is — YouTube actively iterates on this specific mechanism, so
  expect the selectors/text-matching in `content.js` to need updates over
  time, and expect occasional false negatives (a redesigned dialog slips
  through until selectors are updated).
- The auto-reload recovery is best-effort: it's capped at 2 attempts per
  video and there's no guarantee reloading actually clears the block —
  YouTube may re-show the warning immediately. Past that cap, the on-player
  "click to reload" button is a manual fallback, not an automatic fix.
- The independent stuck-playback watchdog (three signals: a real
  `video.error`, a sustained ~1.8s missing `<video>` element, or 6 real
  seconds of `currentTime` not advancing while the video claims to be
  playing) deliberately does *not* treat "just paused" as stuck on its
  own, since that would risk reloading a video you paused on purpose. If
  a stall somehow doesn't trip any of the three (a boundary case none of
  the current regression tests exercise), it won't be caught
  automatically; check the devtools console for a `[YT Ad Skipper]`
  diagnostic log either way — that log is what found the third signal
  above in the first place.
- The toolbar icon's light rim (added by `gen_icons.py`) was tuned and
  visually checked against Chrome's actual default light toolbar color and
  a representative dark-theme toolbar color, not against every theme or
  OS accent color a user might have — an unusual toolbar color could still
  reduce contrast.
- The popup and options page follow `prefers-color-scheme` (the OS/browser
  light-dark preference), verified by rendering both under emulated light
  and dark schemes. There's no extension API to read an arbitrary custom
  Chrome theme's actual colors, so an unusual custom theme could still
  clash even though light/dark mode itself is handled.
- **Playlists**: reported behavior where the extension appears to fast-
  forward through normal videos inside a playlist rather than playing them.
  This has not been reproduced locally, so it isn't confirmed as a
  root-caused fix here — the likely mechanism is a false-positive
  `isAdShowing()` match (the player briefly picking up an
  `ad-showing`/`ad-interrupting` class on the actual content video, not an
  ad) that then gets fast-forwarded through the normal skip path. This is a
  known, currently open, unresolved issue in other major ad-blocking
  extensions too (see AdGuard browser-extension#3453 and Brave
  brave-browser#52869), not something unique to this codebase. As of
  1.3.6, every fast-forward now logs `[YT Ad Skipper] fast-forwarding
  detected ad` to the console with the video id, playlist id, and resolved
  player id — if this happens again, that log is what turns it into a
  reproducible case instead of another guess; please include it when
  reporting.
- **Auto-reload and real playback stalls**: reported behavior where a real
  video gets stuck (frozen, `readyState` never advances past
  `HAVE_METADATA`) in a way confirmed to only happen with this extension
  enabled - not a plain YouTube/network issue the extension is just
  witnessing, and not caused by DNS-level ad blocking. The one diagnosed
  case so far showed the actual video CDN requests failing with
  `net::ERR_NAME_NOT_RESOLVED`, which a content script cannot cause
  directly (this extension has no network-interception permission at all -
  see `manifest.json`). The working theory is that the automatic full-page
  reload in `reloadToRecoverPlayback()` - a much heavier intervention than
  letting YouTube's own player retry in place - is what's actually
  converting a brief, self-healing network hiccup into a hard failure, by
  tearing down in-page connection state and forcing a fresh top-level DNS
  resolution at exactly the wrong moment. Not confirmed. If this happens
  to you, the most useful single test is turning off "Auto-reload if
  playback is stuck" in the options page (leaves ad-skipping and ad-block-
  banner removal on, disables only the reload/`video.play()` recovery
  path) and seeing whether the stall stops happening - that isolates the
  mechanism instead of leaving it a guess. As of 1.3.8, every actual
  reload attempt (and every time the reload cap is hit) is logged to the
  console with the attempt number and target URL, so a future report can
  show definitively whether a reload happened at all.
- Not affiliated with Google or YouTube. Using it may be against YouTube's
  Terms of Service depending on how you use it — this is provided for
  personal, educational use, unpacked/local installation only. It is not
  published to the Chrome Web Store.

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

Run the static checks used by CI locally before committing:

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
