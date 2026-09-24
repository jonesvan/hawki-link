// Background service worker: wires the agent loop to Chrome's tab APIs and
// relays events to the popup UI. Also exposes the full browser tool surface to
// the agent (synthetic DOM actions + a CDP-backed trusted layer).

import { Agent } from "./lib/agent.js";
import { JevAgent } from "./lib/jev-agent.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./lib/deepseek.js";
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from "./lib/typesafe.js";
import { CdpSession } from "./lib/cdp.js";
import { DownloadManager } from "./lib/downloads.js";

const DEFAULT_SETTINGS = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  jevApiKey: "",
  jevBaseUrl: DEFAULT_JEV_BASE_URL,
  jevModel: DEFAULT_JEV_MODEL,
  jevConfidence: 0.3,
  temperature: 0.2,
  maxSteps: 40,
  trustedInput: true,
  dialogConfirm: "accept",
  dialogPrompt: ""
};

// Open the chat in the side panel when the toolbar icon is clicked.
function enableSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
enableSidePanel();
chrome.runtime.onInstalled.addListener(enableSidePanel);

let session = null; // { agent, tabId, running, cdp, downloads, routes }
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
  if (id && typeof id === "object") id = id.id;
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

// Run a `perform()` action, detect navigation / new tabs, and return the
// resulting page state. `perform` may target the DOM (sendToFrame) or drive the
// CDP trusted-input layer.
async function runAction(tabIdRef, perform, opts = {}) {
  const before = await tabStatus(tabIdRef.current);
  const watch = opts.watch !== false;
  const watcher = watch ? watchNewTab(450) : Promise.resolve(null);

  let result;
  let error = null;
  try {
    result = await perform();
  } catch (err) {
    error = err;
  }

  const created = await watcher;
  if (created && created.id !== tabIdRef.current) {
    tabIdRef.current = created.id;
    const page = await observe(tabIdRef);
    return attachDialogs({ ok: true, action: opts.name, opened_new_tab: true, page });
  }

  if (!watch) {
    if (error) throw error;
    return attachDialogs({ ok: true, action: opts.name, ...(result || {}) });
  }

  await sleep(120);
  const after = await tabStatus(tabIdRef.current);
  const navigated =
    !after || !before || after.url !== before.url || after.status === "loading";

  if (navigated) {
    const page = await observe(tabIdRef);
    return attachDialogs({ ok: true, action: opts.name, navigated: true, page });
  }

  if (error) throw error;
  return attachDialogs({ ok: true, action: opts.name, navigated: false, url: after?.url, ...(result || {}) });
}

