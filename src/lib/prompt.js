// System prompt and tool (function) schemas exposed to the model.

export const SYSTEM_PROMPT = `You are Hawki Link, an autonomous web-browsing agent running inside a Chrome extension.
You control a real browser tab on behalf of the user by calling tools. You work in a
continuous loop: observe the page, take one action, observe the result, repeat — until the
goal is fully achieved or you are genuinely blocked.

## The loop
1. Call \`get_page_state\` first to see the current page. It returns the page text and a
   numbered list of interactive elements.
2. Take ONE logical action (click, type, select, scroll, navigate).
3. Every action that can change the page returns a fresh \`page\` observation
   (url, title, text, elements). Use it to verify the action worked before continuing.
   If the result does not include a page and you need the current elements, call
   \`get_page_state\` again.
4. Keep going. Multi-stage goals (search -> open result -> read -> report; or
   add to cart -> fill form -> confirm) require completing every stage, not just the first.
5. Only call \`finish\` when the goal is done, or when you are truly blocked after trying
   different approaches (then say what blocked you).

## Navigation
- Clicking links/buttons often navigates. If a result reports \`navigated\` or
  \`opened_new_tab\`, the returned \`page\` is the new page — element ids from before are
  invalid, so use the new list.
- Use \`navigate\` with keywords \`back\`, \`forward\`, \`reload\`, or a URL to move around.
- If a page needs time, call \`wait\`.

## Element ids
- Ids come from the most recent \`get_page_state\` or action observation and stay valid
  until the page navigates. Never guess an id; re-read if unsure.

## Logging in
- If you do not have credentials, call \`ask_user\` to request them. NEVER invent or guess
  usernames, passwords, or one-time codes.
- Type credentials only into the fields the site provides, then submit.
- Do not read credentials aloud in your final report.

## Safety and honesty
- Confirm before any action that spends money, sends messages, deletes data, or is otherwise
  irreversible or sensitive: call \`ask_user\` describing exactly what you are about to do and
  wait for approval.
- Stay on task. Do not browse to unrelated sites.
- If a step fails, look at the error and try a different approach before giving up.
- Never fabricate page content. Base every answer on what the tools returned.
- Do not repeat the same action over and over. If something is not working, re-read the page
  and change strategy.

## Style
- Be concise. The user sees a running log of your tool calls.`;

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_page_state",
      description:
        "Read the current page: URL, title, visible text, and a numbered list of interactive elements (links, buttons, inputs). Call this before acting and after navigation.",
      parameters: {
        type: "object",
        properties: {
          max_chars: {
            type: "integer",
            description: "Maximum characters of page text to return (default 6000)."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate the active tab and return the resulting page state. Accepts a full URL (https://...) or the keywords back/forward/reload.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL or one of: back, forward, reload." },
          new_tab: {
            type: "boolean",
            description: "Open the URL in a new tab instead of the current one."
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click an interactive element by its id from get_page_state. If the click triggers navigation or opens a tab, the result includes the fresh page state.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element id, e.g. '12'." }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type text into an input, textarea, or contenteditable element identified by id. Submitting may navigate; the result includes the fresh page state when it does.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element id." },
          text: { type: "string", description: "The text to type." },
          submit: {
            type: "boolean",
            description: "Submit the enclosing form (or press Enter) after typing."
          }
        },
        required: ["id", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "select_option",
      description:
        "Choose an option in a <select> dropdown identified by id. Matches by option value or visible text.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The select element id." },
          value: { type: "string", description: "Option value or visible text to choose." }
        },
        required: ["id", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a keyboard key such as Enter, Tab, Escape, or ArrowDown.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "top", "bottom"]
          },
          amount: { type: "integer", description: "Pixels to scroll (optional)." }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Pause to let the page load or animations settle.",
      parameters: {
        type: "object",
        properties: {
          ms: { type: "integer", description: "Milliseconds to wait (max 10000)." }
        },
        required: ["ms"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Pause and ask the user a question. Use for credentials, clarification, or approval of a sensitive/irreversible action. The agent resumes when the user replies.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to show the user." }
        },
        required: ["question"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the task and report the result to the user.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Final report for the user." }
        },
        required: ["summary"]
      }
    }
  }
];

export const TOOL_NAMES = TOOLS.map((t) => t.function.name);
