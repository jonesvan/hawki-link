// Popup controller: collects the goal, starts/stops the agent, and renders the
// running log streamed from the background worker.

const el = {
  log: document.getElementById("log"),
  goal: document.getElementById("goal"),
  composer: document.getElementById("composer"),
  run: document.getElementById("run"),
  stop: document.getElementById("stop"),
  settings: document.getElementById("settings"),
  model: document.getElementById("model"),
  ask: document.getElementById("ask"),
  askQuestion: document.getElementById("ask-question")
};

let awaitingUser = false;
let running = false;

function append(kind, html) {
  const empty = el.log.querySelector(".empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "entry " + kind;
  div.innerHTML = html;
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

function setRunning(value) {
  running = value;
  el.run.disabled = value;
  el.stop.disabled = !value;
  el.goal.disabled = false;
}

function showAsk(question) {
  awaitingUser = true;
  el.ask.classList.remove("hidden");
  el.askQuestion.textContent = question;
  el.goal.placeholder = "Type your answer and press Reply...";
  el.run.textContent = "Reply";
  el.goal.focus();
}

function clearAsk() {
  awaitingUser = false;
  el.ask.classList.add("hidden");
  el.goal.placeholder = "Ask Hawki to do something on the web...";
  el.run.textContent = "Run";
}

function renderEvent(event) {
  switch (event.kind) {
    case "start":
      setRunning(true);
      append("user", `<span class="tag">Goal</span>${escapeHtml(event.goal)}`);
      break;
    case "thinking":
      append("thinking", `Thinking... (step ${event.step})`);
      break;
    case "assistant":
      append("assistant", `<span class="tag">Hawki</span>${escapeHtml(event.text)}`);
      break;
    case "tool":
      append(
        "tool",
        `<div><span class="name">${escapeHtml(event.name)}</span>(${escapeHtml(
          JSON.stringify(event.args || {})
        )})</div>`
      );
      break;
    case "ask":
      append("assistant", `<span class="tag">Question</span>${escapeHtml(event.text)}`);
      showAsk(event.text);
      break;
    case "user-reply":
      clearAsk();
      append("user", `<span class="tag">You</span>${escapeHtml(event.text)}`);
      break;
    case "finish":
      clearAsk();
      setRunning(false);
      append("finish", `<span class="tag">Done</span>${escapeHtml(event.summary)}`);
      break;
    case "error":
      append("error", `<span class="tag">Error</span>${escapeHtml(event.text)}`);
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

  if (awaitingUser) {
    const res = await chrome.runtime.sendMessage({ type: "hawki:user-reply", text });
    if (!res.ok) append("error", escapeHtml(res.error));
  } else {
    el.log.innerHTML = "";
    const res = await chrome.runtime.sendMessage({ type: "hawki:start", goal: text });
    if (!res.ok) append("error", escapeHtml(res.error));
    else setRunning(true);
  }
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
