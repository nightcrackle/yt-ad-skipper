# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.3.5]

### Fixed
- **The actual root cause, found from a real diagnostic log.** The 1.3.4
  watchdog logged its findings, and a user pasted one back: `video.paused
  === false`, `video.error === null` - the exact signals this extension
  was treating as proof of health - while `readyState` was wedged at
  `HAVE_METADATA` (1) and playback had frozen indefinitely. A video can
  report itself as "playing" while never actually rendering a single
  frame, forever, without ever becoming officially "paused" or "errored".
  Trusting `!paused && !error` alone as "healthy" - which every recovery
  check in this extension did, including the ad-block-warning path itself
  - was the gap that let this slip through three previous fix attempts.
- Added `looksHealthy(video)`, now used everywhere this extension decides
  whether playback needs recovering: also requires `readyState >=
  HAVE_CURRENT_DATA` (2), not just "not paused and no error".
- Added a third independent watchdog specifically for this failure mode:
  samples `video.currentTime` at most once per real second (not once per
  tick - a MutationObserver storm can call `tick()` far more often than
  the 300ms interval, which would otherwise shrink the effective
  detection window) and accumulates real elapsed seconds whenever it
  hasn't meaningfully advanced while the video reports itself as playing.
  After 6 accumulated stalled seconds, triggers recovery - skipping the
  `video.play()` step this time, since calling `.play()` on an element
  that already considers itself playing is a no-op in every major browser
  and can't unstick a wedged network fetch; goes straight to the reload
  fallback, which is what's actually shown to fix this.
- Verified with two new regression tests reproducing the exact reported
  state (`paused: false`, `error: null`, `readyState: 1`, frozen
  `currentTime`, no ad-block warning present at all - confirmed: now
  triggers recovery) and a genuinely healthy-playback case (`readyState:
  4`, `currentTime` actually advancing every 250ms, run for the full 16s
  test window) confirming the fix doesn't turn into a new false-positive.
  Also had to fix two *existing* "recovers on its own" regression fixtures
  that only faked `paused`/`readyState` without simulating real
  `currentTime` progress - they were passing before by accident, and
  would have (correctly) started failing once the stall watchdog could
  see they weren't actually advancing either.

## [1.3.4]

### Added
- **Independent stuck-playback watchdog**, decoupled entirely from
  ad-block-warning detection. The last two fixes (1.3.2, 1.3.3) both only
  ever ran inside the ad-block-warning code path - if a stuck, blank
  player wasn't actually caused by that specific warning UI, neither fix
  could ever have touched it, since that code never runs unless one of
  the known warning selectors is found. This watchdog reacts instead to
  two signals the browser/player only ever sets when something is
  genuinely broken - a real `video.error` (a `MediaError`), or the
  `<video>` element being missing outright for a sustained ~1.8s stretch
  on a watch page - neither of which is ever true just because the user
  paused deliberately, so it can't misfire on a normal manual pause. It
  reuses the same recovery flow (try `video.play()`, then fall back to
  the capped reload / persistent recovery button from 1.3.2) regardless
  of whether any ad-block warning was ever found.
- **Diagnostic logging.** Whenever recovery is attempted (either path),
  a `console.warn('[YT Ad Skipper] stuck playback detected - ...')`
  snapshot is logged with player classes, video readyState/networkState/
  error, whether it has a source, and whether any ad-block warning
  selector currently matches - so a report like "it just stops there"
  can actually be debugged from devtools next time, instead of guessed
  at blind a third time.

### Fixed
- **`fastForwardAd()` could jump a real, long video to its own end.**
  If `isAdShowing()` ever misclassifies the real content player as
  showing an ad (a false positive on the `ad-showing`/`ad-interrupting`
  classes), the old code would jump the *real* video's `currentTime` to
  its `duration` - triggering "ended" on a video the user was actually
  watching, with nothing to auto-recover it since that has nothing to do
  with the ad-block-warning machinery. Added `MAX_PLAUSIBLE_AD_SECONDS`
  (600s): real ads are essentially always well under this, so a "duration"
  beyond it while ad-showing is now refused (logged, not acted on)
  instead of blindly trusted. Verified: a normal 15s ad still gets fast-
  forwarded exactly as before; a misclassified 2-hour "ad" no longer gets
  its `currentTime` touched at all.
- Verified with four new regression tests: a genuine media error with
  no ad-block warning present at all (must still recover, via the new
  watchdog only), a missing `<video>` with no warning present (same), a
  plain manual pause - video present, paused, no error, no warning (must
  trigger *nothing*, ever - the critical false-positive guard), and the
  `fastForwardAd()` duration bound (both the normal and misclassified
  cases). Also caught and fixed a bug in several *existing* regression
  fixtures: `<video src="about:blank">` turns out to set a real, native
  `MediaError` in actual Chromium (confirmed by testing it directly) -
  which was silently masking what several existing tests actually
  verified. Fixtures now use a bare `<video>` (no `src`) as the
  error-free baseline; all existing scenarios re-verified clean afterward.

## [1.3.3]

