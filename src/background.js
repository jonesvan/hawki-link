// Background service worker: wires the agent loop to Chrome's tab APIs and
// relays events to the popup UI.

import { Agent } from "./lib/agent.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./lib/deepseek.js";

const DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  temperature: 0.2,
  maxSteps: 40,
  dialogConfirm: "accept",
  dialogPrompt: ""
};

let session = null; // { agent, pendingAsk, tabId, running }
const eventHistory = []; // recent events, replayed when the popup reopens
const HISTORY_LIMIT = 300;

// Dialog policy for main-world overrides (alert/confirm/prompt/print).
let dialogPolicy = { confirm: "accept", prompt: "" };
const pendingDialogs = []; // dialogs handled since the last observation

function emit(event) {
  eventHistory.push(event);
  if (eventHistory.length > HISTORY_LIMIT) eventHistory.shift();
  // Fire-and-forget; the popup may not be open.
  chrome.runtime.sendMessage({ type: "hawki:event", event }).catch(() => {});
}

function drainDialogs() {
  return pendingDialogs.splice(0);
}

function attachDialogs(obj) {
  const dialogs = drainDialogs();
  return dialogs.length ? { ...obj, dialogs } : obj;
}

// Injected into the page's MAIN world. Content scripts run in an isolated world
// and cannot see or replace the page's own alert/confirm/prompt/print, so these
// must be overridden where the page actually calls them.
function installDialogHandlers(policy) {
  if (window.__hawkiMain) {
    if (policy && window.__hawkiPolicy) Object.assign(window.__hawkiPolicy, policy);
    return true;
  }
  window.__hawkiMain = true;
  window.__hawkiPolicy = policy || { confirm: "accept", prompt: "" };

  const report = (kind, detail) => {
    try {
      window.postMessage({ __hawkiDialog: true, kind, detail }, "*");
    } catch (_) {}
  };

  window.alert = function (message) {
    report("alert", String(message));
  };

  window.confirm = function (message) {
    const accept = (window.__hawkiPolicy.confirm || "accept") !== "dismiss";
    report("confirm", String(message) + "  \u2192  " + (accept ? "accepted" : "dismissed"));
    return accept;
  };

  window.prompt = function (message, defaultValue) {
    const value =
      window.__hawkiPolicy.prompt != null && window.__hawkiPolicy.prompt !== ""
        ? window.__hawkiPolicy.prompt
        : defaultValue != null
          ? defaultValue
          : "";
    report("prompt", String(message) + "  \u2192  " + JSON.stringify(value));
    return value;
  };

  window.print = function () {
    report("print", "window.print() intercepted");
  };

  return true;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) throw new Error("No active tab found.");
  return tab;
}

// Keep the service worker alive during a run via an offscreen document.
const OFFSCREEN_PATH = "src/offscreen.html";
async function ensureKeepalive() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Keep the agent task running while it controls the browser."
  });
}
async function releaseKeepalive() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

// Inject the content script and main-world dialog handlers into every frame of
// the tab. Rich editors (e.g. Etherpad) live inside iframes, so top-frame-only
// injection misses the actual editable area.
async function injectIntoFrames(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: installDialogHandlers,
      args: [dialogPolicy]
    })
    .catch(() => []);

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content.js"]
    });
  } catch (_) {
    // Some frames may refuse injection; fall back to the top frame.
    results = await chrome.scripting
      .executeScript({ target: { tabId }, files: ["src/content.js"] })
      .catch(() => []);
  }

  chrome.scripting
    .insertCSS({ target: { tabId, allFrames: true }, files: ["src/content.css"] })
    .catch(() => {});

  const frameIds = results.map((r) => r.frameId).filter((id) => id != null);
  return frameIds.length ? frameIds : [0];
}

// Element ids are prefixed with their frame id ("3:12"), so we can route an
// action back to the right frame.
function frameOfId(id) {
  const m = String(id ?? "").match(/^(\d+):/);
  return m ? Number(m[1]) : null;
}

async function sendToFrame(tabId, frameId, action, args = {}) {
  const res = await chrome.tabs.sendMessage(
    tabId,
    { source: "hawki-agent", action, args },
    { frameId }
  );
  if (!res) throw new Error(`No response from frame ${frameId}.`);
  if (!res.ok) throw new Error(res.error || "Page action failed.");
  return res.result;
}

