// Hawki Link - content script.
// Injected on demand by the background service worker. Exposes a small DOM
// toolbox under window.__hawkiAgent that the agent loop drives via messages.

(() => {
  if (window.__hawkiAgent) {
    // Already injected in this frame.
    return;
  }

  const ID_ATTR = "data-hawki-id";
  let idCounter = 0;

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='tab']",
    "[role='menuitem']",
    "[contenteditable='true']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function labelFor(el) {
    const parts = [];
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) parts.push(text.slice(0, 120));
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const ph = el.getAttribute("placeholder");
    if (ph) parts.push("placeholder=" + ph);
    const name = el.getAttribute("name");
    if (name) parts.push("name=" + name);
    const type = el.getAttribute("type");
    if (type) parts.push("type=" + type);
    const title = el.getAttribute("title");
    if (title) parts.push("title=" + title);
    if (el.tagName === "A" && el.getAttribute("href")) {
      parts.push("href=" + el.getAttribute("href"));
    }
    return parts.join(" | ").slice(0, 200);
  }

  function assignId(el) {
    let id = el.getAttribute(ID_ATTR);
    if (!id) {
      id = String(++idCounter);
      el.setAttribute(ID_ATTR, id);
    }
    return id;
  }

  function collectElements(limit) {
    const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const out = [];
    for (const el of nodes) {
      if (out.length >= limit) break;
      if (!isVisible(el)) continue;
      if (el.disabled) continue;
      out.push({
        id: assignId(el),
        tag: el.tagName.toLowerCase(),
        text: labelFor(el),
        value: "value" in el ? String(el.value || "").slice(0, 120) : undefined,
        options:
          el.tagName === "SELECT"
            ? Array.from(el.options).map((o) => o.textContent.trim())
            : undefined
      });
    }
    return out;
  }

  function pageText(maxChars) {
    const main =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body;
    let text = (main && main.innerText) || "";
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + "\n...[truncated]";
    }
    return text;
  }

  function snapshot(opts = {}) {
    const maxChars = opts.maxChars || 6000;
    return {
      url: location.href,
      title: document.title,
      text: pageText(maxChars),
      elements: collectElements(opts.maxElements || 120),
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    };
  }

  function byId(id) {
    return document.querySelector(`[${ID_ATTR}="${CSS.escape(String(id))}"]`);
  }

  function highlight(el) {
    try {
      el.style.outline = "3px solid #ff5722";
      el.style.outlineOffset = "2px";
      setTimeout(() => {
        el.style.outline = "";
        el.style.outlineOffset = "";
      }, 1200);
    } catch (_) {}
  }

  function dispatchMouse(el, type, opts = {}) {
    const rect = el.getBoundingClientRect();
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...opts
    });
    el.dispatchEvent(event);
  }

  function doClick(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
    dispatchMouse(el, "pointerdown");
    dispatchMouse(el, "mousedown");
    dispatchMouse(el, "mouseup");
    dispatchMouse(el, "click");
    if (typeof el.click === "function") el.click();
    return { ok: true, clicked: labelFor(el) };
  }

  function nativeInputValueSetter(el) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    return setter;
  }

  async function doType(id, text, submit) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    el.focus({ preventScroll: true });

    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    } else {
      const setter = nativeInputValueSetter(el);
      if (setter) {
        setter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (submit) {
      const form = el.form;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else {
        await doPressKey("Enter");
      }
    }
    return { ok: true, typed: text.length + " chars" };
  }

  function doSelect(id, value) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    if (el.tagName !== "SELECT") {
      return { ok: false, error: "Element is not a <select> dropdown." };
    }
    const wanted = String(value).toLowerCase();
    const option = Array.from(el.options).find(
      (o) =>
        o.value.toLowerCase() === wanted ||
        o.textContent.trim().toLowerCase() === wanted ||
        o.textContent.trim().toLowerCase().includes(wanted)
    );
    if (!option) {
      return {
        ok: false,
        error: "No matching option. Available: " +
          Array.from(el.options).map((o) => o.textContent.trim()).join(", ")
      };
    }
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: option.textContent.trim() };
  }

  async function doPressKey(key) {
    const target = document.activeElement || document.body;
    const opts = { key, code: key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    }
    return { ok: true };
  }

  function doScroll(direction, amount) {
    const step = amount || Math.round(window.innerHeight * 0.8);
    switch (direction) {
      case "top":
        window.scrollTo({ top: 0, behavior: "instant" });
        break;
      case "bottom":
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        break;
      case "up":
        window.scrollBy({ top: -step, behavior: "instant" });
        break;
      default:
        window.scrollBy({ top: step, behavior: "instant" });
    }
    return { ok: true, scrollY: window.scrollY };
  }

  window.__hawkiAgent = {
    snapshot,
    click: doClick,
    type: doType,
    select: doSelect,
    pressKey: doPressKey,
    scroll: doScroll,
    version: 1
  };

  // Signal readiness to the background worker (used only for the first inject).
  if (!window.__hawkiReady) {
    window.__hawkiReady = true;
    try {
      chrome.runtime.sendMessage({ type: "hawki:content-ready", url: location.href });
    } catch (_) {}
  }

  // Relay dialog/print events intercepted in the page's main world.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__hawkiDialog !== true) return;
    try {
      chrome.runtime.sendMessage({
        type: "hawki:dialog",
        kind: data.kind,
        detail: data.detail,
        url: location.href
      });
    } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== "hawki-agent") return false;
    (async () => {
      try {
        const api = window.__hawkiAgent;
        let result;
        switch (msg.action) {
          case "snapshot":
            result = api.snapshot(msg.args || {});
            break;
          case "click":
            result = api.click(msg.args.id);
            break;
          case "type":
            result = await api.type(msg.args.id, msg.args.text, msg.args.submit);
            break;
          case "select":
            result = api.select(msg.args.id, msg.args.value);
            break;
          case "pressKey":
            result = await api.pressKey(msg.args.key);
            break;
          case "scroll":
            result = api.scroll(msg.args.direction, msg.args.amount);
            break;
          default:
            result = { ok: false, error: "Unknown action: " + msg.action };
        }
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // async response
  });
})();
