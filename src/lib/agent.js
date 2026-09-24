// The agent loop: drives the LLM and executes browser tools until the task is
// finished, paused for user input, or aborted.

import { chatCompletion } from "./deepseek.js";
import { SYSTEM_PROMPT, TOOLS } from "./prompt.js";

function pageView(page) {
  if (!page) return null;
  return {
    url: page.url,
    title: page.title,
    elements: Array.isArray(page.elements) ? page.elements.length : 0,
    preview: String(page.text || "").replace(/\s+/g, " ").slice(0, 220)
  };
}

// Turn a raw tool result into a compact, human-readable step description.
export function describeResult(name, result) {
  const out = baseDescribe(name, result);
  if (result && Array.isArray(result.dialogs) && result.dialogs.length) {
    const kinds = [...new Set(result.dialogs.map((d) => d.kind))].join(", ");
    out.text += ` \u2014 auto-handled page dialog (${kinds})`;
    out.dialogs = result.dialogs.length;
  }
  return out;
}

function baseDescribe(name, result) {
  if (!result) return { ok: false, text: "No result." };
  if (result.__stop) return { ok: true, text: "Task marked complete." };
  if (result.ok === false) return { ok: false, text: result.error || "Action failed." };

  const page = result.page || (name === "get_page_state" ? result : null);
  const view = pageView(page);

  switch (name) {
    case "get_page_state": {
      const frameNote =
        Array.isArray(result.frames) && result.frames.length > 1
          ? ` across ${result.frames.length} frames`
          : "";
      return {
        ok: true,
        text: `Read page: ${view?.title || view?.url || "(untitled)"} \u2014 ${view?.elements ?? 0} interactive elements${frameNote}`,
        ...view
      };
    }
    case "navigate":
      return { ok: true, text: `Navigated to ${result.url || view?.url || ""}`, navigated: true, ...view };
    case "click":
      if (result.opened_new_tab) return { ok: true, text: `Opened new tab: ${view?.url || ""}`, navigated: true, ...view };
      if (result.navigated) return { ok: true, text: `Clicked \u2192 navigated to ${view?.url || ""}`, navigated: true, ...view };
      return { ok: true, text: `Clicked ${result.clicked || "element"}`, ...view };
    case "dblclick":
      if (result.navigated) return { ok: true, text: `Double-clicked \u2192 navigated`, navigated: true, ...view };
      return { ok: true, text: `Double-clicked ${result.doubleClicked || "element"}` };
    case "right_click":
      return { ok: true, text: `Right-clicked ${result.rightClicked || "element"}` };
    case "hover":
      return { ok: true, text: `Hovered ${result.hovered || "element"}` };
    case "check":
      return { ok: true, text: `${result.checked ? "Checked" : "Unchecked"} ${result.text || "element"}` };
    case "focus":
      return { ok: true, text: `Focused ${result.focused || "element"}` };
    case "read":
      return {
        ok: true,
        text: `Read <${result.tag}>: ${(result.text || "").slice(0, 300)}` +
          (result.value != null ? ` [value=${String(result.value).slice(0, 120)}]` : ""),
        preview: result.text ? result.text.slice(0, 220) : undefined
      };
    case "scroll_into_view":
      return { ok: true, text: "Scrolled element into view." };
    case "drag":
      return { ok: true, text: `Dragged ${result.dragged || "source"} \u2192 ${result.to || "target"}` };
    case "evaluate":
      return { ok: true, text: `JS returned: ${JSON.stringify(result.value).slice(0, 500)}` };
    case "wait_for":
      return { ok: true, text: result.matched ? `Condition met (${result.count ?? "ok"}).` : "Wait finished." };
    case "type_text":
      if (result.navigated) return { ok: true, text: `Submitted \u2192 navigated to ${view?.url || ""}`, navigated: true, ...view };
      return { ok: true, text: `Typed ${result.typed || "text"}`, ...view };
    case "select_option":
      return { ok: true, text: `Selected "${result.selected || ""}"`, ...view };
    case "press_key":
      return { ok: true, text: `Pressed ${result?.pressed || "key"}`, ...view };
    case "scroll":
      return { ok: true, text: `Scrolled (y=${result.scrollY ?? "?"})` };
    case "wait":
      return { ok: true, text: `Waited ${result.waited ?? "?"}ms` };
    case "find": {
      const matches = result.matches || [];
      return {
        ok: true,
        text: `Found ${result.count ?? matches.length} match(es): ` +
          matches.slice(0, 6).map((m) => `${m.id} <${m.tag}> ${m.text.slice(0, 50)}`).join(" | ")
      };
    }
    case "point":
      return { ok: true, text: `Point (${result.x},${result.y}) on ${result.label || "element"}` };
    case "mouse":
      return { ok: true, text: `Mouse ${result.op || ""} at (${result.x ?? "?"},${result.y ?? "?"})` };
    case "keyboard":
      return { ok: true, text: `Keyboard ${result.op || ""} ${result.pressed || ""}` };
    case "upload":
      return { ok: result.ok !== false, text: `Uploaded ${(result.uploaded || []).join(", ")}` };
    case "tabs":
      return {
        ok: true,
        text: result.tabs
          ? `Tabs: ` + result.tabs.map((t) => `${t.id}${t.active ? "*" : ""} ${String(t.title || t.url).slice(0, 40)}`).join(" | ")
          : `Tab ${result.id ?? ""} ${result.ok ? "ok" : ""}`
      };
    case "cookies":
      return {
        ok: true,
        text: result.cookies
          ? `${result.cookies.length} cookie(s): ` + result.cookies.slice(0, 6).map((c) => c.name).join(", ")
          : `Cookies ${result.removed != null ? "removed " + result.removed : "ok"}`
      };
    case "network":
      return { ok: true, text: `Network ${result.routes != null ? "routes=" + result.routes : "ok"}` };
    case "emulate":
      return { ok: true, text: "Emulation applied." };
    case "screenshot":
    case "pdf":
      return { ok: true, text: `Saved ${result.filename || "file"} (${result.bytes ?? "?"} bytes)` };
    case "download":
      return result.ok ? { ok: true, text: `Downloaded ${result.filename} (${result.bytes ?? "?"} bytes)` } : { ok: false, text: result.error || "Download failed." };
    case "console":
      return {
        ok: true,
        text: `${result.count ?? 0} console entr${(result.count ?? 0) === 1 ? "y" : "ies"}` +
          (result.entries?.length ? ": " + result.entries.slice(0, 4).map((e) => `[${e.kind}] ${e.text.slice(0, 80)}`).join(" | ") : "")
      };
    case "dialog":
      return { ok: true, text: `Dialog policy: confirm=${result.policy?.confirm}, prompt=${JSON.stringify(result.policy?.prompt)}` };
    case "assert": {
      const bad = (result.results || []).filter((r) => !r.pass);
      return {
        ok: result.ok !== false,
        text: result.ok !== false ? "All assertions passed." : `Assertion failed: ` + bad.map((b) => `${b.kind}${b.value ? "=" + b.value : ""}`).join(", ")
      };
    }
    case "inject":
      return { ok: true, text: `Injected ${result.injected || "content"}` };
    case "clipboard":
      return { ok: result.ok !== false, text: result.text != null ? `Clipboard: ${String(result.text).slice(0, 120)}` : `Wrote ${result.wrote ?? 0} chars` };
    case "storage":
      return {
        ok: result.ok !== false,
        text: result.data ? `Storage: ${JSON.stringify(result.data).slice(0, 300)}` : `Storage ${result.value != null ? JSON.stringify(result.value) : "ok"}`
      };
    default:
      return { ok: true, text: "Done." };
  }
}

