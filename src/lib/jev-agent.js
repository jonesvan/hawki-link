// A fully Jev-driven agent: the observe -> decide -> act loop uses only System
// One primitives (Choice, Score, Noul) from the TypeSafe model. There is no
// text model in the loop, so every step is a typed decision. Because Jev cannot
// generate free text, candidate values the agent may need (element targets,
// URLs, text to type) are enumerated in code and the model selects among them.

import { systemOne, choice, noul } from "./typesafe.js";
import { describeResult } from "./agent.js";

const FINISH_NOUL = 0.85; // "goal achieved" probability that ends the run
const STUCK_LIMIT = 4; // repeats of the same action before giving up
const NUDGE_AT = 3; // repeats before the state warns the model

// Action catalog. `label` is shown to the model as a Choice option; `needs`
// lists the arguments the code will look up from the other answers.
const ACTIONS = [
  { name: "click", label: "Click an element (button, link, tab, menu item).", needs: ["target"] },
  { name: "type_text", label: "Type text into an input, textarea, or rich editor.", needs: ["target", "text", "submit"] },
  { name: "select_option", label: "Choose an option in a dropdown.", needs: ["target", "select"] },
  { name: "check", label: "Check or uncheck a checkbox or radio button.", needs: ["target", "checkbox"] },
  { name: "press_key", label: "Press a keyboard key or combo (Enter, Tab, Escape, Control+A).", needs: ["key"] },
  { name: "hover", label: "Hover over an element to reveal a menu or tooltip.", needs: ["target"] },
  { name: "dblclick", label: "Double-click an element.", needs: ["target"] },
  { name: "read", label: "Read one element's text and value by id.", needs: ["target"] },
  { name: "scroll_into_view", label: "Scroll an element into view.", needs: ["target"] },
  { name: "scroll", label: "Scroll the page up, down, to the top, or to the bottom.", needs: ["scroll"] },
  { name: "navigate", label: "Go to one of the candidate URLs.", needs: ["url"] },
  { name: "back", label: "Go back to the previous page.", needs: [] },
  { name: "forward", label: "Go forward to the next page.", needs: [] },
  { name: "reload", label: "Reload the current page.", needs: [] },
  { name: "wait", label: "Pause briefly to let the page load or animations settle.", needs: [] },
  { name: "wait_for", label: "Wait until some text appears on the page.", needs: ["text"] },
  { name: "get_page_state", label: "Re-read the page (URL, text, elements) when the current view is stale.", needs: [] },
  { name: "finish", label: "The goal is fully achieved and the agent should report the result.", needs: [] }
];

const ACTION_BY_NAME = Object.fromEntries(ACTIONS.map((a) => [a.name, a]));

const SCROLL_DIRECTIONS = {
  up: "Scroll up a little.",
  down: "Scroll down a little.",
  top: "Scroll to the top of the page.",
  bottom: "Scroll to the bottom of the page."
};

const KEY_CHOICES = {
  Enter: "Press Enter (submit the focused form).",
  Tab: "Press Tab (move focus to the next field).",
  Escape: "Press Escape (close a menu or dialog).",
  ArrowDown: "Press the Down arrow.",
  ArrowUp: "Press the Up arrow.",
  "Control+A": "Select all (Control+A).",
  Backspace: "Press Backspace."
};

const CHECK_CHOICES = {
  check: "Check (tick) the checkbox or radio button.",
  uncheck: "Uncheck (clear) the checkbox or radio button."
};

const SUBMIT_CHOICES = {
  submit: "Submit after typing (press Enter / submit the form).",
  keep: "Type only; do not submit."
};

const STATE_TEXT_CHARS = 3500;
const MAX_ELEMENTS = 60;
const MAX_TARGET_OPTIONS = 120;

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "\u2026" : str;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

