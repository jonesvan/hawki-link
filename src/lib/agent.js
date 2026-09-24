// The agent loop: drives the LLM and executes browser tools until the task is
// finished, paused for user input, or aborted.

import { chatCompletion } from "./deepseek.js";
import { SYSTEM_PROMPT, TOOLS } from "./prompt.js";

export class Agent {
  /**
   * @param {object} opts
   * @param {object} opts.settings  { apiKey, baseUrl, model, temperature, maxSteps }
   * @param {object} opts.browser   Tool implementation (see background.js).
   * @param {(entry:object)=>void} [opts.onLog]
   * @param {(question:string)=>Promise<string>} [opts.onAsk]
   * @param {(summary:string)=>void} [opts.onFinish]
   */
  constructor({ settings, browser, onLog, onAsk, onFinish }) {
    this.settings = settings;
    this.browser = browser;
    this.onLog = onLog || (() => {});
    this.onAsk = onAsk || (async () => "The user did not respond.");
    this.onFinish = onFinish || (() => {});
    this.abort = new AbortController();
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  stop(reason = "Stopped by user.") {
    this.abort.abort();
    this.stopReason = reason;
  }

  async run(goal) {
    this.messages.push({ role: "user", content: goal });
    const maxSteps = this.settings.maxSteps || 25;

    for (let step = 0; step < maxSteps; step++) {
      if (this.abort.signal.aborted) {
        this.onFinish(this.stopReason || "Stopped.");
        return;
      }
      this.onLog({ type: "thinking", step: step + 1 });

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

      if (msg.content) {
        this.onLog({ type: "assistant", text: msg.content });
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
      }
    }

    this.onFinish(`Stopped after reaching the ${maxSteps}-step limit.`);
  }

  async executeTool(name, args) {
    this.onLog({ type: "tool", name, args });
    try {
      switch (name) {
        case "get_page_state":
          return await this.browser.getPageState(args);
        case "navigate":
          return await this.browser.navigate(args);
        case "click":
          return await this.browser.click(args.id);
        case "type_text":
          return await this.browser.typeText(args.id, args.text, args.submit);
        case "select_option":
          return await this.browser.selectOption(args.id, args.value);
        case "press_key":
          return await this.browser.pressKey(args.key);
        case "scroll":
          return await this.browser.scroll(args.direction, args.amount);
        case "wait":
          return await this.browser.wait(args.ms);
        case "ask_user": {
          this.onLog({ type: "ask", text: args.question });
          const answer = await this.onAsk(args.question);
          return { ok: true, answer };
        }
        case "finish":
          return { __stop: true, ok: true, summary: args.summary };
        default:
          return { ok: false, error: "Unknown tool: " + name };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.onLog({ type: "error", text: message });
      return { ok: false, error: message };
    }
  }
}
