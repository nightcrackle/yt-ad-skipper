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
 */

(() => {
  const STATE = {
    autoSkip: true,
    muteDuringAds: true,
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

  function loadSettings() {
    chrome.storage.sync.get(
      { autoSkip: true, muteDuringAds: true },
      (items) => {
        STATE.autoSkip = items.autoSkip;
        STATE.muteDuringAds = items.muteDuringAds;
      }
    );
  }
  loadSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('autoSkip' in changes) STATE.autoSkip = changes.autoSkip.newValue;
    if ('muteDuringAds' in changes) STATE.muteDuringAds = changes.muteDuringAds.newValue;
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