function makeBrowser(tabIdRef, sessionRef) {
  const activeTabId = () => tabIdRef.current;
  const lastFrameRef = { current: 0 };
  const cdp = () => sessionRef.cdp;
  const downloads = () => sessionRef.downloads;
  const trustedEnabled = () => sessionRef.settings?.trustedInput !== false;

  function frameFor(args) {
    const frameId = frameOfId(args) ?? lastFrameRef.current;
    lastFrameRef.current = frameId;
    return frameId;
  }

  function contentCall(action, args) {
    const frameId = frameFor(args);
    return sendToFrame(activeTabId(), frameId, action, args);
  }

  // DOM action with an optional trusted (CDP) fast path for top-frame targets.
  function domAction(name, action, args, { watch = true, trusted = null } = {}) {
    const perform = async () => {
      const frameId = frameFor(args);
      if (trusted && trustedEnabled() && cdp()?.attached && frameId === 0) {
        try {
          return await trusted();
        } catch (err) {
          const fallback = await sendToFrame(activeTabId(), frameId, action, args);
          return { ...fallback, trusted_fallback: String(err.message || err) };
        }
      }
      return sendToFrame(activeTabId(), frameId, action, args);
    };
    return runAction(tabIdRef, perform, { name, watch });
  }

  async function pointOf(args) {
    const frameId = frameFor(args);
    const p = await sendToFrame(activeTabId(), frameId, "point", args);
    return { ...p, frameId };
  }

  async function syncCdpTab() {
    if (cdp()?.attached) await cdp().switchTo(activeTabId()).catch(() => {});
  }

  return {
    async getPageState(args = {}) {
      const state = await snapshotAll(activeTabId(), {
        maxChars: args.max_chars || 6000,
        maxElements: args.max_elements || 120
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
        await syncCdpTab();
      } else {
        let url = target;
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        await chrome.tabs.update(id, { url });
      }
      lastFrameRef.current = 0;
      const page = await observe(tabIdRef, { timeout: 20000 });
      return attachDialogs({ ok: true, navigated: true, url: page.url, page });
    },

    click(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("click", "click", a, {
        trusted: async () => {
          const p = await pointOf(a);
          await cdp().mouseMove(p.x, p.y);
          await cdp().mouseClick(p.x, p.y, {
            button: a.button === "right" ? "right" : a.button === "middle" ? "middle" : "left",
            clickCount: a.click_count || 1
          });
          return { clicked: p.label, trusted: true };
        }
      });
    },

    dblclick(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("dblclick", "dblclick", a, {
        trusted: async () => {
          const p = await pointOf(a);
          await cdp().mouseMove(p.x, p.y);
          await cdp().mouseClick(p.x, p.y, { clickCount: 2 });
          return { doubleClicked: p.label, trusted: true };
        }
      });
    },

    rightClick(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("right_click", "rightClick", a, {
        trusted: async () => {
          const p = await pointOf(a);
          await cdp().mouseMove(p.x, p.y);
          await cdp().mouseClick(p.x, p.y, { button: "right" });
          return { rightClicked: p.label, trusted: true };
        }
      });
    },

    hover(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("hover", "hover", a, {
        watch: false,
        trusted: async () => {
          const p = await pointOf(a);
          await cdp().mouseMove(p.x, p.y);
          return { hovered: p.label, trusted: true };
        }
      });
    },

    typeText(args) {
      const a =
        typeof args === "object"
          ? args
          : { id: args, text: arguments[1], submit: arguments[2] };
      return domAction("type_text", "type", a, {
        trusted: async () => {
          const prep = await contentCall("prepareType", a);
          await cdp().insertText(a.text);
          if (a.submit) await cdp().keyPress("Enter");
          return { typed: String(a.text ?? "").length + " chars", focused: prep.focused, trusted: true };
        }
      });
    },

    selectOption(args) {
      const a = typeof args === "object" ? args : { id: args, value: arguments[1] };
      return domAction("select_option", "select", a);
    },

    check(args) {
      const a = typeof args === "object" ? args : { id: args, checked: arguments[1] };
      return domAction("check", "check", a);
    },

    focus(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("focus", "focus", a, { watch: false });
    },

    read(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("read", "read", a, { watch: false });
    },

    point(args) {
      const a = typeof args === "object" ? args : { id: args };
      return pointOf(a);
    },

    find(args) {
      return domAction("find", "locate", args || {}, { watch: false });
    },

    assert(args) {
      return domAction("assert", "assert", args || {}, { watch: false });
    },

    inject(args) {
      return domAction("inject", "inject", args || {}, { watch: false });
    },

    clipboard(args) {
      return domAction("clipboard", "clipboard", args || {}, { watch: false });
    },

    storage(args) {
      return domAction("storage", "storage", args || {}, { watch: false });
    },

    scrollIntoView(args) {
      const a = typeof args === "object" ? args : { id: args };
      return domAction("scroll_into_view", "scrollIntoView", a, { watch: false });
    },

    pressKey(args) {
      const combo = typeof args === "string" ? args : args.keys || args.key || "Enter";
      return domAction("press_key", "pressKey", { keys: combo }, {
        trusted: async () => {
          await cdp().keyPress(combo);
          return { pressed: combo, trusted: true };
        }
      });
    },

    mouse(args = {}) {
      const frameId = lastFrameRef.current;
      const perform = async () => {
        if (!cdp()?.attached) throw new Error("Debugger not attached; use click/hover instead.");
        if (args.op === "move") await cdp().mouseMove(args.x || 0, args.y || 0);
        else if (args.op === "down") await cdp().mouseDown(args.x || 0, args.y || 0, { button: args.button || "left", clickCount: 1, buttons: 1 });
        else if (args.op === "up") await cdp().mouseUp(args.x || 0, args.y || 0, { button: args.button || "left", clickCount: 1, buttons: 0 });
        else if (args.op === "wheel") await cdp().wheel(args.x || 0, args.y || 0, args.delta_x || 0, args.delta_y || 0);
        else if (args.op === "click") await cdp().mouseClick(args.x || 0, args.y || 0, { button: args.button || "left", clickCount: args.click_count || 1 });
        else return { ok: false, error: "Unknown mouse op: " + args.op };
        return { ok: true, op: args.op };
      };
      return runAction(tabIdRef, perform, { name: "mouse", watch: false });
    },

    keyboard(args = {}) {
      const perform = async () => {
        if (!cdp()?.attached) throw new Error("Debugger not attached.");
        if (args.op === "insert") await cdp().insertText(args.text || "");
        else await cdp().keyPress(args.keys || args.key || "Enter");
        return { ok: true, op: args.op || "press" };
      };
      return runAction(tabIdRef, perform, { name: "keyboard", watch: false });
    },

    drag(args = {}) {
      const a = args;
      return domAction("drag", "drag", a, {
        trusted: async () => {
          const from = await pointOf({ id: a.from_id });
          const to = await pointOf({ id: a.to_id });
          await cdp().drag({ x: from.x, y: from.y }, { x: to.x, y: to.y });
          return { dragged: from.label, to: to.label, trusted: true };
        }
      });
    },

    async upload(args = {}) {
      if (!cdp()?.attached) {
        return { ok: false, error: "File upload requires the debugger (enable trusted input)." };
      }
      const frameId = frameFor(args);
      if (frameId !== 0) {
        return { ok: false, error: "File inputs inside iframes are not supported." };
      }
      const files = Array.isArray(args.files) ? args.files : [args.file].filter(Boolean);
      const r = await cdp().setFileInput(args.id, files);
      if (!r.ok) return r;
      return attachDialogs({ ok: true, uploaded: files });
    },

    async tabs(args = {}) {
      const op = args.op || "list";
      if (op === "list") {
        const tabs = await chrome.tabs.query({});
        return {
          ok: true,
          tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
        };
      }
      if (op === "new") {
        const tab = await chrome.tabs.create({ url: args.url, active: !!args.active });
        if (args.active) {
          tabIdRef.current = tab.id;
          await syncCdpTab();
        }
        return { ok: true, id: tab.id };
      }
      if (op === "activate") {
        await chrome.tabs.update(args.id, { active: true });
        tabIdRef.current = args.id;
        lastFrameRef.current = 0;
        await syncCdpTab();
        const page = await observe(tabIdRef);
        return attachDialogs({ ok: true, page });
      }
      if (op === "close") {
        await chrome.tabs.remove(args.id);
        return { ok: true };
      }
      return { ok: false, error: "Unknown tabs op: " + op };
    },

    async cookies(args = {}) {
      const op = args.op || "get";
      if (op === "get") {
        const cookies = args.url
          ? await chrome.cookies.getAll({ url: args.url })
          : await chrome.cookies.getAll({ domain: args.domain });
        return { ok: true, cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure })) };
      }
      if (op === "set") {
        const details = { url: args.url, name: args.name, value: args.value ?? "" };
        if (args.domain) details.domain = args.domain;
        if (args.path) details.path = args.path;
        const cookie = await chrome.cookies.set(details);
        return { ok: !!cookie, cookie };
      }
      if (op === "remove") {
        await chrome.cookies.remove({ url: args.url, name: args.name });
        return { ok: true };
      }
      if (op === "clear") {
        const list = args.url ? await chrome.cookies.getAll({ url: args.url }) : await chrome.cookies.getAll({ domain: args.domain });
        for (const c of list) {
          const host = (c.domain || "").replace(/^\./, "");
          await chrome.cookies.remove({ url: `https://${host}${c.path || "/"}`, name: c.name }).catch(() => {});
        }
        return { ok: true, removed: list.length };
      }
      return { ok: false, error: "Unknown cookies op: " + op };
    },

    async network(args = {}) {
      const c = cdp();
      if (!c?.attached) return { ok: false, error: "Network control requires the debugger (enable trusted input)." };
      const op = args.op;
      if (op === "set_headers") {
        await c.setExtraHeaders(args.headers || {});
        return { ok: true };
      }
      if (op === "auth") {
        await c.setAuth(args.username, args.password);
        return { ok: true };
      }
      if (op === "offline") {
        await c.setOffline(true, { latency: args.latency || 0 });
        return { ok: true };
      }
      if (op === "online") {
        await c.setOffline(false);
        return { ok: true };
      }
      if (op === "throttle") {
        await c.setOffline(false, {
          latency: args.latency || 0,
          downloadThroughput: args.download_throughput ?? -1,
          uploadThroughput: args.upload_throughput ?? -1
        });
        return { ok: true };
      }
      if (op === "block") {
        await c.setBlockedURLs(args.urls || []);
        return { ok: true };
      }
      if (op === "route") {
        sessionRef.routes = sessionRef.routes || [];
        sessionRef.routes.push({
          pattern: args.pattern || "*",
          status: args.status,
          body: args.body,
          contentType: args.content_type,
          headers: args.headers,
          abort: !!args.abort
        });
        await c.setRoutes(sessionRef.routes);
        return { ok: true, routes: sessionRef.routes.length };
      }
      if (op === "unroute") {
        sessionRef.routes = [];
        await c.setRoutes([]);
        return { ok: true };
      }
      return { ok: false, error: "Unknown network op: " + op };
    },

    async emulate(args = {}) {
      const c = cdp();
      if (!c?.attached) return { ok: false, error: "Emulation requires the debugger (enable trusted input)." };
      if (args.viewport === "reset") await c.clearDeviceMetrics();
      else if (args.width && args.height) {
        await c.setDeviceMetrics(args.width, args.height, {
          deviceScaleFactor: args.device_scale_factor || 1,
          mobile: !!args.mobile
        });
      }
      if (args.color_scheme || args.reduced_motion || args.media) {
        await c.setMedia({ colorScheme: args.color_scheme, reducedMotion: args.reduced_motion, media: args.media });
      }
      if (args.geolocation) await c.setGeolocation(args.geolocation.latitude, args.geolocation.longitude, args.geolocation.accuracy);
      if (args.timezone) await c.setTimezone(args.timezone);
      if (args.locale) await c.setLocale(args.locale);
      if (args.user_agent) await c.setUserAgent(args.user_agent, args.platform);
      return { ok: true };
    },

    async screenshot(args = {}) {
      const format = args.format || "png";
      let b64 = null;
      if (cdp()?.attached) {
        const r = await cdp().screenshot({ fullPage: !!args.full_page, format, quality: args.quality });
        if (!r.ok) return r;
        b64 = r.data;
      } else {
        const tab = await chrome.tabs.get(activeTabId());
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
        b64 = String(dataUrl).split(",")[1];
      }
      const filename = args.filename || `hawki-screenshot-${Date.now()}.${format}`;
      const saved = await downloads().saveDataUrl(`data:image/${format};base64,${b64}`, filename);
      return { ok: saved.ok, filename: saved.filename, bytes: saved.bytes, error: saved.error };
    },

    async pdf(args = {}) {
      if (!cdp()?.attached) return { ok: false, error: "PDF requires the debugger (enable trusted input)." };
      const r = await cdp().printToPDF({ landscape: !!args.landscape, printBackground: args.print_background !== false });
      if (!r.ok) return r;
      const filename = args.filename || `hawki-page-${Date.now()}.pdf`;
      const saved = await downloads().saveDataUrl(`data:application/pdf;base64,${r.data}`, filename);
      return { ok: saved.ok, filename: saved.filename, bytes: saved.bytes, error: saved.error };
    },

    async download(args = {}) {
      if (args.action === "save") {
        return await downloads().saveUrl(args.url, args.filename);
      }
      return await downloads().waitForDownload({ urlPart: args.url_part, timeoutMs: args.timeout_ms });
    },

    console(args = {}) {
      const logs = cdp()?.getConsole(args.clear !== false) || [];
      return { ok: true, count: logs.length, entries: logs };
    },

    dialog(args = {}) {
      if (args.confirm) dialogPolicy.confirm = args.confirm;
      if (args.prompt != null) dialogPolicy.prompt = args.prompt;
      chrome.scripting
        .executeScript({
          target: { tabId: activeTabId(), allFrames: true },
          world: "MAIN",
          func: installDialogHandlers,
          args: [dialogPolicy]
        })
        .catch(() => {});
      return { ok: true, policy: { ...dialogPolicy } };
    },

    async evaluate(code) {
      const tabId = activeTabId();
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId, frameId: lastFrameRef.current || 0 },
          world: "MAIN",
          func: (src) => {
            try {
              const value = (0, eval)(src);
              let safe;
              try {
                safe = JSON.parse(JSON.stringify(value ?? null));
              } catch (_) {
                safe = String(value);
              }
              return { ok: true, value: safe };
            } catch (err) {
              return { ok: false, error: String((err && err.message) || err) };
            }
          },
          args: [String(code)]
        });
      } catch (err) {
        return attachDialogs({ ok: false, error: "evaluate failed: " + err.message });
      }
      const r = results && results[0] && results[0].result;
      return attachDialogs(r || { ok: false, error: "evaluate returned no result." });
    },

    async waitFor(args, value, timeoutMs) {
      const opts = typeof args === "object" ? args : { type: args, value, timeout_ms: timeoutMs };
      const type = opts.type;
      const val = opts.value;
      const deadline = Date.now() + Math.min(Math.max(Number(opts.timeout_ms) || 10000, 500), 30000);
      const tabId = activeTabId();

      if (type === "response") {
        if (!cdp()?.attached) return { ok: false, error: "Response waiting requires the debugger." };
        return await cdp().waitForResponse(val, Number(opts.timeout_ms) || 15000);
      }
      if (type === "load") {
        await waitForTabComplete(tabId, Number(opts.timeout_ms) || 15000);
        return { ok: true, matched: true };
      }

      while (Date.now() < deadline) {
        if (type === "url") {
          const t = await tabStatus(tabId);
          if (t && t.url && t.url.includes(val)) return { ok: true, matched: true, url: t.url };
        } else if (type === "selector" || type === "visible" || type === "hidden" || type === "detached") {
          const located = await sendToFrame(tabId, 0, "locate", { selector: val, max: 5 }).catch(() => null);
          const count = located?.count || 0;
          if (type === "selector" && count > 0) return { ok: true, matched: true, count };
          if (type === "detached" && count === 0) return { ok: true, matched: true };
          if ((type === "visible" || type === "hidden") && count > 0) {
            const vis = located.matches.some((m) => m.visible);
            if (type === "visible" && vis) return { ok: true, matched: true };
            if (type === "hidden" && !vis) return { ok: true, matched: true };
          }
          if (type === "hidden" && count === 0) return { ok: true, matched: true };
        } else if (type === "function") {
          const r = await this.evaluate(`(${val})`).catch(() => null);
          if (r && r.ok && r.value) return { ok: true, matched: true, value: r.value };
        } else {
          const snap = await snapshotAll(tabId, { maxChars: 8000, maxElements: 1 }).catch(() => null);
          if (snap && snap.text && snap.text.includes(val)) return { ok: true, matched: true };
        }
        await sleep(250);
      }
      return { ok: false, error: `Timed out waiting for ${type} "${val}".` };
    },

    scroll(args = {}) {
      return domAction("scroll", "scroll", args, { watch: false });
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

  const cdp = new CdpSession(tab.id);
  const downloads = new DownloadManager();
  session = { tabId: tab.id, running: true, settings, cdp, downloads, routes: [] };

  if (settings.trustedInput !== false) {
    const attached = await cdp.attach();
    if (!attached.ok) {
      emit({
        kind: "log",
        type: "error",
        step: 0,
        text: "Trusted input unavailable (" + (attached.error || "attach failed") + "); using synthetic events."
      });
    }
  }

  const Engine = settings.provider === "jev" ? JevAgent : Agent;
  const agent = new Engine({
    settings,
    browser: makeBrowser(tabIdRef, session),
    onLog: (entry) => emit({ kind: "log", ...entry }),
    onFinish: (summary) => {
      emit({ kind: "finish", summary });
      if (session) session.running = false;
      cleanupSession();
    }
  });
  session.agent = agent;

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
    cleanupSession();
  });
}

