# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.2.0]

### Added
- Detects and removes enforcement dialog/overlay (`hideAdblockWarning` setting, 
  default on).
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
