// Hawki Link - content script.
// Injected on demand by the background service worker. Exposes a small DOM
// toolbox under window.__hawkiAgent that the agent loop drives via messages.
//
// This is the Playwright-equivalent layer: actionability checks, shadow-DOM
// piercing, locator strategies, and the DOM primitives for reads, selects,
// scrolling, clipboard, storage and assertions.

(() => {
  if (window.__hawkiAgent) {
    // Already injected in this frame.
    return;
  }

  const ID_ATTR = "data-hawki-id";
  let idCounter = 0;
  let currentFrameKey = "0";
  const idMap = new Map();

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='option']",
    "[contenteditable='true']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ---- deep (shadow-piercing) queries -------------------------------------

  function deepQueryAll(selector, root = document) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      let found;
      try {
        found = node.querySelectorAll(selector);
      } catch (_) {
        return;
      }
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      let hosts;
      try {
        hosts = node.querySelectorAll("*");
      } catch (_) {
        return;
      }
      for (const el of hosts) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  function xpathAll(expr, root = document) {
    const out = [];
    try {
      const res = document.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
    } catch (_) {}
    return out.filter((n) => n && n.nodeType === 1);
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function visibleText(el) {
    return ((el.innerText || el.textContent || "") + "").replace(/\s+/g, " ").trim();
  }

  function labelFor(el) {
    const parts = [];
    const text = visibleText(el);
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
    idMap.set(id, el);
    return id;
  }

  function byId(id) {
    const cached = idMap.get(String(id));
    if (cached && cached.isConnected) return cached;
    const found = deepQueryAll(`[${ID_ATTR}="${CSS.escape(String(id))}"]`);
    if (found[0]) idMap.set(String(id), found[0]);
    return found[0] || null;
  }

  // ---- interactive collection ---------------------------------------------

  function collectElements(limit) {
    const nodes = deepQueryAll(INTERACTIVE_SELECTOR);
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      if (out.length >= limit) break;
      if (seen.has(el)) continue;
      seen.add(el);
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

  // ---- locator strategies --------------------------------------------------

  const ROLE_TAGS = {
    button: "button",
    link: "a",
    checkbox: "input[type=checkbox]",
    radio: "input[type=radio]",
    textbox: "input[type=text],input:not([type]),textarea",
    searchbox: "input[type=search]",
    heading: "h1,h2,h3,h4,h5,h6",
    tab: "[role=tab]",
    option: "option,[role=option]",
    combobox: "select,[role=combobox]",
    img: "img"
  };

  function findMatches(args = {}) {
    const by = args.by || (args.selector ? "css" : args.xpath ? "xpath" : null);
    const value = args.value != null ? args.value : args.selector != null ? args.selector : args.xpath;
    const exact = args.exact !== false;
    let list = [];

    if (by === "css") list = deepQueryAll(String(value));
    else if (by === "xpath") list = xpathAll(String(value));
    else if (by === "text") {
      const nodes = deepQueryAll("a,button,[role],label,span,p,div,h1,h2,h3,h4,h5,h6,li,td,th");
      list = nodes.filter((el) => {
        const t = visibleText(el);
        return exact ? t === String(value) : t.toLowerCase().includes(String(value).toLowerCase());
      });
    } else if (by === "role") {
      const sel = ROLE_TAGS[String(value).toLowerCase()];
      list = sel ? deepQueryAll(sel) : deepQueryAll(`[role="${CSS.escape(String(value))}"]`);
    } else if (by === "label") {
      const labels = deepQueryAll("label");
      for (const l of labels) {
        if (visibleText(l) !== String(value) && !visibleText(l).toLowerCase().includes(String(value).toLowerCase())) continue;
        const forId = l.getAttribute("for");
        const control = forId ? document.getElementById(forId) : l.querySelector("input,textarea,select,button");
        if (control) list.push(control);
      }
    } else if (by === "placeholder") {
      list = deepQueryAll(`[placeholder]`).filter((el) => {
        const p = el.getAttribute("placeholder") || "";
        return exact ? p === String(value) : p.toLowerCase().includes(String(value).toLowerCase());
      });
    } else if (by === "testid") {
      const v = String(value);
      list = deepQueryAll(`[data-testid="${cssAttr(v)}"],[data-test-id="${cssAttr(v)}"],[data-test="${cssAttr(v)}"]`);
    } else if (by === "alt") {
      list = deepQueryAll(`[alt="${cssAttr(String(value))}"]`);
    } else if (by === "title") {
      list = deepQueryAll(`[title="${cssAttr(String(value))}"]`);
    } else {
      throw new Error("Unsupported locator. Use by=css|xpath|text|role|label|placeholder|testid|alt|title.");
    }
    return list;
  }

  function cssAttr(v) {
    return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function describeLocator(args) {
    if (args.id != null) return `id ${args.id}`;
    return `${args.by || (args.selector ? "css" : "locator")}=${args.value ?? args.selector ?? args.xpath}`;
  }

  function resolveTarget(args = {}) {
    if (args.id != null) {
      const el = byId(args.id);
      if (!el) throw new Error(`No element with id ${args.id}. Re-read the page.`);
      return el;
    }
    const list = findMatches(args);
    if (!list.length) throw new Error(`No element matched ${describeLocator(args)}.`);
    const nth = args.nth != null ? Number(args.nth) : 0;
    const el = list[nth] || list[0];
    assignId(el);
    return el;
  }

  // ---- actionability -------------------------------------------------------

  async function waitActionable(el, opts = {}) {
    const timeout = opts.timeout ?? 4000;
    const editable = !!opts.editable;
    const enabled = opts.enabled !== false;
    const deadline = Date.now() + timeout;
    let reason = "unknown";
    while (Date.now() < deadline) {
      if (!el.isConnected) {
        reason = "detached";
        await sleep(50);
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        reason = "hidden";
        await sleep(50);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        reason = "zero-size";
        await sleep(50);
        continue;
      }
      if (enabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) {
        reason = "disabled";
        await sleep(50);
        continue;
      }
      if (editable) {
        const canEdit = el.isContentEditable || (!el.disabled && "value" in el);
        if (!canEdit) {
          reason = "not-editable";
          await sleep(50);
          continue;
        }
      }
      await raf();
      const r2 = el.getBoundingClientRect();
      if (Math.abs(r2.x - r.x) > 1 || Math.abs(r2.y - r.y) > 1) {
        reason = "unstable";
        continue;
      }
      return { ok: true, rect: r2 };
    }
    throw new Error(`Element not actionable after ${timeout}ms (${reason}).`);
  }

  // ---- low-level mouse helpers (synthetic fallback) ------------------------

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

  // ---- actions -------------------------------------------------------------

  async function doClick(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
    const count = args.click_count || 1;
    dispatchMouse(el, "pointerdown");
    dispatchMouse(el, "mousedown");
    dispatchMouse(el, "mouseup");
    dispatchMouse(el, "click");
    if (count >= 2) {
      dispatchMouse(el, "mousedown", { detail: 2 });
      dispatchMouse(el, "mouseup", { detail: 2 });
      dispatchMouse(el, "click", { detail: 2 });
      dispatchMouse(el, "dblclick", { detail: 2 });
    }
    if (typeof el.click === "function") el.click();
    return { ok: true, clicked: labelFor(el) };
  }

  async function doDblclick(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
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

  async function doRightClick(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const { x, y } = mouseCenter(el);
    fireMouse(el, "mousedown", x, y, { button: 2, buttons: 2 });
    fireMouse(el, "mouseup", x, y, { button: 2, buttons: 0 });
    fireMouse(el, "contextmenu", x, y, { button: 2 });
    return { ok: true, rightClicked: labelFor(el) };
  }

  async function doHover(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const { x, y } = mouseCenter(el);
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      fireMouse(el, t, x, y);
    }
    return { ok: true, hovered: labelFor(el) };
  }

  function nativeInputValueSetter(el) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    return setter;
  }

  async function doType(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout, editable: true });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    el.focus({ preventScroll: true });
    const text = String(args.text ?? "");

    if (el.isContentEditable) {
      if (args.clear) {
        el.textContent = "";
      }
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
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (args.submit) {
      const form = el.form;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } else {
        await doPressKey({ keys: "Enter" });
      }
    }
    return { ok: true, typed: text.length + " chars" };
  }

  // Focus + select existing value so CDP Input.insertText can replace it.
  async function doPrepareType(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout, editable: true });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    el.focus({ preventScroll: true });
    try {
      if (el.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (typeof el.select === "function") {
        el.select();
      }
    } catch (_) {}
    return { ok: true, focused: labelFor(el) };
  }

  async function doSelect(args) {
    const el = resolveTarget(args);
    if (el.tagName !== "SELECT") return { ok: false, error: "Element is not a <select> dropdown." };
    await waitActionable(el, { timeout: args.timeout });
    const options = Array.from(el.options);
    const wanted = String(args.value ?? "").toLowerCase();
    const values = Array.isArray(args.values) ? args.values.map((v) => String(v).toLowerCase()) : null;

    let chosen;
    if (values) chosen = options.filter((o) => values.includes(o.value.toLowerCase()) || values.includes(o.textContent.trim().toLowerCase()));
    else if (args.index != null) chosen = options[Number(args.index)] ? [options[Number(args.index)]] : [];
    else {
      const exact = args.exact !== false;
      chosen = options.filter((o) => {
        const v = o.value.toLowerCase();
        const t = o.textContent.trim().toLowerCase();
        if (exact) return v === wanted || t === wanted;
        return v.includes(wanted) || t.includes(wanted);
      });
    }
    if (!chosen.length) {
      return {
        ok: false,
        error: "No matching option. Available: " + options.map((o) => o.textContent.trim()).join(", ")
      };
    }
    if (el.multiple) {
      for (const o of options) o.selected = chosen.includes(o);
    } else {
      el.value = chosen[0].value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: chosen.map((o) => o.textContent.trim()).join(", ") };
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

  async function doPressKey(args) {
    const combo = typeof args === "string" ? args : args.keys || args.key;
    const target = (args && args.id && byId(args.id)) || document.activeElement || document.body;
    const { key, mods } = parseCombo(combo);
    const opts = { key, code: key, bubbles: true, cancelable: true, ...mods };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    if (key.length === 1 || key === "Enter") {
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    if ((mods.ctrlKey || mods.metaKey) && key.toLowerCase() === "a") {
      try {
        document.execCommand("selectAll");
      } catch (_) {}
    } else if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    }
    return { ok: true, pressed: combo };
  }

  async function doCheck(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    const want = args.checked !== false;
    if (typeof el.checked === "boolean" && el.checked !== want) {
      el.click();
    }
    if (typeof el.checked === "boolean") el.checked = want;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: !!el.checked, text: labelFor(el) };
  }

  async function doFocus(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    return { ok: true, focused: labelFor(el) };
  }

  async function doScrollIntoView(args) {
    const el = resolveTarget(args);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return { ok: true };
  }

  async function doDrag(args) {
    const from = resolveTarget(args.from_id != null || args.from ? { id: args.from_id } : args);
    const toArgs = args.to_id != null || args.to ? { id: args.to_id } : args;
    const to = resolveTarget(toArgs);
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
    const dragEvt = (type, target, coords) => {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: coords.x,
          clientY: coords.y,
          dataTransfer
        })
      );
    };
    dragEvt("dragstart", from, a);
    dragEvt("dragenter", to, b);
    dragEvt("dragover", to, b);
    dragEvt("drop", to, b);
    dragEvt("dragend", from, b);

    fireMouse(from, "mousedown", a.x, a.y, { buttons: 1 });
    for (let i = 1; i <= 5; i++) {
      const x = a.x + ((b.x - a.x) * i) / 5;
      const y = a.y + ((b.y - a.y) * i) / 5;
      fireMouse(document.elementFromPoint(x, y) || to, "mousemove", x, y, { buttons: 1 });
    }
    fireMouse(to, "mouseup", b.x, b.y, { buttons: 0 });
    return { ok: true, dragged: labelFor(from), to: labelFor(to) };
  }

  async function doRead(args) {
    const el = resolveTarget(args);
    const attrs = {};
    for (const name of ["href", "src", "name", "type", "placeholder", "role", "value", "aria-label", "data-testid"]) {
      const v = el.getAttribute && el.getAttribute(name);
      if (v != null) attrs[name] = String(v).slice(0, 300);
    }
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: visibleText(el).slice(0, 2000),
      value: "value" in el ? String(el.value ?? "").slice(0, 500) : undefined,
      checked: typeof el.checked === "boolean" ? el.checked : undefined,
      disabled: !!el.disabled,
      visible: isVisible(el),
      enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
      editable: !!el.isContentEditable || (!el.disabled && "value" in el),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      attributes: attrs
    };
  }

  async function doPoint(args) {
    const el = resolveTarget(args);
    await waitActionable(el, { timeout: args.timeout });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await raf();
    const { x, y } = mouseCenter(el);
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(x), y: Math.round(y), box: { x: r.x, y: r.y, width: r.width, height: r.height }, label: labelFor(el) };
  }

  function nearestScrollable(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && node.scrollHeight > node.clientHeight + 4) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  async function doScroll(args = {}) {
    const direction = args.direction || "down";
    const amount = args.amount;
    if (args.id) {
      const el = byId(args.id);
      const container = (el && nearestScrollable(el)) || el;
      if (container) {
        const step = amount || Math.round(container.clientHeight * 0.8);
        if (direction === "top") container.scrollTop = 0;
        else if (direction === "bottom") container.scrollTop = container.scrollHeight;
        else container.scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
        return { ok: true, scrollTop: container.scrollTop, container: true };
      }
    }
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

  async function doLocate(args) {
    const list = findMatches(args);
    const out = list.slice(0, args.max || 20).map((el) => ({
      id: assignId(el),
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      text: labelFor(el)
    }));
    return { ok: true, count: list.length, matches: out };
  }

  async function doAssert(args) {
    const checks = Array.isArray(args.checks) ? args.checks : [args];
    const results = checks.map((c) => {
      const kind = c.kind || "text";
      if (kind === "url") {
        const pass = location.href.includes(String(c.value));
        return { kind, value: c.value, pass, actual: location.href };
      }
      if (kind === "title") {
        const pass = document.title.includes(String(c.value));
        return { kind, value: c.value, pass, actual: document.title };
      }
      if (kind === "text") {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ");
        const pass = body.includes(String(c.value));
        return { kind, value: c.value, pass };
      }
      let el;
      try {
        el = resolveTarget(c);
      } catch (err) {
        return { kind, pass: false, error: err.message };
      }
      if (kind === "visible") return { kind, pass: isVisible(el), text: labelFor(el).slice(0, 80) };
      if (kind === "enabled") return { kind, pass: !el.disabled, text: labelFor(el).slice(0, 80) };
      if (kind === "value") return { kind, pass: String(el.value) === String(c.value), actual: el.value };
      return { kind, pass: true };
    });
    return { ok: results.every((r) => r.pass), results };
  }

  async function doInject(args) {
    const type = args.type || "script";
    if (type === "style") {
      const style = document.createElement("style");
      style.textContent = String(args.content || "");
      (document.head || document.documentElement).appendChild(style);
      return { ok: true, injected: "style" };
    }
    if (args.url) {
      const el = document.createElement("script");
      el.src = String(args.url);
      if (args.type) el.type = String(args.type);
      (document.head || document.documentElement).appendChild(el);
      return { ok: true, injected: "script", src: args.url };
    }
    const el = document.createElement("script");
    el.textContent = String(args.content || "");
    (document.head || document.documentElement).appendChild(el);
    return { ok: true, injected: "script" };
  }

  async function doClipboard(args) {
    const op = args.op || "write";
    if (op === "write") {
      const text = String(args.text ?? "");
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true, wrote: text.length };
      } catch (_) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok ? { ok: true, wrote: text.length } : { ok: false, error: "Clipboard write blocked." };
      }
    }
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: "Clipboard read blocked: " + (err.message || err) };
    }
  }

  function doStorage(args) {
    const store = args.area === "session" ? window.sessionStorage : window.localStorage;
    const op = args.op || "get";
    try {
      if (op === "get") {
        if (args.key == null) {
          const all = {};
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            all[k] = store.getItem(k);
          }
          return { ok: true, data: all };
        }
        return { ok: true, value: store.getItem(String(args.key)) };
      }
      if (op === "set") {
        store.setItem(String(args.key), String(args.value ?? ""));
        return { ok: true };
      }
      if (op === "remove") {
        store.removeItem(String(args.key));
        return { ok: true };
      }
      if (op === "clear") {
        store.clear();
        return { ok: true };
      }
      return { ok: false, error: "Unknown storage op: " + op };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  async function doHighlight(args) {
    const el = resolveTarget(args);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    highlight(el);
    return { ok: true };
  }

  window.__hawkiAgent = {
    snapshot,
    click: doClick,
    dblclick: doDblclick,
    rightClick: doRightClick,
    hover: doHover,
    type: doType,
    prepareType: doPrepareType,
    select: doSelect,
    check: doCheck,
    focus: doFocus,
    pressKey: doPressKey,
    drag: doDrag,
    read: doRead,
    point: doPoint,
    locate: doLocate,
    assert: doAssert,
    inject: doInject,
    clipboard: doClipboard,
    storage: doStorage,
    highlight: doHighlight,
    scrollIntoView: doScrollIntoView,
    scroll: doScroll,
    version: 3
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
            result = await api.snapshot(msg.args || {});
            break;
          case "click":
            result = await api.click(msg.args || {});
            break;
          case "dblclick":
            result = await api.dblclick(msg.args || {});
            break;
          case "rightClick":
            result = await api.rightClick(msg.args || {});
            break;
          case "hover":
            result = await api.hover(msg.args || {});
            break;
          case "type":
            result = await api.type(msg.args || {});
            break;
          case "prepareType":
            result = await api.prepareType(msg.args || {});
            break;
          case "select":
            result = await api.select(msg.args || {});
            break;
          case "check":
            result = await api.check(msg.args || {});
            break;
          case "focus":
            result = await api.focus(msg.args || {});
            break;
          case "pressKey":
            result = await api.pressKey(msg.args || {});
            break;
          case "drag":
            result = await api.drag(msg.args || {});
            break;
          case "read":
            result = await api.read(msg.args || {});
            break;
          case "point":
            result = await api.point(msg.args || {});
            break;
          case "locate":
            result = await api.locate(msg.args || {});
            break;
          case "assert":
            result = await api.assert(msg.args || {});
            break;
          case "inject":
            result = await api.inject(msg.args || {});
            break;
          case "clipboard":
            result = await api.clipboard(msg.args || {});
            break;
          case "storage":
            result = await api.storage(msg.args || {});
            break;
          case "highlight":
            result = await api.highlight(msg.args || {});
            break;
          case "scrollIntoView":
            result = await api.scrollIntoView(msg.args || {});
            break;
          case "scroll":
            result = await api.scroll(msg.args || {});
            break;
          case "query": {
            try {
              const els = deepQueryAll(msg.args.selector);
              result = {
                ok: true,
                count: els.length,
                text: els[0] ? visibleText(els[0]).slice(0, 300) : ""
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