// Enumerate free-text values the model may choose to type. Since Jev cannot
// generate strings, we offer substrings of the goal (quoted phrases first, then
// the goal with common command verbs stripped) plus text harvested from pages
// the agent has already visited (so it can copy a value it read into a field).
function extractTextCandidates(goal) {
  const out = [];
  const add = (v) => {
    const t = String(v || "").replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  };

  const quoted = String(goal || "").match(/["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{1,120})["'\u201c\u201d\u2018\u2019]/g) || [];
  for (const q of quoted) add(q.replace(/^["'\u201c\u201d\u2018\u2019]|["'\u201c\u201d\u2018\u2019]$/g, ""));

  const stripped = String(goal || "")
    .replace(/^\s*(please\s+)?(go\s+to|navigate\s+to|open|visit|search\s+for|search|google|look\s+up|find|type|enter)\s+/i, "")
    .trim();
  add(stripped);
  add(goal);

  return out.slice(0, 20);
}

// Break a goal into atomic requirements ("do A, then do B, then do C") so
// completion can be checked one requirement at a time instead of trusting a
// single overall judgment.
function splitGoalClauses(goal) {
  const parts = String(goal || "")
    .split(/\s+then\s+|;\s*/i)
    .map((s) => s.replace(/^[\s,]+|[\s,]+$/g, "").trim())
    .filter((s) => s.length >= 8);
  return parts.length > 1 ? parts.slice(0, 6) : [];
}

// Break page text into short, reusable strings: whole lines when they are short,
// otherwise sentences. Used to populate the agent's clipboard.
function harvestStrings(text) {
  const out = [];
  const add = (v) => {
    const t = String(v || "").replace(/\s+/g, " ").trim();
    if (t.length >= 8 && t.length <= 260 && !out.includes(t)) out.push(t);
  };
  for (const line of String(text || "").split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed.length <= 260) add(trimmed);
    else for (const s of trimmed.split(/(?<=[.!?])\s+/)) add(s);
  }
  return out;
}

// Extract candidate URLs from anchor elements and the goal.
function extractUrlCandidates(page, goal) {
  const out = [];
  const add = (v) => {
    const t = String(v || "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  for (const m of String(goal || "").match(/https?:\/\/[^\s"')]+/g) || []) add(m);

  let base;
  try {
    base = new URL(page?.url || "about:blank");
  } catch (_) {
    base = null;
  }
  for (const el of page?.elements || []) {
    const href = /href=([^ |]+)/i.exec(el.text || "");
    if (!href) continue;
    try {
      add(new URL(href[1], base || undefined).href);
    } catch (_) {
      add(href[1]);
    }
    if (out.length >= 40) break;
  }
  add("back");
  add("forward");
  add("reload");
  return out;
}

export class JevAgent {
  /**
   * @param {object} opts
   * @param {object} opts.settings  { jevApiKey, jevBaseUrl, jevModel, jevConfidence, maxSteps }
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
    this.page = null;
    this.clipboard = []; // short strings harvested from pages already visited
    this.recent = [];
    this.nudged = new Set();
    this.currentStep = 0;
    this.lowConfidence = 0;
  }

  stop(reason = "Stopped by user.") {
    this.abort.abort();
    this.stopReason = reason;
  }

  get threshold() {
    const t = Number(this.settings.jevConfidence);
    return Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.3;
  }

  setPage(page) {
    if (!page) return;
    this.page = page;
    this.harvest(page.text || "");
  }

  // Remember short strings from pages we have read so they can be offered as
  // things to type later (Jev cannot author them itself).
  harvest(text) {
    for (const s of harvestStrings(text)) {
      const idx = this.clipboard.indexOf(s);
      if (idx !== -1) this.clipboard.splice(idx, 1);
      this.clipboard.unshift(s);
    }
    if (this.clipboard.length > 80) this.clipboard.length = 80;
  }

  // Candidate free-text values for the `text` Choice question, capped so the
  // option list stays manageable: goal-derived values first, then page excerpts.
  textCandidates() {
    const out = extractTextCandidates(this.goal);
    for (const s of this.clipboard) {
      if (out.length >= 24) break;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  async run(goal) {
    const maxSteps = this.settings.maxSteps || 40;
    this.goal = goal;

    try {
      this.setPage(await this.browser.getPageState({ max_chars: STATE_TEXT_CHARS }));
      this.onLog({ type: "result", name: "get_page_state", step: 0, view: describeResult("get_page_state", this.page) });
    } catch (err) {
      this.onFinish("Could not read the page: " + err.message);
      return;
    }

    for (let step = 0; step < maxSteps; step++) {
      if (this.abort.signal.aborted) {
        this.onFinish(this.stopReason || "Stopped.");
        return;
      }
      this.currentStep = step + 1;
      this.onLog({ type: "thinking", step: this.currentStep });

      let decision;
      try {
        decision = await this.decide();
      } catch (err) {
        if (err.name === "AbortError") {
          this.onFinish(this.stopReason || "Stopped.");
          return;
        }
        this.onLog({ type: "error", text: err.message });
        this.onFinish("Agent error: " + err.message);
        return;
      }

      this.onLog({ type: "reasoning", step: this.currentStep, text: decision.explain });
      this.onLog({ type: "assistant", step: this.currentStep, text: decision.summary });

      if (decision.kind === "finish") {
        await this.report();
        return;
      }

      const result = await this.act(decision);
      if (result === undefined) {
        // act() already finished the run (e.g. loop detected).
        return;
      }

      const verdict = this.trackLoop(decision.action, decision.args);
      if (verdict === "stuck") {
        this.onFinish(
          `I stopped because I kept repeating the same action (${decision.action}) ` +
            "without making progress. Jev is a decision model, so the task may need a " +
            "more specific goal or a different starting page."
        );
        return;
      }
    }

    this.onFinish(`Stopped after reaching the ${maxSteps}-step limit.`);
  }

  // One System One request that asks every decision the loop may need.
  async decide() {
    const elements = (this.page?.elements || []).slice(0, MAX_ELEMENTS);
    const state = this.buildState(elements);
    const { questions, urls, texts, selects } = this.buildQuestions(elements);

    const res = await systemOne({
      apiKey: this.settings.jevApiKey,
      baseUrl: this.settings.jevBaseUrl,
      model: this.settings.jevModel,
      state,
      questions,
      signal: this.abort.signal
    });

    const answers = res.answers;
    const actionAns = answers.next_action;
    const done = Number(answers.done?.noul ?? 0);
    const conf = Number(actionAns?.confidence ?? 0);

    // Completion requires every atomic requirement to be satisfied.
    const clauses = splitGoalClauses(this.goal);
    const unmet = [];
    let doneAll = done;
    clauses.forEach((c, i) => {
      const n = Number(answers["req_" + i]?.noul ?? 1);
      if (n < 0.5) unmet.push(`${c} (${n.toFixed(2)})`);
      doneAll = Math.min(doneAll, n);
    });

    const parts = [`done=${done.toFixed(2)}`, `progress=${doneAll.toFixed(2)}`];
    if (actionAns) parts.push(`action=${actionAns.choice}(${conf.toFixed(2)})`);
    if (unmet.length) parts.push(`unmet: ${unmet.join(" | ")}`);

    // Completion is a strong signal; only a confident non-finish action overrides it.
    if (actionAns && actionAns.choice === "finish" && doneAll >= 0.5) {
      return {
        kind: "finish",
        summary: "Goal looks complete; preparing the report.",
        explain: `Jev chose finish. (${parts.join(", ")})`
      };
    }
    if (doneAll >= FINISH_NOUL) {
      return {
        kind: "finish",
        summary: "Goal looks complete; preparing the report.",
        explain: `Jev is confident every requirement is met. (${parts.join(", ")})`
      };
    }

    let name = actionAns?.choice;
    if (!ACTION_BY_NAME[name] || conf < this.threshold) {
      this.lowConfidence += 1;
      const reason =
        !actionAns
          ? "no action answer"
          : `low confidence ${conf.toFixed(2)} < ${this.threshold}`;
      name = "get_page_state";
      this.onLog({ type: "error", text: `Uncertain next action (${reason}); re-reading the page.` });
    } else {
      this.lowConfidence = 0;
    }

    const picked = this.resolveArgs(name, answers, { urls, texts, elements }, parts);
    if (picked.error) {
      this.onLog({ type: "error", text: picked.error + " Re-reading the page." });
      return { kind: "act", action: "get_page_state", args: {}, summary: "Re-read the page.", explain: picked.error };
    }

    return {
      kind: "act",
      action: name,
      args: picked.args,
      summary: picked.summary,
      explain: `Jev decided: ${name} ${stableJson(picked.args)} (${parts.join(", ")})`
    };
  }

  // Resolve the arguments a chosen action needs from the parallel answers.
  resolveArgs(name, answers, candidates, parts) {
    const args = {};
    const need = ACTION_BY_NAME[name]?.needs || [];

    const targetAnswer = answers.target;
    if (need.includes("target")) {
      const id = targetAnswer?.choice;
      const tconf = Number(targetAnswer?.confidence ?? 0);
      if (!id || tconf < this.threshold) {
        return { error: `No confident target element for ${name} (${parts.join(", ")}).` };
      }
      args.id = id;
      parts.push(`target=${id}(${tconf.toFixed(2)})`);
    }

    if (need.includes("text")) {
      const text = answers.text?.choice;
      if (!text) return { error: `No text available to type for ${name}.` };
      args.text = text;
      parts.push(`text=${JSON.stringify(truncate(text, 40))}`);
    }

    if (need.includes("submit")) {
      const target = (candidates.elements || []).find((e) => String(e.id) === String(args.id));
      // Pressing Enter in a textarea inserts a newline rather than submitting, and
      // multi-field forms (e.g. a note) should be saved with their own button.
      args.submit = target && target.tag === "textarea" ? false : answers.submit?.choice !== "keep";
    }

    if (need.includes("select")) {
      const value = answers.select?.choice;
      if (!value) return { error: `No dropdown option available for ${name}.` };
      args.value = value;
      parts.push(`value=${JSON.stringify(truncate(value, 40))}`);
    }

    if (need.includes("checkbox")) {
      args.checked = answers.checkbox?.choice !== "uncheck";
    }

    if (need.includes("key")) {
      const keys = answers.key?.choice;
      if (!keys) return { error: `No key available to press for ${name}.` };
      args.keys = keys;
    }

    if (need.includes("scroll")) {
      args.direction = answers.scroll?.choice || "down";
    }

    if (need.includes("url")) {
      const url = answers.url?.choice;
      if (!url) return { error: `No URL available for ${name}.` };
      args.url = url;
      parts.push(`url=${truncate(url, 60)}`);
    }

    const target = args.id ?? args.url ?? args.keys ?? name;
    return { args, summary: `${name}: ${truncate(target, 80)}`, error: null };
  }

  async act(decision) {
    this.onLog({ type: "tool", name: decision.action, args: decision.args, step: this.currentStep });

    let result;
    try {
      result = await this.execute(decision.action, decision.args);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.onLog({ type: "error", text: message, step: this.currentStep });
      result = { ok: false, error: message };
    }

    if (result && result.__stop) {
      this.onFinish(result.summary);
      return undefined;
    }

    // Keep the best observation available: a fresh page if the action returned
    // one, otherwise re-read after actions that change the DOM.
    if (result && result.page) {
      this.setPage(result.page);
    } else if (decision.action === "get_page_state") {
      this.setPage(result);
    } else if (["click", "dblclick", "type_text", "select_option", "check", "press_key", "hover"].includes(decision.action)) {
      try {
        this.setPage(await this.browser.getPageState({ max_chars: STATE_TEXT_CHARS }));
      } catch (_) {
        // Keep the previous observation.
      }
    }

    this.onLog({
      type: "result",
      name: decision.action,
      step: this.currentStep,
      view: describeResult(decision.action, result)
    });
    return result;
  }

  execute(name, args) {
    switch (name) {
      case "get_page_state":
        return this.browser.getPageState({ max_chars: STATE_TEXT_CHARS });
      case "navigate":
        return this.browser.navigate({ url: args.url });
      case "back":
        return this.browser.navigate({ url: "back" });
      case "forward":
        return this.browser.navigate({ url: "forward" });
      case "reload":
        return this.browser.navigate({ url: "reload" });
      case "click":
        return this.browser.click(args.id);
      case "dblclick":
        return this.browser.dblclick(args.id);
      case "hover":
        return this.browser.hover(args.id);
      case "type_text":
        return this.browser.typeText(args.id, args.text, !!args.submit);
      case "select_option":
        return this.browser.selectOption(args.id, args.value);
      case "check":
        return this.browser.check(args.id, args.checked);
      case "read":
        return this.browser.read(args.id);
      case "scroll_into_view":
        return this.browser.scrollIntoView(args.id);
      case "press_key":
        return this.browser.pressKey(args.keys);
      case "scroll":
        return this.browser.scroll(args.direction, args.amount);
      case "wait_for":
        return this.browser.waitFor("text", args.text);
      case "wait":
        return this.browser.wait(1000);
      default:
        return { ok: false, error: "Unknown action: " + name };
    }
  }

  buildState(elements) {
    return {
      goal: this.goal,
      requirements: splitGoalClauses(this.goal),
      step: this.currentStep,
      url: this.page?.url || "",
      title: this.page?.title || "",
      page_text: truncate(this.page?.text || "", STATE_TEXT_CHARS),
      interactive_elements: elements.map((e) => ({
        id: e.id,
        kind: e.tag,
        label: truncate(e.text || "", 140),
        value: e.value,
        options: e.options
      })),
      recent_actions: this.recent.slice(-6)
    };
  }

  buildQuestions(elements) {
    const questions = {
      done: noul({
        question: "Based on `page_text`, `title`, `url`, and `interactive_elements`, has this goal been fully achieved:",
        goal: "`goal`",
        requirements: "`requirements`",
        guidance:
          "Answer yes only if every requirement is satisfied and nothing further needs to be done."
      }),
      next_action: choice(
        {
          question: "What is the single best next action to make progress on this goal:",
          goal: "`goal`",
          current_page: "`title` (`url`)",
          guidance:
            "Choose one action from the options. Prefer acting over re-reading. Choose finish only when the goal is fully achieved."
        },
        Object.fromEntries(ACTIONS.map((a) => [a.name, a.label]))
      )
    };

    const targetOptions = {};
    for (const el of elements) {
      if (!el.id) continue;
      const desc = `${el.tag} "${truncate(el.text || "", 120)}"` + (el.value ? ` value="${truncate(el.value, 60)}"` : "");
      targetOptions[String(el.id)] = desc;
      if (Object.keys(targetOptions).length >= MAX_TARGET_OPTIONS) break;
    }
    if (Object.keys(targetOptions).length) {
      questions.target = choice(
        {
          question: "Which element is the best target for the next action? Answer with the element id.",
          goal: "`goal`",
          guidance: "Pick the single element that advances the goal. Ignore this if the action needs no target."
        },
        targetOptions
      );
    }

    const urls = extractUrlCandidates(this.page, this.goal);
    const urlOptions = {};
    for (const u of urls) urlOptions[u] = u === "back" || u === "forward" || u === "reload" ? `Browser: go ${u}.` : u;
    questions.url = choice(
      {
        question: "If the next action is navigate, which URL should be opened?",
        goal: "`goal`",
        guidance: "Use only these candidate URLs. Ignore this question if you are not navigating."
      },
      urlOptions
    );

    const texts = this.textCandidates();
    if (texts.length) {
      const textOptions = {};
      for (const t of texts) textOptions[t] = t;
      questions.text = choice(
        {
          question: "If the next action types text into a field, which text should be typed?",
          goal: "`goal`",
          guidance: "These are candidate texts derived from the goal. Ignore if you are not typing."
        },
        textOptions
      );
    }

    const selectOptions = {};
    for (const el of elements) {
      if (el.tag !== "select" || !Array.isArray(el.options)) continue;
      for (const o of el.options) selectOptions[String(o)] = String(o);
      if (Object.keys(selectOptions).length >= 80) break;
    }
    if (Object.keys(selectOptions).length) {
      questions.select = choice(
        {
          question: "If the next action selects a dropdown option, which option should be chosen?",
          goal: "`goal`",
          guidance: "Ignore if the next action does not use a dropdown."
        },
        selectOptions
      );
    }

    questions.checkbox = choice(
      "If the next action checks a checkbox or radio button, should it be checked or unchecked?",
      CHECK_CHOICES
    );
    questions.submit = choice(
      {
        question: "If the next action types text, should Enter be pressed to submit the form afterwards?",
        goal: "`goal`",
        guidance:
          "Choose submit only for a search box when the goal is to search. Choose keep when filling a multi-field form such as a note, then use its Save/Submit button."
      },
      SUBMIT_CHOICES
    );
    questions.scroll = choice("If the next action scrolls, which direction?", SCROLL_DIRECTIONS);
    questions.key = choice("If the next action presses a key, which key?", KEY_CHOICES);

    // One Noul per atomic requirement, so completion is checked step by step.
    const clauses = splitGoalClauses(this.goal);
    clauses.forEach((_, i) => {
      questions["req_" + i] = noul({
        question: "Has this single requirement been fully completed based on the current page and `recent_actions`:",
        requirement: "`requirements[" + i + "]`",
        guidance: "Answer yes only when this requirement is fully satisfied."
      });
    });

    return { questions, urls, texts, selects: selectOptions };
  }

  // Build a final answer in code, since Jev cannot write prose: ask it, per
  // excerpt, whether that excerpt answers the goal, then report the best one.
  async report() {
    const page = this.page || {};
    let summary = `Reached "${page.title || page.url || "the page"}".`;
    const chunks = buildChunks(page.text || "").slice(0, 24);

    if (chunks.length) {
      try {
        const state = { goal: this.goal, url: page.url || "", title: page.title || "" };
        const questions = {};
        chunks.forEach((c, i) => {
          state["excerpt_" + i] = truncate(c, 400);
          questions["c" + i] = noul({
            question: "Does this excerpt contain the answer to the goal:",
            goal: "`goal`",
            excerpt: "`excerpt_" + i + "`",
            guidance: "Answer yes only if the excerpt is directly responsive to the goal."
          });
        });

        const { answers } = await systemOne({
          apiKey: this.settings.jevApiKey,
          baseUrl: this.settings.jevBaseUrl,
          model: this.settings.jevModel,
          state,
          questions,
          signal: this.abort.signal
        });

        let best = -1;
        let bestScore = 0;
        chunks.forEach((_, i) => {
          const n = Number(answers["c" + i]?.noul ?? 0);
          if (n > bestScore) {
            bestScore = n;
            best = i;
          }
        });

        if (best >= 0 && bestScore >= 0.5) {
          summary =
            `Result (${Math.round(bestScore * 100)}% confidence): ` + chunks[best];
        }
      } catch (_) {
        // Fall back to the page-level summary.
      }
    }

    if (page.url) summary += `\n${page.title ? page.title + " \u2014 " : ""}${page.url}`;
    this.onFinish(summary.trim());
  }

  trackLoop(name, args) {
    if (name === "get_page_state" || name === "scroll" || name === "wait" || name === "wait_for") {
      return "ok";
    }
    const signature = name + ":" + stableJson(args || {});
    this.recent.push(signature);
    if (this.recent.length > 6) this.recent.shift();

    const occurrences = this.recent.filter((s) => s === signature).length;
    if (occurrences >= STUCK_LIMIT) return "stuck";

    if (occurrences >= NUDGE_AT && !this.nudged.has(signature)) {
      this.nudged.add(signature);
      this.onLog({ type: "thinking", text: "Loop detected \u2014 Jev will see its recent actions and re-plan." });
    }
    return "ok";
  }
}

// Split page text into paragraph-sized chunks, falling back to sentences.
function buildChunks(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  let chunks = clean
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 40);
  if (chunks.length < 4) {
    chunks = clean
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 40);
  }
  return chunks.slice(0, 40);
}
