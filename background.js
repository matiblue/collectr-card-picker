// Clicking the toolbar icon toggles the picker panel on the current Collectr tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'cpp-toggle-panel' }).catch(() => {});
});
