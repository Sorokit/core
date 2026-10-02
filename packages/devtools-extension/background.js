// Background service worker: routes records from a tab's content script to
// that tab's open DevTools panel, if any. Ports are keyed by tab id because
// a content script's sender.tab.id tells us which tab a record came from,
// but the record itself carries no tab identity.
const panelPortsByTabId = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sorokit-devtools-panel") return;

  let connectedTabId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === "init" && typeof message.tabId === "number") {
      connectedTabId = message.tabId;
      panelPortsByTabId.set(connectedTabId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (connectedTabId !== null && panelPortsByTabId.get(connectedTabId) === port) {
      panelPortsByTabId.delete(connectedTabId);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "sorokit-devtools-record") return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  const port = panelPortsByTabId.get(tabId);
  if (port) {
    port.postMessage({ type: "sorokit-devtools-record", detail: message.detail });
  }
});
