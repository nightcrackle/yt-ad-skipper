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
 * Separately, this also reacts to YouTube's ad-blocker *enforcement* UI
 * (the "Ad blockers are not allowed on YouTube" dialog, and the playback
 * block that follows if it's ignored):
 *   1. When the dialog/overlay is detected, it's removed from the page.
 *   2. If the video is left paused/stuck afterward, the page is reloaded
 *      once or twice (capped, to avoid a reload loop), preserving your
 *      playback position via the `t=` URL parameter, since removing the
 *      dialog alone doesn't resume a player YouTube has already paused.
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
  // enforcement dialog/error screen. These drift over time, so
  // findAdblockWarningElement() also falls back to a text-content scan.
  const ADBLOCK_WARNING_SELECTORS = [
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    'ytd-popup-container tp-yt-paper-dialog',
  ];

  // Phrases YouTube's enforcement dialog is known to use. Matched against
  // element text as a fallback when the selectors above miss (e.g. after a
  // YouTube markup change), and used defensively so we don't remove some
  // unrelated dialog that happens to match a class name.
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
    for (const sel of ADBLOCK_WARNING_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Fallback: scan dialog-like elements for known warning phrasing, in
    // case YouTube renamed the containers above.
    const candidates = document.querySelectorAll(
      'tp-yt-paper-dialog, ytd-popup-container, [role="dialog"], ytd-enforcement-message-view-model'
    );
    for (const el of candidates) {
      if (ADBLOCK_WARNING_TEXT_PATTERN.test(el.textContent || '')) {
        return el;
      }
    }
    return null;
  }

  // Removes the "ad blockers are not allowed" dialog/error screen (banner
  // #1 in the feature description) and any leftover modal backdrop it
  // leaves behind. Returns true if something was found and removed.
  function removeAdblockWarning() {
    const warningEl = findAdblockWarningElement();
    if (!warningEl) return false;

    const container =
      warningEl.closest('ytd-popup-container') ||
      warningEl.closest('tp-yt-paper-dialog') ||
      warningEl;
    container.remove();

    // The dialog usually comes with a dark modal backdrop that blocks
    // clicks on the rest of the page; clear that out too.
    document
      .querySelectorAll('tp-yt-iron-overlay-backdrop, .ytd-popup-container[opened], #dialog[opened]')
      .forEach((el) => el.remove());
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    return true;
  }

  // Removing the dialog doesn't by itself resume a video YouTube has
  // already paused for this reason (banner #2 in the feature description:
  // the block that stops the video). The reliable fix is reloading the
  // page, so this reloads at most MAX_AUTO_RELOADS_PER_VIDEO times per
  // video (tracked in sessionStorage, which survives the reload) to avoid
  // looping forever if YouTube re-triggers the block immediately again,
  // and preserves the current playback position via the `t=` parameter.
  function reloadToRecoverPlayback() {
    const videoId = getVideoId();
    const key = videoId ? `ytAdSkipperReloadCount:${videoId}` : null;
    const count = key ? Number(sessionStorage.getItem(key) || '0') : 0;

    if (count >= MAX_AUTO_RELOADS_PER_VIDEO) {
      showToast('Still blocked — try reloading manually');
      return;
    }
    if (key) sessionStorage.setItem(key, String(count + 1));

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

    showToast('Ad-block warning detected — reloading…');
    setTimeout(() => {
      location.href = target;
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

    if (STATE.hideAdblockWarning) {
      const removed = removeAdblockWarning();
      if (removed) {
        showToast('Removed YouTube ad-block warning');
        if (STATE.autoReloadOnBlock) {
          // Give YouTube's own pause a moment to actually apply before
          // checking whether playback is stuck.
          setTimeout(() => {
            const video = getVideo();
            if (video && video.paused) {
              reloadToRecoverPlayback();
            }
          }, 800);
        }
      }
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
    setTimeout(attachObserver, 500);
  });

  attachObserver();
})();
