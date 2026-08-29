/**
 * YouTube Ad Skipper - content script
 *
 * How ad detection works:
 * YouTube's player container (`.html5-video-player` / `#movie_player`) gets
 * the class `ad-showing` (and often `ad-interrupting`) added while any ad
 * is playing, and removed the moment it ends. We watch for that with a
 * MutationObserver plus a low-frequency polling fallback (YouTube's SPA
 * navigation doesn't always fire clean DOM events).
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
 * YouTube shows this in (at least) two different shapes:
 *   1. A dismissible dialog ("Ad blockers are not allowed on YouTube"),
 *      wrapped in its generic popup/dialog containers. This one is safe
 *      to delete outright - it's genuinely just a modal on top of a
 *      player that's fine underneath.
 *   2. A harder in-player block, where the same kind of warning text is
 *      rendered directly inside the player area itself (not wrapped in a
 *      dialog container) and the video is stopped or never starts. We do
 *      NOT delete that variant's element - it isn't a disposable overlay,
 *      and deleting it risks eating real player structure. Instead we
 *      detect it and go straight to the recovery step below.
 * In both cases, if the video is left missing/paused/stuck, the page is
 * reloaded once or twice (capped, to avoid a reload loop), preserving
 * your playback position via the `t=` URL parameter. If the cap is hit
 * and the block is still there, auto-reloading stops (it's more likely a
 * real, still-active ad blocker elsewhere in the browser than a one-off
 * glitch at that point) but a persistent, clickable "reload" button is
 * left on the player - a fading toast alone would leave a genuinely dead,
 * unclickable player area with no visible way to recover.
 * Both are independently toggleable in settings. This is a more direct
 * point of conflict with YouTube's own enforcement than ad-skipping is,
 * it depends on YouTube's current markup/text just like the skip logic
 * above, and YouTube can change or strengthen this mechanism at any time.
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

  // Known containers YouTube has used for the "ad blockers are not allowed"
  // enforcement dialog/error screen, plus generic dialog/popup containers
  // as a fallback for when YouTube renames things. IMPORTANT: none of
  // these are matched on their own - see findAdblockWarningElement().
  // 'ytd-popup-container' and 'tp-yt-paper-dialog' in particular are
  // YouTube's *generic* popup/dialog containers, used for all sorts of
  // unrelated dialogs (cookie/consent prompts, sign-in nudges, "continue
  // watching?", etc.) - matching those by tag name alone previously
  // caused this extension to delete an unrelated first-visit dialog and
  // then reload the page thinking it had hit an ad-block block, which
  // could repeat indefinitely. Every candidate here must also match
  // ADBLOCK_WARNING_TEXT_PATTERN before being treated as the warning.
  const ADBLOCK_WARNING_CANDIDATE_SELECTOR = [
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    'tp-yt-paper-dialog',
    'ytd-popup-container',
    '[role="dialog"]',
  ].join(', ');

  // Phrases YouTube's enforcement dialog is known to use. Every candidate
  // element found above must match this before we treat it as the
  // ad-block warning - this is what keeps unrelated dialogs safe.
  const ADBLOCK_WARNING_TEXT_PATTERN =
    /ad ?blockers? (are|is) not allowed|please (disable|turn off) (your )?ad ?blocker|allow youtube ads/i;

  const MAX_AUTO_RELOADS_PER_VIDEO = 2;

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

  function getPlayer() {
    return document.querySelector('.html5-video-player');
  }

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
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

  function fastForwardAd() {
    const video = getVideo();
    if (video && isFinite(video.duration) && video.duration > 0) {
      // Jumping to (just before) the end signals "ad finished" to the player
      // without leaving a visible seek bar jump on the *content* video later.
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
    const candidates = document.querySelectorAll(ADBLOCK_WARNING_CANDIDATE_SELECTOR);
    for (const el of candidates) {
      if (ADBLOCK_WARNING_TEXT_PATTERN.test(el.textContent || '')) {
        return el;
      }
    }
    return null;
  }

  // Detects the "ad blockers are not allowed" warning and, only when it's
  // a genuine dismissible dialog, removes it (plus any leftover modal
  // backdrop). Returns { detected, removedModal }:
  //   - detected: a matching warning element was found at all, whichever
  //     shape it was in.
  //   - removedModal: it was wrapped in a real dialog/popup container and
  //     that container was deleted.
  // When detected is true but removedModal is false, the warning is the
  // in-player block variant (see file header) - its element is left in
  // the DOM untouched, and the caller falls through to the reload-recovery
  // step instead of trying to delete player-area content.
  function removeAdblockWarning() {
    const warningEl = findAdblockWarningElement();
    if (!warningEl) return { detected: false, removedModal: false };

    const modalContainer =
      warningEl.closest('ytd-popup-container') || warningEl.closest('tp-yt-paper-dialog');

    if (!modalContainer) {
      return { detected: true, removedModal: false };
    }

    modalContainer.remove();

    // The dialog usually comes with a dark modal backdrop that blocks
    // clicks on the rest of the page; clear that out too.
    document
      .querySelectorAll('tp-yt-iron-overlay-backdrop, .ytd-popup-container[opened], #dialog[opened]')
      .forEach((el) => el.remove());
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    return { detected: true, removedModal: true };
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

  // Removing (or, for the in-player variant, merely detecting) the
  // warning doesn't by itself resume a video YouTube has already stopped
  // for this reason. The reliable fix is reloading the page, so this
  // reloads at most MAX_AUTO_RELOADS_PER_VIDEO times per video (tracked
  // in sessionStorage, which survives the reload) to avoid looping
  // forever if YouTube re-triggers the block immediately again, and
  // preserves the current playback position via the `t=` parameter.
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

  function tick() {
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
      if (result.removedModal) {
        showToast('Removed YouTube ad-block warning');
      }
      if (result.detected && STATE.autoReloadOnBlock && !STATE.recoveryCheckPending) {
        // Only ever have one recovery check in flight. Without this, the
        // in-player warning variant (which we deliberately don't delete,
        // see removeAdblockWarning()) would still match on every 300ms
        // tick and each one would schedule its own check, stacking up
        // several reload attempts - and burning through the reload cap -
        // before the first reload even navigates away.
        STATE.recoveryCheckPending = true;
        // Give YouTube's own pause a moment to actually apply before
        // checking whether playback is stuck.
        setTimeout(() => {
          STATE.recoveryCheckPending = false;
          const video = getVideo();
          // A missing video element counts as stuck too, not just a
          // paused one - the in-player block variant can leave the
          // player with no <video> at all once its warning text is the
          // only thing on screen, and that's just as unrecoverable
          // without a reload as a paused one.
          if (!video || video.paused) {
            reloadToRecoverPlayback();
          }
        }, 800);
      }

      // Independent of whether the warning is still visibly present on
      // *this* tick - it may already be gone, either because we just
      // deleted the modal ourselves or because the in-player variant
      // cleared on its own - a stuck-recovery button that's currently
      // showing should only be cleared once the video is actually
      // confirmed playing again. Clearing it just because "detected"
      // happened to be false this tick would hide it the instant a
      // removed modal makes the warning element disappear, even though
      // the reload cap was hit and the underlying block was never fixed.
      if (document.getElementById('yt-ad-skipper-reload-btn')) {
        const video = getVideo();
        if (video && !video.paused) {
          removeStuckRecoveryButton();
        }
      }
    } else {
      removeStuckRecoveryButton();
    }
  }

  // MutationObserver on the player catches class changes (ad start/end)
  // as they happen; a low-frequency interval is a safety net because
  // YouTube's SPA transitions don't always mutate the node we're watching.
  let observedPlayer = null;
  function attachObserver() {
    const player = getPlayer();
    if (!player || player === observedPlayer) return;
    observedPlayer = player;
    const observer = new MutationObserver(() => tick());
    observer.observe(player, { attributes: true, attributeFilter: ['class'] });
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
    setTimeout(attachObserver, 500);
  });

  attachObserver();
})();
