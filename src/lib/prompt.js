// System prompt and tool (function) schemas exposed to the model.

export const SYSTEM_PROMPT = `You are Hawki Link, an autonomous web-browsing agent running inside a Chrome extension.
You control a real browser tab by calling tools. You work in a continuous loop: observe,
act, observe, repeat — until the goal is fully achieved. Work autonomously and as fast as
possible: make decisions yourself, never wait for or request user input.

## Speed rules
- Do NOT ask the user anything. There is no asking tool. Decide and proceed.
- Prefer going straight to the right page. If you know a URL pattern, use \`navigate\`
  directly instead of clicking through a search flow (e.g. navigate to
  "https://www.google.com/search?q=..." or "https://scholar.google.com/scholar?q=...").
- Take the shortest path to the goal. Avoid re-reading pages you already understand.
- Batch independent work: it is fine to make several tool calls in one turn when they do
  not depend on each other.
- Keep moving. Only \`get_page_state\` when you actually need the element list.

## The loop
1. Call \`get_page_state\` (or read the returned \`page\`) to see the current page: URL, title,
   text, and a numbered list of interactive elements.
2. Take action. Available actions: click, dblclick, right_click, hover, type_text,
   select_option, check, focus, press_key (incl. combos like Control+A), drag,
   scroll, scroll_into_view, navigate, read, evaluate, wait, wait_for. Plus the
   advanced layer: find (CSS/XPath/text/role locators), mouse, keyboard, upload,
   tabs, cookies, network (headers/auth/offline/mock), emulate, screenshot, pdf,
   download, console, dialog, assert, inject, clipboard, storage.
3. Actions that change the page return a fresh \`page\` observation. Verify and continue.
4. Complete EVERY stage of multi-step goals (search -> open -> read -> report; or
   add to cart -> check out -> confirm).
5. Call \`finish\` with the result as soon as the goal is achieved. If truly blocked after
   trying alternatives, call \`finish\` explaining what blocked you.

## Navigation
- Clicking often navigates. If a result reports \`navigated\` or \`opened_new_tab\`, the
  returned \`page\` is the new page and old element ids are invalid — use the new ones.
- Use \`navigate\` with a URL or the keywords \`back\`, \`forward\`, \`reload\`.
- Dialogs (alert/confirm/prompt/print) are auto-handled; their text appears in the result.

## Advanced capabilities
- Any action that takes an id also accepts a locator directly (\`by\`, \`value\`, optional \`nth\`/\`exact\`), or use \`find\` to resolve locators to ids first.
- Input is trusted (real browser events), so canvas apps and sites that check isTrusted work.
- \`upload\` attaches files; \`download\` waits for/saves downloads; \`console\` reads page errors and logs.
- \`network\` mocks/blocks/sets headers/authenticates/goes offline; \`emulate\` sets viewport, dark mode, geolocation, timezone, locale.
- \`screenshot\`/\`pdf\` save to the Downloads folder and return the path.
- \`assert\` verifies conditions (text/url/title/visible/enabled/value) and reports pass/fail.

## Element ids
- Ids come from the most recent observation and stay valid until the page navigates.
  Never guess an id; re-read if unsure.
- Ids may be prefixed with a frame number (e.g. \`3:12\`). Pass ids back exactly as
  shown — the prefix is how content inside iframes (rich editors, embedded widgets)
  is targeted. Text and elements from all frames are merged into one observation.

## Autonomy
- Do not wait for approval. If the goal clearly requires submitting a form or confirming an
  action, do it. Prefer the least destructive path that still completes the goal.
- Stay on task. Do not browse unrelated sites.
- On failure, read the error and try a different approach. Never repeat a failing action.
- Never fabricate page content. Base every answer on what the tools returned.
- If a site requires credentials you do not have, finish and say so; do not guess passwords.

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
        "Type text into an input, textarea, or rich contenteditable editor (even inside an iframe) identified by id. For long text (e.g. an essay) pass the whole text in one call. Submitting may navigate; the result includes the fresh page state when it does.",
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
      name: "hover",
      description: "Move the pointer over an element (reveals menus, tooltips, hover-only actions).",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "dblclick",
      description: "Double-click an element (e.g. edit-in-place, select word).",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "right_click",
      description: "Right-click an element to open its context menu.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check",
      description: "Check or uncheck a checkbox or radio button by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          checked: { type: "boolean", description: "true to check (default), false to uncheck." }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "focus",
      description: "Focus an element (input, button, link) without clicking it.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read one element's text, value, checked state and key attributes by id. Use for precise values instead of guessing from the snapshot.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_into_view",
      description: "Scroll an element into the middle of the viewport.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "drag",
      description: "Drag one element onto another (sliders, sortable lists, kanban boards, drag-and-drop).",
      parameters: {
        type: "object",
        properties: {
          from_id: { type: "string" },
          to_id: { type: "string" }
        },
        required: ["from_id", "to_id"]
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
      description:
        "Press a key or key combination, e.g. \"Enter\", \"Tab\", \"Escape\", \"ArrowDown\", \"Control+A\", \"Shift+Enter\".",
      parameters: {
        type: "object",
        properties: { keys: { type: "string", description: "Key or combo, e.g. Control+A." } },
        required: ["keys"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "evaluate",
      description:
        "Run a JavaScript expression in the page and return its JSON value. Powerful fallback for anything the other tools cannot do. Subject to the page's CSP.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "A JS expression, e.g. document.title." }
        },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait_for",
      description:
        "Wait until a condition is true, instead of blindly waiting. type is 'text', 'selector', or 'url'; value is what to wait for.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "selector", "url"] },
          value: { type: "string" },
          timeout_ms: { type: "integer", description: "Max wait in ms (default 10000)." }
        },
        required: ["type", "value"]
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
      name: "find",
      description:
        "Locate elements by a real selector instead of a snapshot id, and get their ids. Use when the numbered list is ambiguous or you know the DOM. by is one of css, xpath, text, role, label, placeholder, testid, alt, title.",
      parameters: {
        type: "object",
        properties: {
          by: { type: "string", enum: ["css", "xpath", "text", "role", "label", "placeholder", "testid", "alt", "title"] },
          value: { type: "string", description: "The selector / text / role to match." },
          exact: { type: "boolean", description: "Exact text match (default true for text/placeholder)." },
          nth: { type: "integer", description: "Which match to return an id for." },
          max: { type: "integer", description: "Max matches to return (default 20)." }
        },
        required: ["by", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mouse",
      description:
        "Low-level trusted mouse input at viewport coordinates. op is move, down, up, click, or wheel. Use for canvas apps, sliders, or held-button gestures.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["move", "down", "up", "click", "wheel"] },
          x: { type: "integer" },
          y: { type: "integer" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          click_count: { type: "integer" },
          delta_x: { type: "integer" },
          delta_y: { type: "integer" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "keyboard",
      description:
        "Trusted keyboard input. op=press to press a key/combo (e.g. Control+A), op=insert to insert literal text at the caret.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["press", "insert"] },
          keys: { type: "string", description: "Key or combo, e.g. Enter, Control+A." },
          text: { type: "string", description: "Literal text for op=insert." }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "upload",
      description: "Attach local files to a file input by element id. files is a list of absolute paths.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        },
        required: ["id", "files"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tabs",
      description: "Manage browser tabs. op=list, op=new (url, active), op=activate (id), op=close (id).",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "new", "activate", "close"] },
          id: { type: "integer" },
          url: { type: "string" },
          active: { type: "boolean" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cookies",
      description: "Read or change cookies. op=get (url or domain), set (url, name, value), remove (url, name), clear (url or domain).",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["get", "set", "remove", "clear"] },
          url: { type: "string" },
          domain: { type: "string" },
          name: { type: "string" },
          value: { type: "string" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "network",
      description:
        "Control network behavior. op=set_headers (headers map), auth (username, password) for HTTP basic auth, offline/online, throttle (latency, download_throughput, upload_throughput), block (urls), route (pattern, status, body, content_type, abort) to mock, unroute.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["set_headers", "auth", "offline", "online", "throttle", "block", "route", "unroute"] },
          headers: { type: "object" },
          username: { type: "string" },
          password: { type: "string" },
          latency: { type: "number" },
          download_throughput: { type: "number" },
          upload_throughput: { type: "number" },
          urls: { type: "array", items: { type: "string" } },
          pattern: { type: "string" },
          status: { type: "integer" },
          body: { type: "string" },
          content_type: { type: "string" },
          abort: { type: "boolean" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "emulate",
      description:
        "Emulate device/media/environment. viewport (width,height or 'reset'), color_scheme (dark/light), reduced_motion, geolocation {latitude,longitude}, timezone, locale, user_agent.",
      parameters: {
        type: "object",
        properties: {
          viewport: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
          device_scale_factor: { type: "number" },
          mobile: { type: "boolean" },
          color_scheme: { type: "string", enum: ["dark", "light", "no-preference"] },
          reduced_motion: { type: "string", enum: ["reduce", "no-preference"] },
          geolocation: { type: "object" },
          timezone: { type: "string" },
          locale: { type: "string" },
          user_agent: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture a screenshot and save it to the downloads folder. full_page for the whole page, format png/jpeg.",
      parameters: {
        type: "object",
        properties: {
          full_page: { type: "boolean" },
          format: { type: "string", enum: ["png", "jpeg"] },
          quality: { type: "integer" },
          filename: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pdf",
      description: "Print the current page to a PDF file in the downloads folder.",
      parameters: {
        type: "object",
        properties: {
          landscape: { type: "boolean" },
          print_background: { type: "boolean" },
          filename: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download",
      description: "Wait for a click-triggered download (returns where it was saved), or save a URL with action=save (url, filename).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["wait", "save"] },
          url: { type: "string" },
          filename: { type: "string" },
          url_part: { type: "string" },
          timeout_ms: { type: "integer" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "console",
      description: "Read console messages and uncaught exceptions captured from the page.",
      parameters: {
        type: "object",
        properties: { clear: { type: "boolean", description: "Clear after reading (default true)." } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "dialog",
      description: "Set how the next native dialogs are handled: confirm (accept/dismiss) and the text returned to prompt().",
      parameters: {
        type: "object",
        properties: {
          confirm: { type: "string", enum: ["accept", "dismiss"] },
          prompt: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "assert",
      description:
        "Check conditions and report pass/fail instead of acting. checks is a list of {kind, value, selector|id}. kind is text, url, title, visible, enabled, value.",
      parameters: {
        type: "object",
        properties: {
          checks: { type: "array", items: { type: "object" } }
        },
        required: ["checks"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "inject",
      description: "Inject a script or style into the page. type=script (content or url) or style (content).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["script", "style"] },
          content: { type: "string" },
          url: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clipboard",
      description: "Read or write the system clipboard. op=read or op=write (text).",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["read", "write"] },
          text: { type: "string" }
        },
        required: ["op"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "storage",
      description: "Read or change page localStorage/sessionStorage. op=get (key optional), set (key,value), remove (key), clear.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["get", "set", "remove", "clear"] },
          area: { type: "string", enum: ["local", "session"] },
          key: { type: "string" },
          value: { type: "string" }
        },
        required: ["op"]
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
