# Hawki Link

A Chrome extension that puts an **autonomous web agent** in your browser. Give it
a goal in plain English and it navigates, reads pages, clicks, types, logs in, and
reports back — driven by a DeepSeek chat model, or by **Jev**, TypeSafe's
non-generative System One decision model.

It lives in Chrome's **side panel**, so the chat stays open on the right while
you browse; the UI is minimal and follows your system light/dark theme.

> Examples: *"Find the 3 most cited papers on transformer interpretability on
> Google Scholar and summarize them."* · *"Log into my email and tell me what's
> unread."* · *"Add a large pepperoni pizza to the cart on this site and check out."*

## Features

- **Manifest V3** extension, no build step — load it unpacked.
- **Two engines, one agent**: a chat model with OpenAI-style function calling
  (DeepSeek, default), or a **Jev-only decision agent** that drives every step
  through typed Choice/Score/Noul questions with calibrated confidence.
- **Agent loop** with OpenAI-style function calling against the DeepSeek API.
- **Observe → act → observe**: every state-changing action (click, type, submit,
  navigate) waits for the page to settle — including new tabs and navigation — and
  returns a fresh snapshot so the agent always reasons over the real page.
- **All frames, rich editors**: the page is read and driven across every iframe,
  and text is inserted into contenteditable editors (Etherpad, Docs-like) via real
  input events, so it can write into pads, editors and embedded widgets.
- **Playwright-style actions**: click, dblclick, right-click, hover, type/fill,
  select, check/uncheck, focus, keyboard combos (`Control+A`), drag-and-drop,
  scroll, navigation, element read, `evaluate` (JS), `wait_for`, and dialogs.
- **Loop detection**: if the agent repeats itself it is nudged to re-plan, and it
  stops cleanly rather than spinning forever.
- **Dialog handling**: native `alert` / `confirm` / `prompt` and `window.print()`
  are intercepted in the page's main world so they can't hang the agent, and every
  one is reported as a step.
- **Real browser control** via content scripts: page snapshots, clicks, typing,
  dropdown selection, key presses, scrolling, waits, navigation.
- **Fully autonomous**: no confirmation prompts. You give a goal, it decides and
  runs to completion as directly as it can.
- **Streaming activity log** in the popup so you can watch every step.
- API key stored locally in `chrome.storage.local`; never bundled or committed.

## Install (unpacked)

1. Clone this repo.
2. In Chrome open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. The settings page opens automatically — paste your DeepSeek API key and click
   **Test connection**, then **Save**.

## Download a build

Prebuilt zips are attached to [GitHub Releases](../../releases/latest). To install
a release build:

1. Download `hawki-link-v<version>.zip` from the latest release.
2. Unzip it — you get a `hawki-link/` folder containing `manifest.json`.
3. Open `chrome://extensions`, enable **Developer mode**.
4. Click **Load unpacked** and select the unzipped `hawki-link/` folder.

To build the zip yourself (no dependencies):

```bash
node scripts/package.mjs   # -> dist/hawki-link-v<version>.zip
```

Pushing a tag like `v0.1.1` triggers the
[release workflow](.github/workflows/release.yml), which builds the zip and
attaches it to the GitHub Release automatically.

## Configure

Open the extension's **Settings** (gear icon in the popup):

| Setting | Default | Notes |
| --- | --- | --- |
| Run the agent with | `deepseek` | `deepseek` (chat model + tools) or `jev` (System One decisions) |
| API key | — | From https://platform.deepseek.com |
| Base URL | `https://api.deepseek.com` | Any OpenAI-compatible endpoint |
| Model | `deepseek-flash` | DeepSeek-V4.1-Flash (default) |
| Jev API key | — | For the Jev engine, e.g. an OpenRouter key (`sk-or-v1-…`) |
| Jev base URL | `https://openrouter.ai/api/v1` | Any endpoint that speaks the System One protocol |
| Jev model | `typesafe/jev-1.13` | Jev via OpenRouter's System One route |
| Jev confidence | `0.3` | Below this, the agent re-reads the page instead of acting |
| Max steps | `40` | Hard cap on agent actions per task |
| Temperature | `0.2` | Lower = more deterministic |
| confirm() policy | `accept` | `accept` or `dismiss` when a page asks for confirmation |
| prompt() value | *(site default)* | Value returned to a page's `prompt()` |

### About the model

