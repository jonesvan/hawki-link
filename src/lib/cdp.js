// Chrome DevTools Protocol bridge over chrome.debugger. This unlocks the
// capabilities the synthetic event model cannot provide:
//   - trusted input (real clicks/keys, so sites that check isTrusted work)
//   - file inputs (the only way to set <input type=file>)
//   - network control (headers, auth, offline, block, mock/route, wait)
//   - emulation (viewport, media, geolocation, timezone, locale, UA)
//   - console/exception capture, screenshots and PDF
// Everything degrades gracefully: if the debugger cannot attach (no permission,
// DevTools open, another debugger attached) the caller falls back to synthetic
// events in the content script.

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Esc: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 }
};

function specFor(token) {
  if (KEYS[token]) return KEYS[token];
  if (token.length === 1) {
    const ch = token;
    const upper = ch.toUpperCase();
    let code;
    if (/[a-z]/i.test(ch)) code = "Key" + upper;
    else if (/[0-9]/.test(ch)) code = "Digit" + ch;
    else code = "Punctuation";
    return { key: ch, code, vk: upper.charCodeAt(0), text: ch };
  }
  return { key: token, code: token, vk: 0 };
}

function parseCombo(combo) {
  const parts = String(combo || "").split("+").map((s) => s.trim()).filter(Boolean);
  let modifiers = 0;
  while (parts.length > 1) {
    const m = parts.shift().toLowerCase();
    if (MOD[m] != null) modifiers |= MOD[m];
    else parts.unshift(m);
  }
  const token = parts[0] || "Enter";
  return { spec: specFor(token), modifiers };
}

