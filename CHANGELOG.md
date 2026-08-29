# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