function mergeSnapshots(states, maxChars = 6000) {
  const top = states.find((s) => s.frameId === 0) || states[0];
  const elements = [];
  for (const { frameId, state } of states) {
    for (const el of state.elements || []) {
      if (elements.length >= 150) break;
      elements.push({ ...el, frame: frameId });
    }
  }
  const primary = top.state.text || "";
  const extra = states
    .filter((s) => s.frameId !== top.frameId && s.state.text)
    .map((s) => `[frame ${s.frameId}] ${s.state.text}`)
    .join("\n\n");
  let text = primary + (extra ? "\n\n" + extra : "");
  if (text.length > maxChars + 2000) {
    text = text.slice(0, maxChars + 2000) + "\n...[truncated]";
  }
  return {
    url: top.state.url,
    title: top.state.title,
    text,
    elements,
    frames: states.map((s) => ({
      frameId: s.frameId,
      url: s.state.url,
      title: s.state.title,
      elements: (s.state.elements || []).length
    })),
    scrollY: top.state.scrollY,
    scrollHeight: top.state.scrollHeight,
    viewportHeight: top.state.viewportHeight
  };
}

// Read every frame of the tab and merge them into one observation.
async function snapshotAll(tabId, opts = {}) {
  const frameIds = await injectIntoFrames(tabId);
  const settled = await Promise.all(
    frameIds.map((frameId) =>
      chrome.tabs
        .sendMessage(
          tabId,
          {
            source: "hawki-agent",
            action: "snapshot",
            args: { ...opts, frameKey: String(frameId) }
          },
          { frameId }
        )
        .then((res) => (res && res.ok ? { frameId, state: res.result } : null))
        .catch(() => null)
    )
  );
  const states = settled.filter(Boolean);
  if (!states.length) throw new Error("Could not read any frame on this page.");
  return mergeSnapshots(states, opts.maxChars || 6000);
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    // Resolve quickly if already complete.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") setTimeout(finish, 300);
    }).catch(() => {});
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tabStatus(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { id: t.id, url: t.url, status: t.status };
  } catch (_) {
    return null;
  }
}

// Resolves with the first tab opened during the window (for target=_blank links
// and window.open), or null.
function watchNewTab(ms) {
  return new Promise((resolve) => {
    let created = null;
    const listener = (tab) => {
      if (!created) created = tab;
    };
    chrome.tabs.onCreated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onCreated.removeListener(listener);
      resolve(created);
    }, ms);
  });
}

// Wait for the page to settle, then read it. This is the "observe" half of the
// loop: every state-changing action ends by returning a fresh page snapshot.
async function observe(tabIdRef, opts = {}) {
  await waitForTabComplete(tabIdRef.current, opts.timeout || 15000);
  await sleep(opts.settle ?? 150);
  return await snapshotAll(tabIdRef.current, {
    maxChars: opts.maxChars || 3500,
    maxElements: opts.maxElements || 100
  });
}

// Run an action in the frame that owns the target element, detect navigation /
// new tabs, and return the resulting page state.
async function runAction(tabIdRef, action, args, lastFrameRef) {
  const before = await tabStatus(tabIdRef.current);
  const watcher = watchNewTab(450);
  const frameId = frameOfId(args && args.id) ?? (lastFrameRef ? lastFrameRef.current : 0);
  if (lastFrameRef && frameId != null) lastFrameRef.current = frameId;

  let result;
  let error = null;
  try {
    result = await sendToFrame(tabIdRef.current, frameId, action, args);
  } catch (err) {
    error = err;
  }

  const created = await watcher;
  if (created && created.id !== tabIdRef.current) {
    tabIdRef.current = created.id;
    const page = await observe(tabIdRef);
    return attachDialogs({ ok: true, action, opened_new_tab: true, page });
  }

  await sleep(120);
  const after = await tabStatus(tabIdRef.current);
  const navigated =
    !after || !before || after.url !== before.url || after.status === "loading";

  if (navigated) {
    const page = await observe(tabIdRef);
    return attachDialogs({ ok: true, action, navigated: true, page });
  }

  if (error) throw error;
  return attachDialogs({ ok: true, action, navigated: false, url: after?.url, ...(result || {}) });
}