export class Agent {
  /**
   * @param {object} opts
   * @param {object} opts.settings  { apiKey, baseUrl, model, temperature, maxSteps }
   * @param {object} opts.browser   Tool implementation (see background.js).
   * @param {(entry:object)=>void} [opts.onLog]
   * @param {(summary:string)=>void} [opts.onFinish]
   */
  constructor({ settings, browser, onLog, onFinish }) {
    this.settings = settings;
    this.browser = browser;
    this.onLog = onLog || (() => {});
    this.onFinish = onFinish || (() => {});
    this.abort = new AbortController();
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.recent = []; // recent action signatures, for loop detection
    this.nudged = new Set();
    this.currentStep = 0;
  }

  stop(reason = "Stopped by user.") {
    this.abort.abort();
    this.stopReason = reason;
  }

  async run(goal) {
    this.messages.push({ role: "user", content: goal });
    const maxSteps = this.settings.maxSteps || 40;

    for (let step = 0; step < maxSteps; step++) {
      if (this.abort.signal.aborted) {
        this.onFinish(this.stopReason || "Stopped.");
        return;
      }
      this.onLog({ type: "thinking", step: step + 1 });
      this.currentStep = step + 1;

      let response;
      try {
        response = await chatCompletion({
          apiKey: this.settings.apiKey,
          baseUrl: this.settings.baseUrl,
          model: this.settings.model,
          temperature: this.settings.temperature,
          messages: this.messages,
          tools: TOOLS,
          signal: this.abort.signal
        });
      } catch (err) {
        if (err.name === "AbortError") {
          this.onFinish(this.stopReason || "Stopped.");
          return;
        }
        this.onLog({ type: "error", text: err.message });
        this.onFinish("Agent error: " + err.message);
        return;
      }

      const msg = response.message;
      this.messages.push(msg);

      if (msg.reasoning_content) {
        this.onLog({ type: "reasoning", text: msg.reasoning_content, step: this.currentStep });
      }
      if (msg.content) {
        this.onLog({ type: "assistant", text: msg.content, step: this.currentStep });
      }

      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) {
        // Model answered directly without a tool.
        this.onFinish(msg.content || "(no answer)");
        return;
      }

      for (const call of toolCalls) {
        if (this.abort.signal.aborted) {
          this.onFinish(this.stopReason || "Stopped.");
          return;
        }
        const name = call.function?.name;
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (_) {
          args = {};
        }

        const result = await this.executeTool(name, args);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });

        if (result && result.__stop) {
          this.onFinish(result.summary);
          return;
        }

        const verdict = this.trackLoop(name, args);
        if (verdict === "stuck") {
          this.onFinish(
            `I stopped because I kept repeating the same action (${name}) without ` +
              "making progress. Set a more specific goal, or correct me and try again."
          );
          return;
        }
      }
    }

    this.onFinish(`Stopped after reaching the ${maxSteps}-step limit.`);
  }

  // Loop detection: if the same action keeps recurring in the recent window, nudge
  // the model to change strategy; if it persists, give up cleanly.
  trackLoop(name, args) {
    if (name === "scroll" || name === "wait" || name === "finish") return "ok";
    const signature = name + ":" + JSON.stringify(args || {});
    this.recent.push(signature);
    if (this.recent.length > 6) this.recent.shift();

    const occurrences = this.recent.filter((s) => s === signature).length;
    if (occurrences >= 4) return "stuck";

    if (occurrences >= 3 && !this.nudged.has(signature)) {
      this.nudged.add(signature);
      this.messages.push({
        role: "system",
        content:
          "You are repeating the same action without progress. Stop and reassess: " +
          "call get_page_state to re-read the current page, look for a different " +
          "element or path forward, or call finish if the goal is complete or cannot " +
          "be achieved. Do not ask the user \u2014 decide yourself."
      });
      this.onLog({ type: "thinking", text: "Loop detected \u2014 nudging the agent to re-plan." });
    }
    return "ok";
  }

  async executeTool(name, args) {
    this.onLog({ type: "tool", name, args, step: this.currentStep });
    let result;
    try {
      switch (name) {
        case "get_page_state":
          result = await this.browser.getPageState(args);
          break;
        case "navigate":
          result = await this.browser.navigate(args);
          break;
        case "click":
          result = await this.browser.click(args);
          break;
        case "dblclick":
          result = await this.browser.dblclick(args);
          break;
        case "right_click":
          result = await this.browser.rightClick(args);
          break;
        case "hover":
          result = await this.browser.hover(args);
          break;
        case "type_text":
          result = await this.browser.typeText(args);
          break;
        case "select_option":
          result = await this.browser.selectOption(args);
          break;
        case "check":
          result = await this.browser.check(args);
          break;
        case "focus":
          result = await this.browser.focus(args);
          break;
        case "read":
          result = await this.browser.read(args);
          break;
        case "scroll_into_view":
          result = await this.browser.scrollIntoView(args);
          break;
        case "press_key":
          result = await this.browser.pressKey(args);
          break;
        case "drag":
          result = await this.browser.drag(args);
          break;
        case "evaluate":
          result = await this.browser.evaluate(args.code);
          break;
        case "wait_for":
          result = await this.browser.waitFor(args);
          break;
        case "scroll":
          result = await this.browser.scroll(args);
          break;
        case "wait":
          result = await this.browser.wait(args.ms);
          break;
        case "find":
          result = await this.browser.find(args);
          break;
        case "mouse":
          result = await this.browser.mouse(args);
          break;
        case "keyboard":
          result = await this.browser.keyboard(args);
          break;
        case "upload":
          result = await this.browser.upload(args);
          break;
        case "tabs":
          result = await this.browser.tabs(args);
          break;
        case "cookies":
          result = await this.browser.cookies(args);
          break;
        case "network":
          result = await this.browser.network(args);
          break;
        case "emulate":
          result = await this.browser.emulate(args);
          break;
        case "screenshot":
          result = await this.browser.screenshot(args);
          break;
        case "pdf":
          result = await this.browser.pdf(args);
          break;
        case "download":
          result = await this.browser.download(args);
          break;
        case "console":
          result = await this.browser.console(args);
          break;
        case "dialog":
          result = await this.browser.dialog(args);
          break;
        case "assert":
          result = await this.browser.assert(args);
          break;
        case "inject":
          result = await this.browser.inject(args);
          break;
        case "clipboard":
          result = await this.browser.clipboard(args);
          break;
        case "storage":
          result = await this.browser.storage(args);
          break;
        case "finish":
          result = { __stop: true, ok: true, summary: args.summary };
          break;
        default:
          result = { ok: false, error: "Unknown tool: " + name };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.onLog({ type: "error", text: message, step: this.currentStep });
      result = { ok: false, error: message };
    }

    this.onLog({
      type: "result",
      name,
      step: this.currentStep,
      view: describeResult(name, result)
    });
    return result;
  }
}