export class CdpSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.detached = false;
    this.consoleLogs = [];
    this.routes = [];
    this.auth = null;
    this._onEvent = this._onEvent.bind(this);
    this._onDetach = this._onDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._onEvent);
    chrome.debugger.onDetach.addListener(this._onDetach);
  }

  get attached() {
    return !this.detached && this.tabId != null;
  }

  async attach() {
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
      this.detached = false;
    } catch (err) {
      this.detached = true;
      return { ok: false, error: err && err.message };
    }
    await Promise.allSettled([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Network.enable"),
      this.send("DOM.enable")
    ]);
    return { ok: true };
  }

  async switchTo(tabId) {
    if (tabId === this.tabId && this.attached) return { ok: true };
    await this.detach();
    this.tabId = tabId;
    this.detached = false;
    this.consoleLogs.length = 0;
    this.routes.length = 0;
    return this.attach();
  }

  async detach() {
    if (this.tabId == null) return;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch (_) {
      // already detached
    }
    this.detached = true;
  }

  send(method, params = {}) {
    if (!this.attached) return Promise.reject(new Error("Debugger not attached."));
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  async trySend(method, params) {
    try {
      return await this.send(method, params);
    } catch (_) {
      return null;
    }
  }

  _onDetach(source) {
    if (source && source.tabId === this.tabId) this.detached = true;
  }

  _onEvent(source, method, params) {
    if (!source || source.tabId !== this.tabId) return;
    if (method === "Runtime.consoleAPICalled") {
      this.consoleLogs.push({
        kind: params.type,
        text: (params.args || [])
          .map((a) => (a.value != null ? String(a.value) : a.description || a.type || ""))
          .join(" ")
          .slice(0, 2000),
        at: Date.now()
      });
      if (this.consoleLogs.length > 300) this.consoleLogs.shift();
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      this.consoleLogs.push({
        kind: "exception",
        text: `${d.text || "Exception"} ${d.exception?.description || ""}`.slice(0, 2000),
        at: Date.now()
      });
      if (this.consoleLogs.length > 300) this.consoleLogs.shift();
    } else if (method === "Fetch.authRequired") {
      this._handleAuth(params).catch(() => {});
    } else if (method === "Fetch.requestPaused") {
      this._handlePaused(params).catch(() => {});
    }
  }

  async _handleAuth(params) {
    const creds = this.auth;
    if (creds) {
      await this.trySend("Fetch.continueWithAuth", {
        requestId: params.requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: creds.username,
          password: creds.password
        }
      });
    } else {
      await this.trySend("Fetch.continueWithAuth", {
        requestId: params.requestId,
        authChallengeResponse: { response: "CancelAuth" }
      });
    }
  }

  async _handlePaused(params) {
    const url = params.request?.url || "";
    const route = this.routes.find((r) => matchGlob(r.pattern, url));
    if (!route) {
      await this.trySend("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }
    if (route.abort) {
      await this.trySend("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" });
      return;
    }
    const responseHeaders = Object.entries(route.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
    if (route.contentType) responseHeaders.push({ name: "content-type", value: route.contentType });
    await this.trySend("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: route.status || 200,
      responseHeaders,
      body: toBase64(String(route.body ?? ""))
    });
  }

  // ---- trusted input ----

  keyPress(combo) {
    const { spec, modifiers } = parseCombo(combo);
    const base = {
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk
    };
    return this.pressEvents(base, spec);
  }

  async pressEvents(base, spec) {
    const withText = spec.text
      ? [{ ...base, type: "keyDown", text: spec.text, unmodifiedText: spec.text }]
      : [{ ...base, type: "rawKeyDown" }, { ...base, type: "keyDown" }];
    for (const e of withText) await this.trySend("Input.dispatchKeyEvent", e);
    await this.trySend("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  insertText(text) {
    return this.trySend("Input.insertText", { text: String(text ?? "") });
  }

  mouseMove(x, y) {
    return this.trySend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async mouseClick(x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
    const common = { x, y, button, modifiers, clickCount };
    await this.trySend("Input.dispatchMouseEvent", { ...common, type: "mousePressed" });
    await this.trySend("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" });
    if (button === "right") {
      await this.trySend("Input.dispatchMouseEvent", { ...common, type: "mousePressed" });
      await this.trySend("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" });
    }
  }

  mouseDown(x, y, opts = {}) {
    return this.trySend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, ...opts });
  }

  mouseUp(x, y, opts = {}) {
    return this.trySend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, ...opts });
  }

  wheel(x, y, deltaX, deltaY) {
    return this.trySend("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  async drag(from, to) {
    await this.mouseMove(from.x, from.y);
    await this.mouseDown(from.x, from.y, { button: "left", clickCount: 1, buttons: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await this.mouseMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await this.mouseUp(to.x, to.y, { button: "left", clickCount: 1, buttons: 0 });
  }

  // ---- file inputs ----

  async setFileInput(hawkiId, files) {
    const doc = await this.trySend("DOM.getDocument", { depth: -1, pierce: true });
    if (!doc || !doc.root) return { ok: false, error: "DOM.getDocument failed." };
    const sel = `[data-hawki-id="${String(hawkiId).replace(/"/g, '\\"')}"]`;
    const found = await this.trySend("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
    if (!found || !found.nodeId) return { ok: false, error: "File input not found." };
    await this.trySend("DOM.setFileInputFiles", { files, nodeId: found.nodeId });
    return { ok: true, files };
  }

  // ---- emulation ----

  setDeviceMetrics(width, height, { deviceScaleFactor = 1, mobile = false } = {}) {
    return this.trySend("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile
    });
  }

  clearDeviceMetrics() {
    return this.trySend("Emulation.clearDeviceMetricsOverride");
  }

  setMedia({ media, colorScheme, reducedMotion } = {}) {
    return this.trySend("Emulation.setEmulatedMedia", {
      media: media || "screen",
      features: [
        ...(colorScheme ? [{ name: "prefers-color-scheme", value: colorScheme }] : []),
        ...(reducedMotion ? [{ name: "prefers-reduced-motion", value: reducedMotion }] : [])
      ]
    });
  }

  setGeolocation(latitude, longitude, accuracy = 1) {
    return this.trySend("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
  }

  setTimezone(timezoneId) {
    return this.trySend("Emulation.setTimezoneOverride", { timezoneId });
  }

  setLocale(locale) {
    return this.trySend("Emulation.setLocaleOverride", { locale });
  }

  setUserAgent(userAgent, platform) {
    return this.trySend("Emulation.setUserAgentOverride", { userAgent, ...(platform ? { platform } : {}) });
  }

  // ---- network ----

  setExtraHeaders(headers) {
    return this.trySend("Network.setExtraHTTPHeaders", { headers: headers || {} });
  }

  setOffline(offline, { latency = 0, downloadThroughput = -1, uploadThroughput = -1 } = {}) {
    return this.trySend("Network.emulateNetworkConditions", {
      offline: !!offline,
      latency,
      downloadThroughput,
      uploadThroughput
    });
  }

  setBlockedURLs(urls) {
    return this.trySend("Network.setBlockedURLs", { urls: urls || [] });
  }

  async setAuth(username, password) {
    this.auth = username != null ? { username, password: password ?? "" } : null;
    return this.trySend("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] });
  }

  async setRoutes(routes) {
    this.routes = routes || [];
    if (this.routes.length) {
      return this.trySend("Fetch.enable", {
        handleAuthRequests: !!this.auth,
        patterns: [{ urlPattern: "*", requestStage: "Request" }]
      });
    }
    return this.trySend("Fetch.disable");
  }

  async waitForResponse(urlPart, timeoutMs = 15000) {
    if (!this.attached) return { ok: false, error: "Debugger not attached." };
    return new Promise((resolve) => {
      const listener = (source, method, params) => {
        if (source.tabId !== this.tabId) return;
        if (method !== "Network.responseReceived") return;
        const url = params.response?.url || "";
        if (url.includes(urlPart)) {
          cleanup();
          resolve({ ok: true, matched: true, url, status: params.response.status, mimeType: params.response.mimeType });
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, error: `Timed out waiting for response "${urlPart}".` });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
      };
      chrome.debugger.onEvent.addListener(listener);
    });
  }

  // ---- capture ----

  async screenshot({ fullPage = false, format = "png", quality } = {}) {
    const params = { format, ...(format === "jpeg" && quality ? { quality } : {}) };
    if (fullPage) {
      const metrics = await this.trySend("Page.getLayoutMetrics");
      const size = metrics?.contentSize || metrics?.cssContentSize;
      if (size) {
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }
    const res = await this.trySend("Page.captureScreenshot", params);
    return res && res.data ? { ok: true, data: res.data, format } : { ok: false, error: "Screenshot failed." };
  }

  async printToPDF({ landscape = false, printBackground = true } = {}) {
    const res = await this.trySend("Page.printToPDF", { landscape, printBackground });
    return res && res.data ? { ok: true, data: res.data } : { ok: false, error: "printToPDF failed." };
  }

  getConsole(clear = true) {
    const logs = this.consoleLogs.slice();
    if (clear) this.consoleLogs.length = 0;
    return logs;
  }
}

// UTF-8 safe base64 (no Buffer in a service worker).
function toBase64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Tiny glob matcher for route patterns ("*://api.example.com/*", "**/v1/*").
function matchGlob(pattern, url) {
  if (!pattern || pattern === "*") return true;
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^]*")
    .replace(/\u0000/g, "[^]*");
  try {
    return new RegExp("^" + escaped + "$").test(url);
  } catch (_) {
    return url.includes(pattern.replace(/\*/g, ""));
  }
}
