# YouTube Ad Skipper

[![Validate extension](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml/badge.svg)](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Chrome extension (Manifest V3) that skips YouTube video ads by detecting
YouTube's own in-player ad state and driving the controls it already
exposes: clicking the "Skip Ad" button when available, or seeking an
unskippable ad's `<video>` element to the end of its duration so the
player advances to your content.

## Why not the "add a dot after youtube.com" trick?

That trick doesn't work anymore. In June 2020 it briefly worked because
YouTube's ad-serving backend didn't normalize a trailing dot (`youtube.com.`)
in the hostname, which caused an ad-request/hostname check to silently fail.
Google patched it within days. There is no current mechanism where a
trailing dot, or any URL rewriting like it, affects whether YouTube serves
ads — this extension does not use that approach.

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

## Ad-block warning handling

YouTube can detect ad blockers (including the ad-skipping this extension
does) and respond with an "Ad blockers are not allowed on YouTube"
warning. It shows up in two different shapes, both handled the same way
now (removed outright):

- A **dismissible dialog**, wrapped in YouTube's generic popup/dialog
  containers (`ytd-popup-container` / `tp-yt-paper-dialog`) — a modal
  over an otherwise-fine player.
- A **harder in-player block** (`#error-screen`), where the warning
  renders directly inside the player area itself instead of a dialog, and
  the video is stopped or never starts. This is YouTube's real element for
  this — confirmed against actively maintained open-source ad-block-
  warning removers, not guessed at — and it was missing from this
  extension's detection entirely before v1.3.3, so this shape was never
  actually removed in any earlier version; it would just sit there.

Neither is the player's own `<video>` element or a wrapper around it —
they're overlay/error UI alongside it — so removing them outright is
safe. As a zero-cost structural safety net, removal is skipped (detection
still happens, so recovery still runs) if a match is ever found to
unexpectedly contain a `<video>` element.

Two independent settings on the options page address this — **Behavior**
is the ad-skip toggles above; these live under **Ad-block warning**:

- **Remove the ad-block warning banner** (default on) — only runs on an
  actual watch/Shorts/embed page (a real video player present *and* a
  resolvable video ID; never the homepage, search, or channel pages).
  Elements specific to this warning (`ytd-enforcement-message-view-model`,
  `yt-playability-error-supported-renderers`, `#error-screen`) are trusted
  by presence alone; YouTube's *generic* dialog containers
  (`tp-yt-paper-dialog`, `ytd-popup-container`, `[role="dialog"]`) also
  require the element's text to actually match known warning phrasing
  (e.g. "ad blockers are not allowed") before being treated as real —
  matching those by tag/container name alone previously caused a reload
  loop on first-time visits (see CHANGELOG 1.3.1), because YouTube reuses
  those same generic containers for unrelated dialogs like the
  cookie/consent prompt.
- **Auto-reload if playback is stuck** (default on, requires the setting
  above) — once the warning is handled, first tries a plain `video.play()`
  to resume playback with no reload or flicker at all (YouTube's
  enforcement very often just leaves an otherwise-working video paused
  rather than actually broken). Only if that doesn't actually result in
  playback resuming shortly after does it reload the page, preserving your
  playback position via the `t=` URL parameter, capped at 2 auto-reload
  attempts (tracked in `sessionStorage`, keyed by video ID — or the page
  path as a fallback that keeps the cap in effect even without one, so it
  can never be silently skipped) specifically to avoid a reload loop if
  YouTube re-triggers the block immediately again. Past that cap,
  auto-reloading stops — at that point YouTube re-blocking every single
  reload most likely means a real ad blocker is still active elsewhere in
  your browser (this extension doesn't block ad requests, so it can't fix
  that) rather than a one-off glitch — but a persistent **"⟳ Playback
  blocked — click to reload"** button is left on the player itself so
  you're never just stuck looking at a dead, unclickable video area with
  nothing to do about it; it disappears once playback is actually
  confirmed to have resumed.

This is a more direct point of conflict with YouTube's own enforcement
than ad-skipping is: skipping ads uses controls YouTube's player already
exposes, while this specifically targets YouTube's countermeasure against
ad blockers. It depends on YouTube's current dialog markup/wording just
like the skip-button selectors do, is very likely to need updating as
YouTube adjusts its detection (this is an active arms race — expect this
to break periodically), and pushing harder against a site's active
anti-adblock enforcement is a clearer Terms-of-Service conflict than
skipping ads was; see the Disclaimer below. If you'd rather not have the
extension push back on this at all, turn both toggles off in the options
page.

### Independent stuck-playback watchdog

Everything above only ever runs when one of the known ad-block-warning
elements is actually found — if a stuck, blank player is caused by
something else (a different YouTube error this extension has no selector
for, or a bug in this extension's own ad-skip logic), that code path
never runs at all. Three separate signals exist for that gap, none of
which are ever true just because you paused the video yourself, so none
of them can misfire on an ordinary manual pause:

- A genuine `video.error` (a real `MediaError` the browser itself sets).
- The `<video>` element being missing outright for a sustained ~1.8s on a
  watch page.
- **The video reporting itself as playing (not paused, no error) while
  never actually making progress.** This one was found from a real
  diagnostic log a user pasted back: `paused: false`, `error: null` —
  passing every check above — while `readyState` was wedged at
  `HAVE_METADATA` and playback had frozen indefinitely. A video can claim
  to be playing without ever rendering a frame, forever. Every recovery
  check in this extension now also requires `readyState >=
  HAVE_CURRENT_DATA`, and a dedicated watchdog separately tracks whether
  `currentTime` is actually advancing over real seconds (sampled at most
  once/second, deliberately not once per tick, so a burst of
  MutationObserver-triggered ticks can't shrink the detection window) —
  after 6 real seconds of zero progress, this one reloads directly rather
  than trying `video.play()` first, since calling `.play()` on something
  that already claims to be playing is a no-op in every major browser.

All three run the same recovery (or, for the stall case, go straight to
the reload fallback) regardless of whether any ad-block warning was ever
detected. Whenever any of them attempts recovery, it logs a diagnostic
snapshot to the console (`console.warn`, prefixed `[YT Ad Skipper]`) with
the player/video state at that moment — open devtools (F12 → Console) if
this happens again and search for that prefix; that snapshot is far more
useful for tracking down what's actually going on than a description of
what was on screen. It's also exactly how the third signal above was
found — read the log, don't just guess from what's visible on screen.

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

No GitHub Actions run exists yet — this repo hasn't been pushed to GitHub in
this session. Below is the actual output of the last local run of
`scripts/validate.sh` (the exact script CI calls), so this reflects a real
result, not a placeholder:

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

Last run: 2026-08-29 12:46 UTC. This block is a static snapshot — it will go
stale as the code changes. Once pushed to GitHub, remove this section (or
just point to it in the badge) and rely on the live Actions run instead.

## License

[MIT](LICENSE) — update the copyright line in `LICENSE` with your own name
or handle before publishing (it currently has a placeholder).

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
