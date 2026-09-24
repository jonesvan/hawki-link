// Popup controller: collects the goal, starts/stops the agent, and renders the
// running log streamed from the background worker.

const el = {
  log: document.getElementById("log"),
  goal: document.getElementById("goal"),
  composer: document.getElementById("composer"),
  run: document.getElementById("run"),
  stop: document.getElementById("stop"),
  settings: document.getElementById("settings"),
  model: document.getElementById("model")
};

let running = false;

function append(kind, html, step) {
  const empty = el.log.querySelector(".empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "entry " + kind;
  const badge = step ? `<span class="step">#${step}</span>` : "";
  div.innerHTML = badge + html;
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "\u2026" : str;
}

function setRunning(value) {
  running = value;
  el.run.disabled = value;
  el.stop.disabled = !value;
  el.goal.disabled = false;
}

function renderEvent(event) {
  switch (event.kind) {
    case "start":
      setRunning(true);
      append("user", `<span class="tag">Goal</span>${escapeHtml(event.goal)}`);
      break;
    case "thinking":
      append(
        "thinking",
        event.text ? escapeHtml(event.text) : `Thinking\u2026`,
        event.step
      );
      break;
    case "reasoning":
      append(
        "reasoning",
        `<span class="tag">Reasoning</span>${escapeHtml(truncate(event.text, 1200))}`,
        event.step
      );
      break;
    case "assistant":
      append(
        "assistant",
        `<span class="tag">Hawki</span>${escapeHtml(event.text)}`,
        event.step
      );
      break;
    case "tool":
      append(
        "tool",
        `<div><span class="name">${escapeHtml(event.name)}</span>(${escapeHtml(
          truncate(JSON.stringify(event.args || {}), 160)
        )})</div>`,
        event.step
      );
      break;
    case "result": {
      const v = event.view || {};
      const cls = v.ok === false ? "result bad" : "result";
      let html = `<span class="tag">${v.ok === false ? "Failed" : "Result"}</span>` +
        escapeHtml(v.text || "");
      if (v.url) {
        html += `<div class="meta">${escapeHtml(v.url)}</div>`;
      }
      if (v.preview) {
        html += `<div class="preview">${escapeHtml(truncate(v.preview, 220))}</div>`;
      }
      append(cls, html, event.step);
      break;
    }
    case "dialog":
      append(
        "result",
        `<span class="tag">Dialog: ${escapeHtml(event.kind)}</span>${escapeHtml(event.detail || "")}`,
        event.step
      );
      break;
    case "finish":
      setRunning(false);
      append("finish", `<span class="tag">Done</span>${escapeHtml(event.summary)}`);
      break;
    case "error":
      append("error", `<span class="tag">Error</span>${escapeHtml(event.text)}`, event.step);
      break;
  }
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: "hawki:get-state" });
  if (state && state.history && state.history.length) {
    el.log.innerHTML = "";
    for (const event of state.history) renderEvent(event);
  }
  setRunning(!!state.running);
}

async function refreshModel() {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings && settings.model) el.model.textContent = settings.model;
}

el.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = el.goal.value.trim();
  if (!text) return;

  el.log.innerHTML = "";
  const res = await chrome.runtime.sendMessage({ type: "hawki:start", goal: text });
  if (!res.ok) append("error", escapeHtml(res.error));
  else setRunning(true);
  el.goal.value = "";
});

el.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "hawki:stop" });
});

el.settings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

el.goal.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "hawki:event") renderEvent(msg.event);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) refreshModel();
});

refreshModel();
refreshState();
