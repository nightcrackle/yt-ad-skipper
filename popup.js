const autoSkipEl = document.getElementById('autoSkip');
const muteDuringAdsEl = document.getElementById('muteDuringAds');
const totalSkippedEl = document.getElementById('totalSkipped');
const resetStatsBtn = document.getElementById('resetStats');
const openOptionsBtn = document.getElementById('openOptions');

function loadUI() {
  chrome.storage.sync.get({ autoSkip: true, muteDuringAds: true }, (items) => {
    autoSkipEl.checked = items.autoSkip;
    muteDuringAdsEl.checked = items.muteDuringAds;
  });
  chrome.storage.local.get({ totalSkipped: 0 }, (items) => {
    totalSkippedEl.textContent = items.totalSkipped;
  });
}

autoSkipEl.addEventListener('change', () => {
  chrome.storage.sync.set({ autoSkip: autoSkipEl.checked });
});

muteDuringAdsEl.addEventListener('change', () => {
  chrome.storage.sync.set({ muteDuringAds: muteDuringAdsEl.checked });
});

resetStatsBtn.addEventListener('click', () => {
  chrome.storage.local.set({ totalSkipped: 0 }, () => {
    totalSkippedEl.textContent = '0';
  });
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.totalSkipped) {
    totalSkippedEl.textContent = changes.totalSkipped.newValue;
  }
});

loadUI();