### Fixed
- **The ad-block warning banner was showing up and staying up again.**
  Root cause: `#error-screen` - YouTube's actual, real element for the
  harder in-player block - was never in the detection selector list at
  all, in any released version. The selector this extension previously
  used for that variant (`yt-playability-error-supported-renderers`) was
  a secondary/fallback element, not YouTube's primary one; `#error-screen`
  is the one that actually shows up in the wild, and it was silently never
  detected, so it was never removed. Confirmed against real, actively
  maintained open-source YouTube ad-block-warning removers, not just
  re-guessed. `#error-screen` is now in the candidate list.
- Split detection into two tiers: `ytd-enforcement-message-view-model`,
  `yt-playability-error-supported-renderers`, and `#error-screen` are
  specific to this warning and never reused for anything else, so their
  presence alone is now trusted (no text match required) - this also
  removes a failure mode where a wording change could have silently
  broken detection even once the selector was right. The generic
  `tp-yt-paper-dialog` / `ytd-popup-container` / `[role="dialog"]`
  containers, which YouTube does reuse for unrelated dialogs, still
  require a text match before being treated as the warning, exactly as
  before (see CHANGELOG 1.3.1) - this tiering doesn't reopen that bug.
- `removeAdblockWarning()` now actually deletes the in-player
  `#error-screen` / `yt-playability-error-supported-renderers` element too
  (previously 1.3.2 deliberately left these in the DOM out of caution).
  Real-world removers do exactly this safely, since neither is the
  player's `<video>` element or a wrapper around it - they're overlay/error
  UI alongside it. A structural safety check (skip removal, but still
  report detection, if a match is ever found to contain a `<video>`) is
  kept as a zero-cost guard against that specific risk rather than
  avoiding removal altogether.
- **Lighter recovery, tried first:** instead of jumping straight to a page
  reload, the recovery step now tries a plain `video.play()` first once
  the warning is handled - YouTube's enforcement very often just leaves an
  otherwise-working video paused rather than actually broken, and this
  resumes it instantly with no reload/flicker. Reloading (still capped at
  2 attempts, still falls back to the persistent on-player recovery button
  past that cap - see CHANGELOG 1.3.2) only happens if `video.play()`
  doesn't actually result in playback resuming shortly after.
- Verified with two new headless-browser regression tests targeting
  `#error-screen` specifically: one where the video is present and
  recoverable with just `video.play()` (confirmed: warning removed, no
  reload at all), and one with no video present (confirmed: falls through
  to reload, same as the existing in-player-block coverage) - plus the
  full existing suite (5 more scenarios) re-verified against this change,
  including a real click-through test on the recovery button.

## [1.3.2]

### Fixed
- **Playback stuck on a blank, unclickable black screen with no reload.**
  YouTube shows its ad-block enforcement in two different shapes, and the
  code only handled one of them correctly:
  - A dismissible dialog, wrapped in `ytd-popup-container` /
    `tp-yt-paper-dialog` - safe to delete outright.
  - A harder in-player block, where the same warning text renders
    directly inside the player itself (not wrapped in a dialog), often
    with no `<video>` element present at all while it's showing.
  `removeAdblockWarning()` didn't distinguish these - it deleted whatever
  matched, including the in-player variant. If that also meant the
  player's `<video>` element was gone, the reload-recovery check
  (`video && video.paused`) silently found no video, never called
  `reloadToRecoverPlayback()`, and nothing happened: no reload, no toast,
  no recovery, just a dead player area.
- `removeAdblockWarning()` now only deletes the element when it's
  genuinely wrapped in a dismissible dialog/popup container, and instead
  reports detection separately from removal so the recovery flow below
  still runs either way; the recovery check itself now treats a missing
  `<video>` element as stuck too, not only a paused one.
- **No visible way to recover once the reload cap was hit.** Auto-reload
  is intentionally capped (`MAX_AUTO_RELOADS_PER_VIDEO`) so a persistent
  block can't loop forever - but hitting the cap only showed a 1.5s toast
  and then gave up completely, leaving the exact same dead, unclickable
  player area with nothing on screen to fix it. A persistent "⟳ Playback
  blocked - click to reload" button is now shown on the player itself
  whenever auto-reload gives up, so there's always something to click; it
  triggers an immediate manual reload and clears itself once playback is
  confirmed to have actually resumed.
- Recovery checks are now debounced to at most one in flight at a time -
  needed because the in-player warning variant is deliberately left in
  the DOM (see above) and would otherwise still match on every 300ms tick,
  each one scheduling its own recovery check and burning through the
  reload cap in under a second, before the first reload even navigated.
- Verified with five headless-browser regression tests covering: the
  existing homepage/real-warning cases, an in-player block with no
  `<video>` element (previously: zero reload attempts, completely stuck -
  now: reloads up to the cap, then shows the recovery button), a
  pre-exhausted reload cap (previously: no recovery button at all - now:
  button shown), and a self-recovering case where playback resumes on its
  own without our help (must not reload, must not show a stray button) -
  plus a click-through test confirming the recovery button actually
  triggers a fresh page load.

## [1.3.1]