The default is **DeepSeek-V4.1-Flash**, whose API model id is `deepseek-flash`
(`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are temporarily routed
there for compatibility). See the
[DeepSeek-V4.1-Flash announcement](https://www.deepseek.com/en/news/deepseek-v4-1-flash/).

The model field is free-text, so you can enter any other id your account exposes
(`deepseek-chat`, `deepseek-reasoner`, …) and point the Base URL at the matching
endpoint.

### The Jev (System One) engine

Select **Jev** under *Agent engine* to run the agent entirely on
[Jev](https://docs.typesafe.ai), TypeSafe's System One decision model. Jev does not
generate text and cannot call tools; instead each loop iteration sends the goal
plus the current page as `state` and asks a batch of typed questions in one
request:

- **Choice** — the next action, the target element, a candidate URL, text to
  type, a dropdown value, a scroll direction or a key.
- **Noul** — "is the goal achieved?" and, at the end, "does this excerpt answer
  the goal?" for each paragraph, so the final answer is a verbatim excerpt rather
  than generated prose.

The code composes those answers into browser actions and thresholds them by the
*Minimum decision confidence* setting; below it the agent re-reads the page
instead of acting. Because Jev cannot invent strings, candidate values (targets,
URLs, and text lifted from quoted phrases in your goal, plus short excerpts of
pages already read) are enumerated in code and the model selects among them — so
the agent can carry a value it read on one page into a field on another.

Multi-step goals (", then …") are split into atomic requirements, and completion
is gated on a per-requirement Noul for each: the agent will not declare the goal
finished while any requirement is still unmet.

Jev is reachable through a System One endpoint such as OpenRouter
(`https://openrouter.ai/api/v1/systemone`, model `typesafe/jev-1.13`) or the native
TypeSafe API (`https://api.typesafe.ai/v1/systemone`, model `jev-1.13`). Note that
**Defapi does not expose the System One route** (`/v1/systemone` returns 404), and
OpenRouter only serves Jev on the System One route, not `/chat/completions`.

## Tools

The agent drives the active tab through a Playwright-class tool surface. Actions
take either an element id from the snapshot or a locator (`by`/`value`/`nth`).

| Group | Tools |
| --- | --- |
| Observe | `get_page_state`, `read`, `find` (css/xpath/text/role/label/placeholder/testid/alt/title), `assert` |
| Act | `click`, `dblclick`, `right_click`, `hover`, `type_text`, `select_option` (incl. multi), `check`, `focus`, `drag`, `press_key`, `scroll`, `scroll_into_view`, `upload` |
| Navigate | `navigate` (url/back/forward/reload/new tab), `tabs` (list/new/activate/close) |
| Input | `mouse` (move/down/up/click/wheel), `keyboard` (press/insert) |
| Network | `network` (headers, auth, offline, throttle, block, route/mock, unroute) |
| Environment | `emulate` (viewport, color scheme, reduced motion, geolocation, timezone, locale, UA) |
| Capture | `screenshot`, `pdf`, `download`, `console` |
| Page APIs | `evaluate`, `inject`, `clipboard`, `storage`, `cookies`, `dialog` |

**Trusted input.** With *Trusted input* on (default), the extension attaches
Chrome's debugger (`chrome.debugger`) and sends real mouse/keyboard events via
CDP, enables file uploads, and unlocks `network`/`emulate`/`screenshot`/`pdf`/
`console`. This shows Chrome's "debugging this browser" bar and adds the
`debugger`, `downloads` and `cookies` permissions. Turn it off to stay on
synthetic DOM events (no debugger bar, but no trusted input or CDP tools).

**Actionability & shadow DOM.** Every action waits for its target to be
visible, stable and enabled before acting, and element collection pierces open
shadow roots.

## Usage

1. Open any website in the active tab.
2. Click the Hawki Link icon — the chat opens in the right-hand **side panel**
   and stays there while you browse.
3. Type a goal and press **Run**.
4. Watch the log. The agent runs autonomously and shows every step — reasoning,
   tool calls, and observations — until it prints the final result.
5. Press **Stop** at any time to abort.

## How it works

```
popup.js ──hawki:start──▶ background.js ──┬─▶ Agent    (src/lib/agent.js)      ──▶ chatCompletion (src/lib/deepseek.js)
                               │            └─▶ JevAgent (src/lib/jev-agent.js) ──▶ systemOne     (src/lib/typesafe.js)
                               ▼
                        active tab ◀── content.js (DOM toolbox)
```

- `src/content.js` assigns stable `data-hawki-id`s to interactive elements and
  performs the actual clicks/typing, reporting a snapshot of the page.
- `src/background.js` owns the run loop, tab navigation, and tab lifecycle, and
  picks the engine from settings (`provider`).
- `src/lib/agent.js` is provider/browser agnostic: it feeds tool results back to
  the model until `finish` is called.
- `src/lib/jev-agent.js` drives the same browser tools using only System One
  decisions (see *The Jev (System One) engine* above).

## Security & limitations

- The agent acts **as you** on sites where you are logged in. Only run tasks you
  trust, and prefer a dedicated browser profile if you want isolation.
- Credentials you supply are typed into the page and are **not persisted** by the
  extension. Never paste secrets you don't want an LLM to see in the prompt.
- **JS dialogs & print**: `alert`, `confirm`, `prompt` and `window.print()` are
  overridden in the page (see Settings → *Page dialogs & print*). `confirm` is
  auto-accepted (configurable), `prompt` returns a configured value, `alert` is
  dismissed, and `window.print()` is suppressed. Every interception appears in the
  activity log. Native browser UI — Ctrl+P / the browser print dialog, file
  pickers (`<input type="file">`), permission prompts, and beforeunload prompts —
  cannot be controlled by a content script and still require you.
- It cannot solve CAPTCHAs or bypass bot protection.
- Sandboxed inline frames or frames whose origin it can't access are skipped; the
  rest of the page still works.
- Very large or heavily scripted pages may exceed the snapshot text budget; the
  agent can scroll and re-read.

## Development

No build step. Edit files and click **Reload** on `chrome://extensions`.

```
src/
  background.js        service worker + Chrome wiring
  content.js           DOM toolbox (injected on demand)
  popup.html/css/js    chat + activity log
  options.html/css/js  settings
  lib/
    deepseek.js        DeepSeek (chat) API client
    prompt.js          system prompt + tool schemas
    agent.js           chat-model agent loop
    typesafe.js        System One (Jev) API client
    jev-agent.js       Jev-only decision agent loop
    cdp.js             chrome.debugger bridge (trusted input/network/emulation)
    downloads.js       download capture + save
```
