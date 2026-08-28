const DEFAULT_MAX_LOG_ENTRIES = 200;
const MIN_MAX_LOG_ENTRIES = 10;
const MAX_MAX_LOG_ENTRIES = 5000;

const autoSkipEl = document.getElementById('autoSkip');
const muteDuringAdsEl = document.getElementById('muteDuringAds');
const hideAdblockWarningEl = document.getElementById('hideAdblockWarning');
const autoReloadOnBlockEl = document.getElementById('autoReloadOnBlock');
const maxLogEntriesEl = document.getElementById('maxLogEntries');
const usageLineEl = document.getElementById('usageLine');
const clearLogsBtn = document.getElementById('clearLogs');
const savedNoteEl = document.getElementById('savedNote');
const logsBodyEl = document.getElementById('logsBody');
const logCountEl = document.getElementById('logCount');
const emptyStateEl = document.getElementById('emptyState');
const logsTableEl = document.getElementById('logsTable');

function flashSaved() {
  savedNoteEl.textContent = 'Saved';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => {
    savedNoteEl.textContent = '';
  }, 1200);
}

function loadSettings() {
  chrome.storage.sync.get(
    {
      autoSkip: true,
      muteDuringAds: true,
      hideAdblockWarning: true,
      autoReloadOnBlock: true,
      maxLogEntries: DEFAULT_MAX_LOG_ENTRIES,
    },
    (items) => {
      autoSkipEl.checked = items.autoSkip;
      muteDuringAdsEl.checked = items.muteDuringAds;
      hideAdblockWarningEl.checked = items.hideAdblockWarning;
      autoReloadOnBlockEl.checked = items.autoReloadOnBlock;
      maxLogEntriesEl.value = items.maxLogEntries;
    }
  );
}

autoSkipEl.addEventListener('change', () => {
  chrome.storage.sync.set({ autoSkip: autoSkipEl.checked }, flashSaved);
});

muteDuringAdsEl.addEventListener('change', () => {
  chrome.storage.sync.set({ muteDuringAds: muteDuringAdsEl.checked }, flashSaved);
});

hideAdblockWarningEl.addEventListener('change', () => {
  chrome.storage.sync.set({ hideAdblockWarning: hideAdblockWarningEl.checked }, flashSaved);
});

autoReloadOnBlockEl.addEventListener('change', () => {
  chrome.storage.sync.set({ autoReloadOnBlock: autoReloadOnBlockEl.checked }, flashSaved);
});

maxLogEntriesEl.addEventListener('change', () => {
  let val = Math.round(Number(maxLogEntriesEl.value));
  if (!Number.isFinite(val)) val = DEFAULT_MAX_LOG_ENTRIES;
  val = Math.min(MAX_MAX_LOG_ENTRIES, Math.max(MIN_MAX_LOG_ENTRIES, val));
  maxLogEntriesEl.value = val;
  chrome.storage.sync.set({ maxLogEntries: val }, () => {
    flashSaved();
    // The new cap is enforced by the background worker the next time an
    // entry is appended; existing stored entries aren't retroactively
    // trimmed here, so this just re-renders with the current data.
    renderLogs();
  });
});

clearLogsBtn.addEventListener('click', () => {
  if (!confirm('Clear all ad-skip logs? This cannot be undone.')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
});

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

function renderLogs() {
  chrome.storage.local.get({ adSkipLogs: [] }, (items) => {
    const logs = Array.isArray(items.adSkipLogs) ? items.adSkipLogs.slice().reverse() : [];
    logCountEl.textContent = logs.length ? `(${logs.length})` : '';
    logsBodyEl.innerHTML = '';

    if (logs.length === 0) {
      logsTableEl.style.display = 'none';
      emptyStateEl.style.display = 'block';
      return;
    }
    logsTableEl.style.display = '';
    emptyStateEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    for (const entry of logs) {
      const tr = document.createElement('tr');

      const tdTime = document.createElement('td');
      tdTime.textContent = formatTime(entry.ts);
      tr.appendChild(tdTime);

      const tdTrigger = document.createElement('td');
      const badge = document.createElement('span');
      const trigger = entry.trigger === 'manual' ? 'manual' : 'auto';
      badge.className = `trigger-badge trigger-${trigger}`;
      badge.textContent = trigger;
      tdTrigger.appendChild(badge);
      tr.appendChild(tdTrigger);

      const tdVideo = document.createElement('td');
      const link = document.createElement('a');
      link.href = entry.url || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.title || entry.url || 'Unknown video';
      tdVideo.appendChild(link);
      tr.appendChild(tdVideo);

      frag.appendChild(tr);
    }
    logsBodyEl.appendChild(frag);
  });
}

function renderUsage() {
  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const kb = (bytes / 1024).toFixed(1);
    chrome.storage.local.get({ adSkipLogs: [] }, (items) => {
      const count = Array.isArray(items.adSkipLogs) ? items.adSkipLogs.length : 0;
      usageLineEl.textContent =
        `${count} log entr${count === 1 ? 'y' : 'ies'} stored · ~${kb} KB of local storage used`;
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.adSkipLogs) {
    renderLogs();
    renderUsage();
  }
});

loadSettings();
renderLogs();
renderUsage();
