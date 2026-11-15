// Clicking the toolbar icon toggles the picker panel on the current Collectr tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'cpp-toggle-panel' }).catch(() => {});
});

// The content script reports how many "needed" cards are on the page; show it on the icon.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || msg?.type !== 'cpp-badge') return;
  const n = Math.max(0, Math.min(999, parseInt(msg.count, 10) || 0));
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#f59e0b' });
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n) : '' });
});
