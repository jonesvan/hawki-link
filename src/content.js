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
  let currentFrameKey = "0";

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
      id = currentFrameKey + ":" + ++idCounter;
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
    if (opts.frameKey != null) currentFrameKey = String(opts.frameKey);
    const maxChars = opts.maxChars || 6000;
    return {
      frameKey: currentFrameKey,
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
      // Rich editors (Etherpad, Google Docs, etc.) ignore direct textContent
      // writes. Insert via execCommand so a real beforeinput/input fires and the
      // editor's own model updates. Place the caret at the end and append.
      el.focus({ preventScroll: true });
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (_) {}
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (_) {
        inserted = false;
      }
      if (!inserted) {
        el.textContent = (el.textContent || "") + text;
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
        );
      }
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

  function parseCombo(combo) {
    const parts = String(combo || "")
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    const key = parts.pop() || "";
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l === "ctrl" || l === "control") mods.ctrlKey = true;
      else if (l === "shift") mods.shiftKey = true;
      else if (l === "alt" || l === "option") mods.altKey = true;
      else if (l === "meta" || l === "cmd" || l === "command") mods.metaKey = true;
    }
    return { key, mods };
  }

  async function doPressKey(combo) {
    const target = document.activeElement || document.body;
    const { key, mods } = parseCombo(combo);
    const opts = { key, code: key, bubbles: true, cancelable: true, ...mods };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    if (key.length === 1 || key === "Enter") {
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", opts));

    // Common shortcuts that need an explicit implementation.
    if ((mods.ctrlKey || mods.metaKey) && key.toLowerCase() === "a") {
      try {
        document.execCommand("selectAll");
      } catch (_) {}
    } else if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    }
    return { ok: true, pressed: combo };
  }

  function mouseCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function fireMouse(el, type, x, y, extra = {}) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        ...extra
      })
    );
  }

  function doHover(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const { x, y } = mouseCenter(el);
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      fireMouse(el, t, x, y);
    }
    return { ok: true, hovered: labelFor(el) };
  }

  function doDblclick(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const { x, y } = mouseCenter(el);
    fireMouse(el, "mousedown", x, y, { detail: 1 });
    fireMouse(el, "mouseup", x, y, { detail: 1 });
    fireMouse(el, "click", x, y, { detail: 1 });
    fireMouse(el, "mousedown", x, y, { detail: 2 });
    fireMouse(el, "mouseup", x, y, { detail: 2 });
    fireMouse(el, "click", x, y, { detail: 2 });
    fireMouse(el, "dblclick", x, y, { detail: 2 });
    return { ok: true, doubleClicked: labelFor(el) };
  }

  function doRightClick(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const { x, y } = mouseCenter(el);
    fireMouse(el, "mousedown", x, y, { button: 2, buttons: 2 });
    fireMouse(el, "mouseup", x, y, { button: 2, buttons: 0 });
    fireMouse(el, "contextmenu", x, y, { button: 2 });
    return { ok: true, rightClicked: labelFor(el) };
  }

  function doCheck(id, checked) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const want = checked !== false;
    if (typeof el.checked === "boolean" && el.checked !== want) {
      el.click();
    }
    if (typeof el.checked === "boolean") el.checked = want;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: !!el.checked, text: labelFor(el) };
  }

  function doFocus(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    return { ok: true, focused: labelFor(el) };
  }

  function doScrollIntoView(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return { ok: true };
  }

  function doDrag(fromId, toId) {
    const from = byId(fromId);
    const to = byId(toId);
    if (!from) return { ok: false, error: `No source element with id ${fromId}` };
    if (!to) return { ok: false, error: `No target element with id ${toId}` };
    from.scrollIntoView({ block: "center", behavior: "instant" });
    const a = mouseCenter(from);
    const b = mouseCenter(to);
    const dataTransfer = (() => {
      try {
        return new DataTransfer();
      } catch (_) {
        return null;
      }
    })();

    // HTML5 drag events (for apps built on the drag-and-drop API).
    const dragEvt = (type, target, coords) => {
      const ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: coords.x,
        clientY: coords.y,
        dataTransfer
      });
      target.dispatchEvent(ev);
    };
    dragEvt("dragstart", from, a);
    dragEvt("dragenter", to, b);
    dragEvt("dragover", to, b);
    dragEvt("drop", to, b);
    dragEvt("dragend", from, b);

    // Pointer/mouse sequence (for canvas/JS-driven drag).
    fireMouse(from, "mousedown", a.x, a.y, { buttons: 1 });
    for (let i = 1; i <= 5; i++) {
      const x = a.x + ((b.x - a.x) * i) / 5;
      const y = a.y + ((b.y - a.y) * i) / 5;
      fireMouse(document.elementFromPoint(x, y) || to, "mousemove", x, y, { buttons: 1 });
    }
    fireMouse(to, "mouseup", b.x, b.y, { buttons: 0 });
    return { ok: true, dragged: labelFor(from), to: labelFor(to) };
  }

  function doRead(id) {
    const el = byId(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    const attrs = {};
    for (const name of ["href", "src", "name", "type", "placeholder", "role", "value"]) {
      const v = el.getAttribute && el.getAttribute(name);
      if (v != null) attrs[name] = String(v).slice(0, 300);
    }
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000),
      value: "value" in el ? String(el.value ?? "").slice(0, 500) : undefined,
      checked: typeof el.checked === "boolean" ? el.checked : undefined,
      disabled: !!el.disabled,
      attributes: attrs
    };
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
    dblclick: doDblclick,
    rightClick: doRightClick,
    hover: doHover,
    type: doType,
    select: doSelect,
    check: doCheck,
    focus: doFocus,
    pressKey: doPressKey,
    drag: doDrag,
    read: doRead,
    scrollIntoView: doScrollIntoView,
    scroll: doScroll,
    version: 2
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
          case "dblclick":
            result = api.dblclick(msg.args.id);
            break;
          case "rightClick":
            result = api.rightClick(msg.args.id);
            break;
          case "hover":
            result = api.hover(msg.args.id);
            break;
          case "type":
            result = await api.type(msg.args.id, msg.args.text, msg.args.submit);
            break;
          case "select":
            result = api.select(msg.args.id, msg.args.value);
            break;
          case "check":
            result = api.check(msg.args.id, msg.args.checked);
            break;
          case "focus":
            result = api.focus(msg.args.id);
            break;
          case "pressKey":
            result = await api.pressKey(msg.args.keys || msg.args.key);
            break;
          case "drag":
            result = api.drag(msg.args.from_id, msg.args.to_id);
            break;
          case "read":
            result = api.read(msg.args.id);
            break;
          case "scrollIntoView":
            result = api.scrollIntoView(msg.args.id);
            break;
          case "scroll":
            result = api.scroll(msg.args.direction, msg.args.amount);
            break;
          case "query": {
            try {
              const els = Array.from(document.querySelectorAll(msg.args.selector));
              result = {
                ok: true,
                count: els.length,
                text: els[0] ? (els[0].innerText || els[0].textContent || "").trim().slice(0, 300) : ""
              };
            } catch (err) {
              result = { ok: false, error: String(err.message || err) };
            }
            break;
          }
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
