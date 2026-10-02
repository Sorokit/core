chrome.devtools.panels.create(
  "sorokit",
  "icons/icon48.png",
  "panel.html",
  () => {
    // Panel registered; nothing else to do here. panel.js owns the port
    // connection to background.js once the panel document itself loads.
  },
);
