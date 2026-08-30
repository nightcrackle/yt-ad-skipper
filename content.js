/**
 * YouTube Ad Skipper - content script
 *
 * How ad detection works:
 * YouTube's player container gets the class `ad-showing` (and often
 * `ad-interrupting`) added while any ad is playing, and removed the
 * moment it ends. We watch for that with a MutationObserver plus a
 * low-frequency polling fallback (YouTube's SPA navigation doesn't always
 * fire clean DOM events). getPlayer() resolves the container itself: a
 * normal watch page's singleton player is `#movie_player`; the Shorts
 * feed reuses a single player instance across the whole feed at
 * `#shorts-player` instead (confirmed against several real, unrelated
 * YouTube extensions/userscripts) - a plain `.html5-video-player` class
 * lookup can't tell those apart from the other player-shaped elements
 * Shorts keeps mounted for adjacent items, and is kept only as a last-
 * resort fallback if neither id is found. getVideo() is always scoped to
 * whatever getPlayer() resolves, never an unscoped document-wide search,
 * so the two can never disagree about which video is "the" video.
 *
 * When an ad is detected:
 *   1. If a "Skip Ad" button is present and enabled, we click it.
 *   2. Otherwise (unskippable ad, or skip button not ready yet), we mute
 *      the player and jump the ad's video element to the end of its
 *      duration, which YouTube treats as the ad finishing.
 *   3. If auto-skip is turned OFF in settings, we don't do any of that
 *      automatically - instead we show a small floating "Skip Ad" button
 *      the user can click, which runs the same logic on demand.
 *
 * This only works because it's driving UI that YouTube's own player
 * already exposes (the skip button, the video element's currentTime).
 * It does not block ad requests and it will not remove ads that have no
 * skip mechanism at all (e.g. some short unskippable pre-rolls still play
 * to their natural end before this can act). If YouTube changes its
 * player's class names or DOM structure, the selectors below may need
 * updating.
 *
 * Separately, this also reacts to YouTube's ad-blocker *enforcement* UI.
 * YouTube shows this in (at least) two different shapes, both handled the
 * same way now (removed outright - see removeAdblockWarning()):
 *   1. A dismissible dialog ("Ad blockers are not allowed on YouTube"),
 *      wrapped in its generic popup/dialog containers
 *      (`ytd-popup-container` / `tp-yt-paper-dialog`).
 *   2. A harder in-player block (`#error-screen`), where the warning
 *      renders directly inside the player area itself instead of a
 *      dialog, and the video is stopped or never starts. This selector
 *      was missing entirely before v1.3.3, so this variant was never
 *      actually detected or removed in any earlier version - it would
 *      just sit there indefinitely.
 * Neither is the player's own `<video>` element or a wrapper around it -
 * they're overlay/error UI alongside it - so removing them outright is
 * safe; as a structural safety net, removal is skipped (detection still
 * happens) if a match is ever found to unexpectedly contain a `<video>`.
 *
 * Removing the warning doesn't by itself resume a video YouTube has
 * already stopped. The recovery step tries the light fix first - a plain
 * `video.play()`, since YouTube's enforcement very often just leaves an
 * otherwise-working video paused rather than actually broken - and only
 * falls back to reloading the page (preserving playback position via the
 * `t=` URL parameter) if that doesn't result in playback actually
 * resuming. Reloading is capped at 2 attempts per video to avoid a reload
 * loop if YouTube re-triggers the block immediately again; past that cap,
 * auto-reloading stops (more likely a real, still-active ad blocker
 * elsewhere in the browser at that point than a one-off glitch) but a
 * persistent, clickable "reload" button is left on the player - a fading
 * toast alone would leave a genuinely dead, unclickable player area with
 * no visible way to recover.
 * Both warning-removal and auto-reload are independently toggleable in
 * settings. This is a more direct point of conflict with YouTube's own
 * enforcement than ad-skipping is, it depends on YouTube's current
 * markup/text just like the skip logic above, and YouTube can change or
 * strengthen this mechanism at any time.
 *
 * There's also an independent stuck-playback watchdog (see tick()),
 * decoupled entirely from the ad-block-warning detection above. It exists
 * because "playback silently died and never recovered" isn't always
 * caused by that specific warning UI - it could be any YouTube error this
 * extension doesn't have a selector for, or a real bug in this extension
 * itself (e.g. a false-positive ad-showing misclassification jumping a
 * real video to its own end via fastForwardAd() - see the sanity bound
 * there). Rather than only reacting when a known warning element is
 * found, it reacts to signals the browser/player only ever sets when
 * something is actually broken:
 *   - A real MediaError, or the <video> element missing outright for a
 *     sustained stretch.
 *   - A video that reports itself as playing (paused === false, no
 *     error) but never actually makes progress - confirmed as a real
 *     failure mode via this extension's own diagnostic log: readyState
 *     wedged at HAVE_METADATA, currentTime frozen, indefinitely. Trusting
 *     "not paused and no error" as proof of health was the gap that let
 *     this slip through the first two watchdog signals; looksHealthy()
 *     now also requires readyState >= HAVE_CURRENT_DATA, and a separate
 *     watchdog tracks currentTime across real wall-clock seconds to catch
 *     it even when readyState alone doesn't.
 * None of this is ever true just because the user paused deliberately, so
 * it can't misfire on an ordinary manual pause, and it's the fallback for
 * whenever this extension's guess at *why* playback is stuck is wrong.
 * When any of it fires, it logs a diagnostic snapshot (console.warn,
 * prefixed "[YT Ad Skipper]") of the player/video state - that log is
 * what actually found the stalled-playback gap above, rather than
 * guessing blind a third time.
 */

