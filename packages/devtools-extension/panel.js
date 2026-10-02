// Panel logic: connects to background.js for this inspected tab, receives
// forwarded sorokit-core log records, and renders a timeline + detail view.
//
// Each SDK operation produces two records from withLogging() in
// src/shared/logger.ts: one with context.status === "start", and a matching
// completion record (context.status === "ok" or "error") with the same
// context.operation name. We pair them by (operation, nearest unmatched
// start) to compute a duration, since records don't carry a shared call id.

const events = [];
let selectedSeq = null;
let paused = false;

const timelineEl = document.getElementById("timeline");
const detailsEl = document.getElementById("details");
const countEl = document.getElementById("count");
const filterEl = document.getElementById("filter");
const pauseEl = document.getElementById("pause");
const clearEl = document.getElementById("clear");

const pendingStarts = new Map(); // operation -> array of { seq, timestamp }

function pairWithStart(operation, timestamp) {
  const stack = pendingStarts.get(operation);
  if (!stack || stack.length === 0) return null;
  const start = stack.shift();
  return new Date(timestamp).getTime() - new Date(start.timestamp).getTime();
}

function statusOf(record) {
  const status = record.context?.status;
  if (status === "start" || status === "ok" || status === "error") return status;
  // Fallback for records logged outside withLogging (no explicit status).
  return record.level === "error" ? "error" : "ok";
}

function operationOf(record) {
  return (
    (typeof record.context?.operation === "string" && record.context.operation) ||
    record.module ||
    record.message
  );
}

function handleRecord(detail) {
  const { seq, record } = detail;
  const status = statusOf(record);
  const operation = operationOf(record);

  let durationMs = null;
  if (status === "start") {
    const stack = pendingStarts.get(operation) ?? [];
    stack.push({ seq, timestamp: record.timestamp });
    pendingStarts.set(operation, stack);
  } else {
    durationMs = pairWithStart(operation, record.timestamp);
  }

  events.push({ seq, record, status, operation, durationMs });
  if (!paused) render();
}

function matchesFilter(event, query) {
  if (!query) return true;
  const haystack = `${event.operation} ${event.record.module} ${event.record.context?.errorCode ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function render() {
  const query = filterEl.value.trim();
  const visible = events.filter((e) => matchesFilter(e, query));
  countEl.textContent = `${visible.length} event${visible.length === 1 ? "" : "s"}`;

  timelineEl.innerHTML = "";
  for (const event of visible) {
    const li = document.createElement("li");
    li.dataset.seq = String(event.seq);
    if (event.seq === selectedSeq) li.classList.add("selected");

    const badge = document.createElement("span");
    badge.className = `badge ${event.status}`;
    badge.textContent = event.status;

    const label = document.createElement("span");
    label.textContent = event.operation;

    li.appendChild(badge);
    li.appendChild(label);

    if (event.durationMs !== null) {
      const duration = document.createElement("span");
      duration.className = "duration";
      duration.textContent = `${event.durationMs}ms`;
      li.appendChild(duration);
    }

    li.addEventListener("click", () => {
      selectedSeq = event.seq;
      showDetails(event);
      render();
    });

    timelineEl.appendChild(li);
  }
}

function showDetails(event) {
  const { record, durationMs } = event;
  const lines = [
    `operation: ${event.operation}`,
    `status:    ${event.status}`,
    `module:    ${record.module}`,
    `level:     ${record.level}`,
    `timestamp: ${record.timestamp}`,
  ];
  if (durationMs !== null) lines.push(`duration:  ${durationMs}ms`);
  if (record.context?.errorCode) lines.push(`errorCode: ${record.context.errorCode}`);
  if (record.context?.errorMessage) lines.push(`errorMessage: ${record.context.errorMessage}`);
  lines.push("", "context:", JSON.stringify(record.context ?? {}, null, 2));
  detailsEl.textContent = lines.join("\n");
}

filterEl.addEventListener("input", render);
pauseEl.addEventListener("change", () => {
  paused = pauseEl.checked;
});
clearEl.addEventListener("click", () => {
  events.length = 0;
  pendingStarts.clear();
  selectedSeq = null;
  detailsEl.textContent = "Select an event to see full context.";
  render();
});

const port = chrome.runtime.connect({ name: "sorokit-devtools-panel" });
port.postMessage({ type: "init", tabId: chrome.devtools.inspectedWindow.tabId });
port.onMessage.addListener((message) => {
  if (message?.type === "sorokit-devtools-record") {
    handleRecord(message.detail);
  }
});

render();