function cleanupSession() {
  if (session) {
    session.cdp?.detach().catch(() => {});
    session.downloads?.dispose();
  }
  releaseKeepalive().catch(() => {});
}

function stopSession() {
  if (!session) return { ok: false, error: "No task running." };
  session.agent.stop("Stopped by user.");
  session.running = false;
  emit({ kind: "finish", summary: "Stopped by user." });
  cleanupSession();
  return { ok: true };
}

function sessionState() {
  return {
    running: !!(session && session.running),
    history: eventHistory
  };
}

// Test/debug hook: invoke a single browser tool against the active tab. Disabled
// unless settings.testApi is true (never set by the UI). Keeps the CDP session
// attached so emulation/network state persists across calls.
let testSession = null;
async function invokeTool(method, args = {}) {
  const settings = await loadSettings();
  if (settings.testApi !== true) return { ok: false, error: "test api disabled" };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, error: "No active tab." };
  const tabIdRef = { current: tab.id };
  if (!testSession || testSession.tabId !== tab.id) {
    if (testSession) {
      testSession.cdp.detach().catch(() => {});
      testSession.downloads.dispose();
    }
    const cdp = new CdpSession(tab.id);
    const downloads = new DownloadManager();
    testSession = { tabId: tab.id, cdp, downloads, settings, routes: [] };
    if (settings.trustedInput !== false) await cdp.attach();
  }
  await injectIntoFrames(tab.id);
  const browser = makeBrowser(tabIdRef, testSession);
  if (typeof browser[method] !== "function") return { ok: false, error: "Unknown tool: " + method };
  return await browser[method](args);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "hawki:start") {
    startSession(msg.goal)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "hawki:stop") {
    sendResponse(stopSession());
    return true;
  }
  if (msg.type === "hawki:get-state") {
    sendResponse(sessionState());
    return true;
  }
  if (msg.type === "hawki:invoke") {
    invokeTool(msg.method, msg.args)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "hawki:dialog") {
    pendingDialogs.push({ kind: msg.kind, detail: msg.detail, url: msg.url });
    emit({ kind: "dialog", dialogKind: msg.kind, detail: msg.detail });
  }
});