### Fixed
- **Reload loop on first-time visits.** `ADBLOCK_WARNING_SELECTORS`
  included `'ytd-popup-container tp-yt-paper-dialog'`, a purely
  structural selector with no content check - it matched *any* dialog
  YouTube shows in a popup container, including the cookie/consent
  dialog many first-time visitors see on the homepage. That dialog got
  deleted (not properly "accepted", so it could reappear), read as an
  ad-block warning, and combined with an unrelated paused preview
  `<video>` element (common on the homepage), triggered a reload. The
  reload counter was keyed by video ID, which is `null` on non-watch
  pages, and the code silently skipped its own cap in that case
  (`count` always read back as `0`) - so the reload had no limit and the
  page kept reloading indefinitely.
- Three independent fixes, kept independent on purpose so no single
  remaining gap reopens the loop:
  - `findAdblockWarningElement()` now requires every candidate (however
    it was found) to match `ADBLOCK_WARNING_TEXT_PATTERN` before being
    treated as the warning - a same-tag-name dialog with unrelated text
    is never enough.
  - Ad-block-warning handling (both detection and reload) now only runs
    when there's an actual video player *and* a resolvable video ID
    (watch, Shorts, or embed URL) - never on the homepage, search, or
    channel pages. `getVideoId()` now also recognizes `/embed/` URLs.
  - The reload-attempt counter's key can no longer be `null` (falls back
    to the page path when there's no video ID), so the attempt cap
    always applies, structurally, even in an unanticipated future
    false-positive.
- Verified with two headless-browser regression tests: a simulated
  homepage with a generic consent dialog (must NOT be touched, confirmed
  untouched) and a simulated watch page with the real warning text (must
  still be detected and removed, confirmed working).

## [1.3.0]

### Changed
- The icon glyph now fills more of its canvas: `gen_icons.py`'s crop
  padding dropped from 6% to 2% (just enough to keep the toolbar rim from
  clipping at the canvas edge), so the pinned toolbar icon reads larger.
- The popup and options page now follow the OS/browser's light/dark
  preference (`prefers-color-scheme`) instead of always rendering with a
  white background. Both were rewritten to use CSS custom properties for
  every color (background, text, borders, table, badges, buttons) with a
  dark-mode override block, and verified by rendering both pages under
  emulated light and dark color schemes. This is light/dark support, not
  a reader of Chrome's arbitrary custom theme colors — there's no
  extension API for the latter.

### Changed
- Icon background is now transparent instead of opaque black. Removed via
  border flood-fill (not a flat color-key) so enclosed dark shading in the
  artwork is preserved, with a feathered edge instead of a hard cutout.
- Icons are now tight-cropped to the artwork's bounding box before being
  re-padded to a square canvas, so the glyph fills more of the icon at
  every size (previously there was excess transparent/black margin).
- Added a soft light rim just outside the icon's silhouette, sized per
  icon. This exists specifically for toolbar-pin visibility: the
  artwork's face is a solid dark fill, which read fine on Chrome's light
  theme but nearly disappeared on its dark theme with no defined edge.
  The rim is white at partial opacity, so it's essentially invisible when
  composited over a light/white toolbar and only shows up as an outline
  on a dark one.
- `gen_icons.py` now performs all of the above as a documented, re-runnable
  pipeline; added `requirements-dev.txt` (Pillow, scipy) since background
  removal needs scipy in addition to Pillow.

## [1.2.0]

### Added
- Detects and removes YouTube's "Ad blockers are not allowed on YouTube"
  enforcement dialog/overlay (`hideAdblockWarning` setting, default on).
- If playback is left paused/stuck after the dialog is removed, reloads the
  page to recover it (`autoReloadOnBlock` setting, default on), preserving
  the current playback position via the `t=` URL parameter and capped at 2
  auto-reload attempts per video (tracked in `sessionStorage`) to avoid a
  reload loop.
- Both settings are in the options page under a new "Ad-block warning"
  section, with a note that this is a more direct point of conflict with
  YouTube's enforcement than ad-skipping.

## [1.1.1]

### Changed
- Replaced the placeholder red skip-icon artwork with the provided devil-head
  logo (`icons/icon-source.png`) as the toolbar/extension icon at all three
  sizes.
- `gen_icons.py` now resizes a source image (padding it to square first)
  instead of programmatically drawing an icon.

## [1.1.0]

### Added
- Ad-skip log: each skip records a timestamp, the video title/URL, and
  whether it was auto or manual, viewable on a new full-page **Settings &
  skip logs** screen (`options.html`), linked from the popup.
- Configurable log housekeeping: a `maxLogEntries` setting (10–5000,
  default 200) that automatically rotates out the oldest log entries once
  exceeded, enforced on every new skip.
- Manual **Clear logs** action (with confirmation) that wipes the stored
  log without touching the separate lifetime skip counter.
- A serialized write queue in the background service worker so skips
  reported from multiple YouTube tabs at once can't race each other and
  drop a log entry.

## [1.0.0]

### Added
- Initial release: detects YouTube's in-player ad state and clicks the
  native Skip button, or seeks unskippable ads to their end.
- Auto-skip and manual (on-player prompt) modes.
- Optional mute-during-ads.
- Toolbar badge + popup lifetime skip counter.
