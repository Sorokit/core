// Runs in the page's own JS context (injected by content-script.js), so it
// can see the CustomEvent dispatched by `enableDevtoolsBridge()` in
// sorokit-core. Content scripts run in an isolated world and cannot listen
// to page-dispatched CustomEvents directly in Manifest V3, so this script
// re-emits each record as a window.postMessage, which IS visible across the
// isolated/page world boundary.
(function () {
  const EVENT_NAME = "sorokit:devtools";
  const RELAY_MESSAGE_SOURCE = "sorokit-devtools-page-hook";

  window.addEventListener(EVENT_NAME, (event) => {
    window.postMessage(
      {
        source: RELAY_MESSAGE_SOURCE,
        detail: event.detail,
      },
      "*",
    );
  });
})();
