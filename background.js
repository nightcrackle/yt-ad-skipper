/**
 * Background service worker.
 *
 * Responsibilities:
 *  - Tracks a running "total ads skipped" lifetime counter (not affected
 *    by log rotation/clearing) and reflects the current tab's session
 *    count on the toolbar badge.
 *  - Maintains the ad-skip log (`adSkipLogs` in chrome.storage.local):
 *    appends an entry per skip, then houses-keeps it by rotating out the
 *    oldest entries once the configured `maxLogEntries` cap (stored in
 *    chrome.storage.sync, editable from the options page) is exceeded.
 *  - All storage writes go through a single serialized queue so that
 *    skips reported from multiple YouTube tabs at nearly the same time
 *    can't race each other and silently drop a log entry.
 */

const DEFAULT_MAX_LOG_ENTRIES = 200;
const MIN_MAX_LOG_ENTRIES = 10;
const MAX_MAX_LOG_ENTRIES = 5000;

function storageGet(area, defaults) {
  return new Promise((resolve) => chrome.storage[area].get(defaults, resolve));
}

function storageSet(area, items) {
  return new Promise((resolve) => chrome.storage[area].set(items, resolve));
}

function clamp(n, min, max) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num)) return DEFAULT_MAX_LOG_ENTRIES;
  return Math.min(max, Math.max(min, num));
}

// Serializes all storage read-modify-write operations below so concurrent
// AD_SKIPPED messages (e.g. two YouTube tabs skipping ads at once) apply
// one after another instead of both reading stale data and clobbering
// each other's write.
let writeQueue = Promise.resolve();
function enqueue(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    const local = await storageGet('local', { totalSkipped: 0, adSkipLogs: [] });
    const patch = {};
    if (typeof local.totalSkipped !== 'number') patch.totalSkipped = 0;
    if (!Array.isArray(local.adSkipLogs)) patch.adSkipLogs = [];
    if (Object.keys(patch).length) await storageSet('local', patch);

    const sync = await storageGet('sync', { maxLogEntries: DEFAULT_MAX_LOG_ENTRIES });
    if (typeof sync.maxLogEntries !== 'number') {
      await storageSet('sync', { maxLogEntries: DEFAULT_MAX_LOG_ENTRIES });
    }
  });
});

async function appendLogEntry(entry) {
  const { adSkipLogs } = await storageGet('local', { adSkipLogs: [] });
  const { maxLogEntries } = await storageGet('sync', { maxLogEntries: DEFAULT_MAX_LOG_ENTRIES });
  const cap = clamp(maxLogEntries, MIN_MAX_LOG_ENTRIES, MAX_MAX_LOG_ENTRIES);

  const next = Array.isArray(adSkipLogs) ? adSkipLogs.slice() : [];
  next.push({
    id: `${entry.ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts: entry.ts,
    title: entry.title,
    url: entry.url,
    videoId: entry.videoId || null,
    trigger: entry.trigger === 'manual' ? 'manual' : 'auto',
  });

  // Housekeeping: rotate oldest-first once the configured cap is exceeded.
  const rotated = next.length > cap ? next.slice(next.length - cap) : next;
  await storageSet('local', { adSkipLogs: rotated });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'AD_SKIPPED') {
    enqueue(async () => {
      const { totalSkipped } = await storageGet('local', { totalSkipped: 0 });
      await storageSet('local', { totalSkipped: totalSkipped + 1 });
      if (message.entry) await appendLogEntry(message.entry);
    });

    if (sender.tab?.id) {
      chrome.action.setBadgeText({
        tabId: sender.tab.id,
        text: String(message.sessionCount),
      });
      chrome.action.setBadgeBackgroundColor({
        tabId: sender.tab.id,
        color: '#CC0000',
      });
    }
  } else if (message?.type === 'CLEAR_LOGS') {
    enqueue(async () => {
      await storageSet('local', { adSkipLogs: [] });
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
