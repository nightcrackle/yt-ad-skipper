# YouTube Ad Skipper

[![Validate extension](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml/badge.svg)](https://github.com/nightcrackle/yt-ad-skipper/actions/workflows/validate.yml)

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
does) and respond with an "Ad blockers are not allowed on YouTube" dialog
that, if ignored, pauses the video and leaves it stuck. Two independent
settings on the options page address this — **Behavior** is the ad-skip
toggles above; these live under **Ad-block warning**:

- **Remove the ad-block warning banner** (default on) — detects the
  dialog/overlay (by known element names, falling back to a text-content
  scan for phrases like "ad blockers are not allowed" so it's more likely
  to survive a YouTube markup change) and removes it along with its modal
  backdrop.
- **Auto-reload if playback is stuck** (default on, requires the setting
  above) — if the video is still paused shortly after the banner is
  removed, reloads the page. Removing the dialog alone doesn't resume a
  video YouTube has already paused for this reason, so a reload is the
  practical fix. Your playback position is preserved via the `t=` URL
  parameter, and this is capped at 2 auto-reload attempts per video
  (tracked in `sessionStorage`, so it resets per tab/session) specifically
  to avoid a reload loop if YouTube re-triggers the block immediately
  again — past that cap it shows a toast telling you to reload manually
  instead of retrying forever.

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

## Limitations (read before relying on this)

- This is DOM-based: it reacts to YouTube's existing player markup and
  class names. It is not a network-level ad blocker (like uBlock Origin) —
  it doesn't stop ad requests, it shortens/skips ads after they start.
- Very short unskippable pre-roll ads may still play briefly before the
  extension can act.
- If YouTube changes its player's HTML/class structure, the selectors in
  `content.js` (`SKIP_BUTTON_SELECTORS`, `ad-showing`/`ad-interrupting`,
  `ADBLOCK_WARNING_SELECTORS`) may need to be updated to match.
- The ad-block warning dialog is a moving target even more than the skip
  button is — YouTube actively iterates on this specific mechanism, so
  expect the selectors/text-matching in `content.js` to need updates over
  time, and expect occasional false negatives (a redesigned dialog slips
  through until selectors are updated).
- The auto-reload recovery is best-effort: it's capped at 2 attempts per
  video and there's no guarantee reloading actually clears the block —
  YouTube may re-show the dialog immediately.
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
  (toggles, lifetime count, link to the full settings page).
- `options.html` / `options.css` / `options.js` — the full settings page:
  ad-skip/mute toggles, ad-block-warning toggles, max-log-entries rotation
  setting, storage usage, clear-logs button, and the skip log table.
- `icons/` — toolbar/extension icons (`icon16.png`, `icon48.png`,
  `icon128.png`), generated from `icons/icon-source.png`.
- `gen_icons.py` — regenerates the three icon sizes from
  `icons/icon-source.png` (pads to square, then resizes). Not needed at
  runtime; re-run it (`python3 gen_icons.py`) after replacing the source
  artwork.

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

Last run: 2026-08-28 10:07 UTC. This block is a static snapshot — it will go
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
