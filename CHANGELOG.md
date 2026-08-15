# Changelog

All notable changes to this project are documented here.

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
