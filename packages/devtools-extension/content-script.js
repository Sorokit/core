// Isolated-world content script: injects page-hook.js into the page's own
// JS context, then relays the postMessage bridge it sets up to the
// extension's background service worker, tagged with this tab's id.
(function () {
  const RELAY_MESSAGE_SOURCE = "sorokit-devtools-page-hook";

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener("load", () => script.remove());

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== RELAY_MESSAGE_SOURCE) return;

    chrome.runtime.sendMessage({
      type: "sorokit-devtools-record",
      detail: data.detail,
    });
  });
})();