function makeBrowser(tabIdRef) {
  const activeTabId = () => tabIdRef.current;
  const lastFrameRef = { current: 0 };

  return {
    async getPageState(args = {}) {
      const state = await snapshotAll(activeTabId(), {
        maxChars: args.max_chars || 6000,
        maxElements: 120
      });
      return attachDialogs(state);
    },

    async navigate(args = {}) {
      const target = String(args.url || "").trim();
      const id = activeTabId();
      if (/^(back|forward|reload)$/i.test(target)) {
        const v = target.toLowerCase();
        if (v === "back") await chrome.tabs.goBack(id).catch(() => {});
        else if (v === "forward") await chrome.tabs.goForward(id).catch(() => {});
        else await chrome.tabs.reload(id);
      } else if (args.new_tab) {
        const tab = await chrome.tabs.create({ url: target });
        tabIdRef.current = tab.id;
      } else {
        let url = target;
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        await chrome.tabs.update(id, { url });
      }
      lastFrameRef.current = 0;
      const page = await observe(tabIdRef, { timeout: 20000 });
      return attachDialogs({ ok: true, navigated: true, url: page.url, page });
    },

    async click(id) {
      return await runAction(tabIdRef, "click", { id }, lastFrameRef);
    },

    async typeText(id, text, submit) {
      return await runAction(tabIdRef, "type", { id, text, submit: !!submit }, lastFrameRef);
    },

    async selectOption(id, value) {
      return await runAction(tabIdRef, "select", { id, value }, lastFrameRef);
    },

    async pressKey(key) {
      return await runAction(tabIdRef, "pressKey", { key }, lastFrameRef);
    },

    async scroll(direction, amount) {
      const frameIds = await injectIntoFrames(activeTabId());
      const results = await Promise.all(
        frameIds.map((frameId) =>
          sendToFrame(activeTabId(), frameId, "scroll", { direction, amount }).catch(() => null)
        )
      );
      return attachDialogs(results.find(Boolean) || { ok: true });
    },

    async wait(ms) {
      const capped = Math.min(Math.max(Number(ms) || 1000, 100), 10000);
      await sleep(capped);
      return attachDialogs({ ok: true, waited: capped });
    }
  };
}

async function startSession(goal) {
  if (session && session.running) {
    throw new Error("An agent task is already running.");
  }
  const settings = await loadSettings();
  dialogPolicy = {
    confirm: settings.dialogConfirm || "accept",
    prompt: settings.dialogPrompt ?? ""
  };
  const tab = await getActiveTab();
  const tabIdRef = { current: tab.id };

  const agent = new Agent({
    settings,
    browser: makeBrowser(tabIdRef),
    onLog: (entry) => emit({ kind: "log", ...entry }),
    onFinish: (summary) => {
      emit({ kind: "finish", summary });
      if (session) session.running = false;
      releaseKeepalive().catch(() => {});
    }
  });

  session = { agent, tabId: tab.id, running: true };
  eventHistory.length = 0;
  try {
    await ensureKeepalive();
  } catch (_) {
    // Not fatal: the task can still run, it may just be interrupted sooner.
  }
  emit({ kind: "start", goal, tabId: tab.id });

  agent.run(goal).catch((err) => {
    emit({ kind: "finish", summary: "Agent crashed: " + err.message });
    if (session) session.running = false;
    releaseKeepalive().catch(() => {});
  });
}

function stopSession() {
  if (!session) return { ok: false, error: "No task running." };
  session.agent.stop("Stopped by user.");
  session.running = false;
  emit({ kind: "finish", summary: "Stopped by user." });
  releaseKeepalive().catch(() => {});
  return { ok: true };
}

function sessionState() {
  return {
    running: !!(session && session.running),
    history: eventHistory
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "hawki:content-ready") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "hawki:dialog") {
    const entry = { kind: msg.kind, detail: msg.detail, url: msg.url };
    pendingDialogs.push(entry);
    if (pendingDialogs.length > 20) pendingDialogs.shift();
    emit({ kind: "dialog", ...entry });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "hawki:start") {
    startSession(msg.goal)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "hawki:stop") {
    sendResponse(stopSession());
    return false;
  }

  if (msg.type === "hawki:get-state") {
    sendResponse(sessionState());
    return false;
  }

  return false;
});

// Open the options page on first install so the user can add an API key.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

// Keep the dialog policy in sync with settings changes.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    const s = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    dialogPolicy = {
      confirm: s.dialogConfirm || "accept",
      prompt: s.dialogPrompt ?? ""
    };
  }
});