(() => {
  const STATE = {
    autoSkip: true,
    muteDuringAds: true,
    hideAdblockWarning: true,
    autoReloadOnBlock: true,
    wasMutedByUs: false,
    sessionSkipCount: 0,
    lastAdKey: null,
    recoveryCheckPending: false,
  };

  const SKIP_BUTTON_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    'button.ytp-ad-skip-button-container',
    '[id^="skip-button"] button',
  ];

  const AD_OVERLAY_CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-icon',
  ];

  // Elements YouTube uses *specifically and only* for its ad-block
  // enforcement UI - confirmed against real-world open-source removers
  // (not just guessed at) - so their mere presence is trusted without
  // also requiring a text match:
  //   - 'ytd-enforcement-message-view-model' - the warning's message
  //     content, inside the dismissible dialog.
  //   - 'yt-playability-error-supported-renderers' - a fallback host
  //     element used when the main player container isn't found.
  //   - '#error-screen' - the harder in-player block: YouTube replaces
  //     the video area with this instead of a dismissible dialog, and it
  //     was missing from this list entirely before v1.3.3 - meaning that
  //     variant was never actually detected or removed, in any version.
  const ADBLOCK_SPECIFIC_SELECTOR = [
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    '#error-screen',
  ].join(', ');

  // YouTube's *generic* popup/dialog containers - reused for lots of
  // unrelated things (cookie/consent prompts, sign-in nudges, "continue
  // watching?", etc.), so matching these by tag name alone previously
  // caused this extension to delete an unrelated first-visit dialog and
  // then reload the page thinking it had hit an ad-block block, which
  // repeated indefinitely (see CHANGELOG 1.3.1). Every candidate here
  // must also match ADBLOCK_WARNING_TEXT_PATTERN before being treated as
  // the warning - unlike the specific selectors above.
  const ADBLOCK_GENERIC_DIALOG_SELECTOR = [
    'tp-yt-paper-dialog',
    'ytd-popup-container',
    '[role="dialog"]',
  ].join(', ');

  // Phrases YouTube's enforcement dialog is known to use. Only required
  // for matches from ADBLOCK_GENERIC_DIALOG_SELECTOR above - this is what
  // keeps unrelated generic dialogs safe.
  const ADBLOCK_WARNING_TEXT_PATTERN =
    /ad ?blockers? (are|is) not allowed|please (disable|turn off) (your )?ad ?blocker|allow youtube ads/i;

  const MAX_AUTO_RELOADS_PER_VIDEO = 2;

  // How many consecutive 300ms ticks (~1.8s) of "no <video> element" or "a
  // real MediaError" a watch-like page has to show before the independent
  // stuck-playback watchdog acts. High enough to ride out normal
  // transient gaps (an SPA navigation to the next video, an ad-to-content
  // swap) without misfiring, low enough to still catch a genuine stall
  // quickly.
  const STUCK_PLAYBACK_STREAK_THRESHOLD = 6;

  // The stalled-playback watchdog samples currentTime at most this often
  // (real wall-clock time, not tick count - a MutationObserver storm can
  // call tick() far more often than the 300ms interval does, and sampling
  // on every single call would shrink the effective detection window).
  const STALL_SAMPLE_INTERVAL_MS = 1000;

  // How many real seconds of "reports itself as playing, but currentTime
  // hasn't moved" before treating it as a genuine stall rather than a
  // normal brief rebuffer (which is common and usually resolves in a
  // couple of seconds on its own).
  const STALLED_SECONDS_THRESHOLD = 6;

  function loadSettings() {
    chrome.storage.sync.get(
      {
        autoSkip: true,
        muteDuringAds: true,
        hideAdblockWarning: true,
        autoReloadOnBlock: true,
      },
      (items) => {
        STATE.autoSkip = items.autoSkip;
        STATE.muteDuringAds = items.muteDuringAds;
        STATE.hideAdblockWarning = items.hideAdblockWarning;
        STATE.autoReloadOnBlock = items.autoReloadOnBlock;
      }
    );
  }
  loadSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('autoSkip' in changes) STATE.autoSkip = changes.autoSkip.newValue;
    if ('muteDuringAds' in changes) STATE.muteDuringAds = changes.muteDuringAds.newValue;
    if ('hideAdblockWarning' in changes) STATE.hideAdblockWarning = changes.hideAdblockWarning.newValue;
    if ('autoReloadOnBlock' in changes) STATE.autoReloadOnBlock = changes.autoReloadOnBlock.newValue;
    if (!STATE.autoSkip) {
      // settings just changed to manual mode; make sure prompt reflects state
      updateManualPrompt(isAdShowing());
    } else {
      removeManualPrompt();
    }
  });

  // Confirmed against several independent, unrelated real-world YouTube
  // extensions/userscripts (SponsorBlock, return-youtube-dislike,
  // better-yt-shorts, control-panel-for-youtube, and others): the Shorts
  // feed (/shorts/...) keeps several `ytd-reel-video-renderer` items
  // mounted in the DOM at once (the current short plus adjacent ones
  // preloaded for smooth scrolling), and reuses a single player instance
  // - `#shorts-player` - re-parenting it into whichever one is active,
  // rather than instantiating a separate player per short. A plain
  // `document.querySelector('.html5-video-player')` has no way to tell
  // those apart and can grab a stale or inactive one; `#shorts-player`
  // is the one real extensions target instead. A normal watch page's
  // singleton player is `#movie_player`. Falling back to the old
  // class-based lookup only if the expected id isn't found keeps this
  // from going fully blind if YouTube's markup shifts again.
  function getPlayer() {
    if (location.pathname.startsWith('/shorts/')) {
      return document.querySelector('#shorts-player') || document.querySelector('.html5-video-player');
    }
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  // Always scoped to the player resolved above, never an unscoped
  // document-wide search - the two must never be able to disagree about
  // which video is "the" video. An earlier version searched the whole
  // document for `video.html5-main-video` / `video`, which on a page
  // with more than one player-shaped element mounted (Shorts feed
  // preloading, and reportedly YouTube playlist/autoplay transitions -
  // see README) could silently grab a different element than getPlayer()
  // just resolved, and every ad-detection/skip decision downstream of
  // that mismatch would be acting on the wrong video.
  function getVideo() {
    const scope = getPlayer() || document;
    return scope.querySelector('video.html5-main-video') || scope.querySelector('video');
  }

  function getVideoTitle() {
    const titleEl =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1.title yt-formatted-string') ||
      document.querySelector('.ytp-title-link');
    if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();
    // Fallback: document.title is usually "Video Title - YouTube"
    const fallback = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    return fallback || 'Unknown title';
  }

  function getVideoId() {
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get('v');
      if (v) return v;
      const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];
    } catch (e) {
      // ignore
    }
    return null;
  }

  function isAdShowing() {
    const player = getPlayer();
    if (!player) return false;
    return (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  function findClickable(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el; // visible
    }
    return null;
  }

  function clickSkipIfPresent() {
    const btn = findClickable(SKIP_BUTTON_SELECTORS);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  function closeOverlayAdsIfPresent() {
    const closeBtn = findClickable(AD_OVERLAY_CLOSE_SELECTORS);
    if (closeBtn) {
      closeBtn.click();
    }
  }

  // Virtually all real ads are well under this; a "duration" beyond it
  // while the player claims ad-showing is far more likely to mean
  // isAdShowing() misfired on the real content video than an actual
  // 10+ minute ad. Fast-forwarding a misclassified real video to its own
  // end would jump straight to "ended" - a stuck, blank player with
  // nothing to auto-recover it, since that has nothing to do with the
  // ad-block-warning machinery below. This is a cheap, one-line guard
  // against that specific failure mode.
  const MAX_PLAUSIBLE_AD_SECONDS = 600;

  function fastForwardAd() {
    const video = getVideo();
    if (video && isFinite(video.duration) && video.duration > 0) {
      if (video.duration > MAX_PLAUSIBLE_AD_SECONDS) {
        console.warn(
          '[YT Ad Skipper] not fast-forwarding - duration looks too long to be an ad',
          { duration: video.duration, url: location.href }
        );
        return false;
      }
      // Jumping to (just before) the end signals "ad finished" to the player
      // without leaving a visible seek bar jump on the *content* video later.
      // Logged specifically so a "it skipped through my whole playlist"
      // report can be matched against exactly which video got jumped and
      // why, rather than guessed at - see the playlist caveat in README.
      let playlistId = null;
      try {
        playlistId = new URL(location.href).searchParams.get('list');
      } catch (e) {
        // ignore
      }
      console.info('[YT Ad Skipper] fast-forwarding detected ad', {
        url: location.href,
        playlistId,
        videoId: getVideoId(),
        durationBefore: video.duration,
        currentTimeBefore: video.currentTime,
        playerElementId: getPlayer() ? getPlayer().id : null,
      });
      video.currentTime = video.duration;
      return true;
    }
    return false;
  }

  function muteForAd() {
    const video = getVideo();
    if (!video) return;
    if (!video.muted) {
      video.muted = true;
      STATE.wasMutedByUs = true;
    }
  }

  function unmuteAfterAd() {
    const video = getVideo();
    if (!video) return;
    if (STATE.wasMutedByUs) {
      video.muted = false;
      STATE.wasMutedByUs = false;
    }
  }

  function findAdblockWarningElement() {
    // Specific selectors are trusted by presence alone - see the comment
    // on ADBLOCK_SPECIFIC_SELECTOR for why.
    const specific = document.querySelector(ADBLOCK_SPECIFIC_SELECTOR);
    if (specific) return specific;

    // Generic containers require a text match, since YouTube reuses them
    // for unrelated dialogs too.
    const genericCandidates = document.querySelectorAll(ADBLOCK_GENERIC_DIALOG_SELECTOR);
    for (const el of genericCandidates) {
      if (ADBLOCK_WARNING_TEXT_PATTERN.test(el.textContent || '')) {
        return el;
      }
    }
    return null;
  }

  // Detects the "ad blockers are not allowed" warning and removes it (its
  // dialog wrapper if it's the dismissible modal shape, plus any leftover
  // modal backdrop; the element itself directly for the in-player
  // '#error-screen' shape - real-world open-source ad-block-warning
  // removers do exactly this and it's safe, since none of these elements
  // are the player's own <video> or a wrapper around it, they're
  // overlay/error UI alongside it). Returns { detected, removed }:
  //   - detected: a matching warning element was found at all.
  //   - removed: it was actually deleted from the page.
  // The one case detected can be true while removed is false is the
  // structural safety check below - if a match ever unexpectedly turns
  // out to contain our own player's <video> element, it's left alone
  // rather than risking taking the video down with it, and the caller
  // still falls through to the reload-recovery step.
  function removeAdblockWarning() {
    const warningEl = findAdblockWarningElement();
    if (!warningEl) return { detected: false, removed: false };

    if (warningEl.querySelector('video')) {
      return { detected: true, removed: false };
    }

    const modalContainer =
      warningEl.closest('ytd-popup-container') || warningEl.closest('tp-yt-paper-dialog');
    const toRemove = modalContainer || warningEl;
    toRemove.remove();

    // The dismissible dialog usually comes with a dark modal backdrop
    // that blocks clicks on the rest of the page; clear that out too.
    document
      .querySelectorAll('tp-yt-iron-overlay-backdrop, .ytd-popup-container[opened], #dialog[opened]')
      .forEach((el) => el.remove());
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    return { detected: true, removed: true };
  }

  function buildReloadTarget() {
    const video = getVideo();
    const seconds =
      video && isFinite(video.currentTime) ? Math.max(0, Math.floor(video.currentTime)) : 0;

    let target = location.href;
    try {
      const url = new URL(location.href);
      if (seconds > 0) url.searchParams.set('t', `${seconds}s`);
      target = url.toString();
    } catch (e) {
      // fall back to reloading the current URL as-is
    }
    return target;
  }

  // A persistent, clickable fallback for when auto-reload has given up
  // (cap hit) or simply hasn't run yet. Unlike the toast, this doesn't
  // disappear after 1.5s - it's what keeps a blocked player from ever
  // being a dead end with nothing on screen to click.
  function showStuckRecoveryButton() {
    const player = getPlayer();
    if (!player) return;
    let btn = document.getElementById('yt-ad-skipper-reload-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'yt-ad-skipper-reload-btn';
      btn.type = 'button';
      btn.textContent = '⟳ Playback blocked — click to reload';
      btn.addEventListener('click', () => {
        btn.remove();
        showToast('Reloading…');
        setTimeout(() => {
          location.href = buildReloadTarget();
        }, 300);
      });
      player.appendChild(btn);
    }
    btn.style.display = 'block';
  }

  function removeStuckRecoveryButton() {
    const btn = document.getElementById('yt-ad-skipper-reload-btn');
    if (btn) btn.remove();
  }

  // Logs enough state to actually debug a stuck-playback report instead of
  // guessing at it - player classes, video element state (readyState,
  // networkState, a real MediaError if one exists, whether it has a
  // source), and whether any known ad-block-warning selector matched.
  // Printed with console.warn so it's easy to spot in devtools if this
  // happens again.
  function diagnosePlaybackState(reason) {
    const player = getPlayer();
    const video = getVideo();
    const info = {
      reason,
      url: location.href,
      playerClasses: player ? Array.from(player.classList) : null,
      hasVideo: Boolean(video),
      videoPaused: video ? video.paused : null,
      videoReadyState: video ? video.readyState : null,
      videoNetworkState: video ? video.networkState : null,
      videoHasSource: video ? Boolean(video.currentSrc || video.getAttribute('src')) : null,
      videoError: video && video.error ? { code: video.error.code, message: video.error.message } : null,
      adblockWarningPresent: Boolean(findAdblockWarningElement()),
    };
    console.warn('[YT Ad Skipper] stuck playback detected -', info);
    return info;
  }

  // HTMLMediaElement.readyState: 0 = HAVE_NOTHING, 1 = HAVE_METADATA (this
  // is the one that matters here - the browser knows duration/dimensions
  // but has no actual frame data at the current position), 2 =
  // HAVE_CURRENT_DATA, 3 = HAVE_FUTURE_DATA, 4 = HAVE_ENOUGH_DATA. A
  // video stuck below HAVE_CURRENT_DATA has nothing to show on screen,
  // full stop - regardless of what .paused or .error say.
  const READY_STATE_HAVE_CURRENT_DATA = 2;

  // A confirmed real-world case (reported and diagnosed via the console
  // log this extension prints): a video can report paused === false and
  // error === null while genuinely stuck - readyState wedged at
  // HAVE_METADATA (1), never actually rendering a frame - and just stay
  // that way indefinitely. "Not paused and no error" was being trusted
  // here as proof of health; it isn't. Treat a video below
  // HAVE_CURRENT_DATA the same as paused/errored for this check.
  function looksHealthy(video) {
    return Boolean(video) && !video.paused && !video.error && video.readyState >= READY_STATE_HAVE_CURRENT_DATA;
  }

  // Shared by both the ad-block-warning path and the independent
  // stuck-playback watchdog below. Assumes the caller has already set
  // STATE.recoveryCheckPending = true (as the single in-flight guard);
  // this function is responsible for clearing it once it's done, whether
  // that's right away or after the follow-up check below.
  //
  // Wrapped in try/catch/finally throughout specifically so that
  // STATE.recoveryCheckPending can never get stuck permanently true if
  // something here throws unexpectedly (e.g. a page shape this extension
  // hasn't accounted for - Shorts and playlists have both turned up real
  // surprises). If that flag ever got stuck true, every recovery path in
  // this extension - the ad-block-warning one included - would silently
  // stop doing anything until the page was manually reloaded, which is
  // exactly indistinguishable from "the extension is disabled".
  function attemptPlaybackRecovery(reason) {
    let asyncFollowUpScheduled = false;
    try {
      diagnosePlaybackState(reason);
      const video = getVideo();
      if (!video) {
        reloadToRecoverPlayback();
        return;
      }
      if (looksHealthy(video)) {
        return;
      }
      // Try the light fix first: a plain video.play() resumes it
      // instantly, no reload/flicker needed, and covers the common case
      // where the player is simply paused rather than genuinely broken.
      // Only fall back to a full page reload if that doesn't actually
      // result in playback resuming shortly after.
      const playAttempt = video.play();
      if (playAttempt && typeof playAttempt.catch === 'function') {
        playAttempt.catch(() => {});
      }
      asyncFollowUpScheduled = true;
      setTimeout(() => {
        try {
          const v = getVideo();
          if (!looksHealthy(v)) {
            reloadToRecoverPlayback();
          }
        } catch (e) {
          console.error('[YT Ad Skipper] recovery follow-up check failed -', e);
        } finally {
          STATE.recoveryCheckPending = false;
        }
      }, 500);
    } catch (e) {
      console.error('[YT Ad Skipper] recovery attempt failed -', e);
    } finally {
      if (!asyncFollowUpScheduled) {
        STATE.recoveryCheckPending = false;
      }
    }
  }

  // For the stalled-playback watchdog specifically: unlike the paths
  // above, video.play() is skipped entirely. The video already reports
  // itself as "playing" (paused === false) - that's the whole reason this
  // is a stall and not just a pause - and calling .play() on an element
  // that already considers itself playing is a no-op in every major
  // browser; it can't unstick a wedged network fetch. Go straight to the
  // reload fallback, which is the only thing that's actually shown to fix
  // this. Fully synchronous, so a single try/finally is enough to
  // guarantee the in-flight guard always clears.
  function attemptStallRecovery() {
    try {
      diagnosePlaybackState('stalled-playback');
      reloadToRecoverPlayback();
    } catch (e) {
      console.error('[YT Ad Skipper] stall recovery failed -', e);
    } finally {
      STATE.recoveryCheckPending = false;
    }
  }

  // This is the fallback once a plain video.play() (tried by the caller
  // in tick()) hasn't resumed playback shortly after the warning was
  // handled - either it wasn't a simple pause, or there was no <video>
  // element to play at all. Reloading the page is the more forceful fix,
  // so this reloads at most MAX_AUTO_RELOADS_PER_VIDEO times per video
  // (tracked in sessionStorage, which survives the reload) to avoid
  // looping forever if YouTube re-triggers the block immediately again,
  // and preserves the current playback position via the `t=` parameter.
  //
  // The key always resolves to something real (falls back to the page
  // path when there's no video ID) specifically so the cap can never be
  // silently skipped - an earlier version used a null key in that case,
  // which always read back a count of 0 and reloaded without limit.
  //
  // Once the cap is hit, this stops reloading on its own - if YouTube
  // re-blocks every single reload, that's much more likely to mean a
  // real ad blocker is still active elsewhere in the browser (this
  // extension doesn't block ad requests, so it can't fix that) than a
  // one-off glitch - but it always leaves a clickable recovery button
  // behind so the user isn't just stuck looking at a dead player.
  function reloadToRecoverPlayback() {
    const videoId = getVideoId();
    const key = `ytAdSkipperReloadCount:${videoId || location.pathname}`;
    const count = Number(sessionStorage.getItem(key) || '0');

    if (count >= MAX_AUTO_RELOADS_PER_VIDEO) {
      showToast('Still blocked — click the button on the video to reload');
      showStuckRecoveryButton();
      return;
    }
    sessionStorage.setItem(key, String(count + 1));

    showToast('Ad-block warning detected — reloading…');
    setTimeout(() => {
      location.href = buildReloadTarget();
    }, 400);
  }

  function performSkip(trigger) {
    let skipped = clickSkipIfPresent();
    closeOverlayAdsIfPresent();
    if (!skipped) {
      skipped = fastForwardAd();
    }
    if (skipped) {
      STATE.sessionSkipCount += 1;
      chrome.runtime.sendMessage({
        type: 'AD_SKIPPED',
        sessionCount: STATE.sessionSkipCount,
        entry: {
          ts: Date.now(),
          title: getVideoTitle(),
          url: location.href,
          videoId: getVideoId(),
          trigger,
        },
      });
      showToast('Ad skipped');
    }
    return skipped;
  }

  function showToast(text) {
    let toast = document.getElementById('yt-ad-skipper-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'yt-ad-skipper-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('yt-ad-skipper-toast-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('yt-ad-skipper-toast-visible');
    }, 1500);
  }

  function updateManualPrompt(adShowing) {
    let prompt = document.getElementById('yt-ad-skipper-manual-btn');
    const player = getPlayer();
    if (adShowing && player) {
      if (!prompt) {
        prompt = document.createElement('button');
        prompt.id = 'yt-ad-skipper-manual-btn';
        prompt.textContent = '⏭ Skip Ad';
        prompt.addEventListener('click', () => performSkip('manual'));
        player.appendChild(prompt);
      }
      prompt.style.display = 'block';
    } else if (prompt) {
      prompt.style.display = 'none';
    }
  }

  function removeManualPrompt() {
    const prompt = document.getElementById('yt-ad-skipper-manual-btn');
    if (prompt) prompt.remove();
  }

  // The whole body is wrapped in try/catch: this runs on every 300ms
  // interval tick and every player class mutation, so an unhandled
  // exception here on one call must never be allowed to look like "the
  // extension stopped working" - the interval keeps calling tick() every
  // 300ms regardless, but a real bug that throws on every single
  // invocation from some point forward (a page shape this extension
  // hasn't accounted for, same as the Shorts/playlist surprises already
  // found) would otherwise silently disable everything downstream of
  // wherever it throws, with nothing but a manual reload to clear it.
  function tick() {
    try {
      tickBody();
    } catch (e) {
      console.error('[YT Ad Skipper] tick() failed -', e);
    }
  }

  function tickBody() {
    const adShowing = isAdShowing();

    if (adShowing) {
      if (STATE.muteDuringAds) muteForAd();

      if (STATE.autoSkip) {
        performSkip('auto');
      } else {
        updateManualPrompt(true);
      }
    } else {
      unmuteAfterAd();
      if (!STATE.autoSkip) updateManualPrompt(false);
    }

    // Only touch ad-block-warning handling on an actual watch/shorts/embed
    // page (real player present AND a resolvable video ID) - never on the
    // homepage, search, or channel pages, which have their own unrelated
    // dialogs (cookie/consent prompts especially) that must never be
    // mistaken for this.
    const onWatchLikePage = Boolean(getPlayer() && getVideoId());
    if (STATE.hideAdblockWarning && onWatchLikePage) {
      const result = removeAdblockWarning();
      if (result.removed) {
        showToast('Removed YouTube ad-block warning');
      }
      if (result.detected && STATE.autoReloadOnBlock && !STATE.recoveryCheckPending) {
        // Only ever have one recovery check in flight. Without this, a
        // warning that keeps re-matching tick after tick (e.g. the
        // structural-safety case where we deliberately didn't remove it)
        // would schedule its own check every 300ms, stacking up several
        // reload attempts - and burning through the reload cap - before
        // the first one even navigates away.
        STATE.recoveryCheckPending = true;
        // Give YouTube's own pause a moment to actually apply before
        // checking whether playback is stuck.
        setTimeout(() => attemptPlaybackRecovery('adblock-warning'), 800);
      }

      // Independent of whether the warning is still visibly present on
      // *this* tick - it may already be gone, either because we just
      // deleted it ourselves or because it cleared on its own - a
      // stuck-recovery button that's currently showing should only be
      // cleared once the video is actually confirmed playing again.
      // Clearing it just because "detected" happened to be false this
      // tick would hide it the instant a removed warning makes the
      // element disappear, even though the reload cap was hit and the
      // underlying block was never fixed.
      if (document.getElementById('yt-ad-skipper-reload-btn')) {
        if (looksHealthy(getVideo())) {
          removeStuckRecoveryButton();
        }
      }
    } else {
      removeStuckRecoveryButton();
    }

    // Independent watchdog, decoupled entirely from ad-block-warning
    // detection above: catches playback that's stuck for reasons that
    // have nothing to do with that specific warning UI - a genuine media
    // error, or the <video> element being missing outright for a
    // sustained stretch. Both are signals the browser/player only sets
    // when something is actually broken (video.error is never set just
    // because the user paused), so this can't misfire on a normal manual
    // pause, and it isn't gated on any selector matching first - it's
    // the fallback for whenever this extension's guess at *why* playback
    // is stuck turns out to be wrong.
    if (onWatchLikePage) {
      const watchdogVideo = getVideo();
      if (!watchdogVideo || watchdogVideo.error) {
        stuckPlaybackStreak += 1;
      } else {
        stuckPlaybackStreak = 0;
      }
      if (
        stuckPlaybackStreak >= STUCK_PLAYBACK_STREAK_THRESHOLD &&
        STATE.autoReloadOnBlock &&
        !STATE.recoveryCheckPending
      ) {
        STATE.recoveryCheckPending = true;
        attemptPlaybackRecovery(watchdogVideo && watchdogVideo.error ? 'media-error' : 'missing-video');
      }

      // A third, separate watchdog: catches a video that reports itself
      // as playing (paused === false, error === null - passing both
      // checks above) while never actually making progress. Confirmed
      // via a real diagnostic log from this extension: readyState wedged
      // at HAVE_METADATA, currentTime frozen, indefinitely - a real
      // buffering stall that never resolves into either "paused" or
      // "errored". Sampled at most once a second (not once a tick) so
      // MutationObserver-triggered extra ticks can't shrink the effective
      // window; only the video actually failing to advance across real
      // wall-clock time counts.
      if (watchdogVideo && !watchdogVideo.paused && !watchdogVideo.error) {
        const now = Date.now();
        if (now - lastStallSampleTime >= STALL_SAMPLE_INTERVAL_MS) {
          if (lastStallSampleCurrentTime >= 0 && Math.abs(watchdogVideo.currentTime - lastStallSampleCurrentTime) < 0.15) {
            stalledSeconds += (now - lastStallSampleTime) / 1000;
          } else {
            stalledSeconds = 0;
          }
          lastStallSampleCurrentTime = watchdogVideo.currentTime;
          lastStallSampleTime = now;
        }
      } else {
        stalledSeconds = 0;
        lastStallSampleCurrentTime = -1;
        lastStallSampleTime = 0;
      }

      if (
        stalledSeconds >= STALLED_SECONDS_THRESHOLD &&
        STATE.autoReloadOnBlock &&
        !STATE.recoveryCheckPending
      ) {
        STATE.recoveryCheckPending = true;
        stalledSeconds = 0;
        attemptStallRecovery();
      }
    } else {
      stuckPlaybackStreak = 0;
      stalledSeconds = 0;
      lastStallSampleCurrentTime = -1;
      lastStallSampleTime = 0;
    }
  }

  // Consecutive-tick counter for the independent stuck-playback watchdog
  // in tick() - see STUCK_PLAYBACK_STREAK_THRESHOLD above.
  let stuckPlaybackStreak = 0;

  // State for the stalled-playback watchdog in tick() - see
  // STALLED_SECONDS_THRESHOLD above.
  let stalledSeconds = 0;
  let lastStallSampleCurrentTime = -1;
  let lastStallSampleTime = 0;

  // MutationObserver on the player catches class changes (ad start/end)
  // as they happen; a low-frequency interval is a safety net because
  // YouTube's SPA transitions don't always mutate the node we're watching.
  let observedPlayer = null;
  let playerObserver = null;
  function attachObserver() {
    const player = getPlayer();
    if (!player || player === observedPlayer) return;
    // Disconnect the previous observer before attaching a new one -
    // without this, switching between watch pages, Shorts, and back
    // (each a different player element) left every earlier observer
    // still attached to its now-stale node instead of being torn down,
    // and if a stale node keeps receiving mutations for any reason, its
    // leaked observer keeps calling tick() indefinitely alongside the
    // current one.
    if (playerObserver) playerObserver.disconnect();
    observedPlayer = player;
    playerObserver = new MutationObserver(() => tick());
    playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  setInterval(() => {
    attachObserver();
    tick();
  }, 300);

  // YouTube fires this custom event on SPA navigations between videos.
  document.addEventListener('yt-navigate-finish', () => {
    observedPlayer = null;
    removeManualPrompt();
    removeStuckRecoveryButton();
    STATE.recoveryCheckPending = false;
    stuckPlaybackStreak = 0;
    stalledSeconds = 0;
    lastStallSampleCurrentTime = -1;
    lastStallSampleTime = 0;
    setTimeout(attachObserver, 500);
  });

  attachObserver();
})();
