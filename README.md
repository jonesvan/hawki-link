# Hawki Link

A Chrome extension that puts an **autonomous web agent** in your browser. Give it
a goal in plain English and it navigates, reads pages, clicks, types, logs in, and
reports back — driven by a DeepSeek chat model.

> Examples: *"Find the 3 most cited papers on transformer interpretability on
> Google Scholar and summarize them."* · *"Log into my email and tell me what's
> unread."* · *"Add a large pepperoni pizza to the cart on this site — do not
> check out without asking me."*

## Features

- **Manifest V3** extension, no build step — load it unpacked.
- **Agent loop** with OpenAI-style function calling against the DeepSeek API.
- **Real browser control** via content scripts: page snapshots, clicks, typing,
  dropdown selection, key presses, scrolling, waits, navigation.
- **Human in the loop**: the agent pauses with `ask_user` for credentials, and is
  instructed to request approval before spending money, sending messages, or
  deleting anything.
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
| API key | — | From https://platform.deepseek.com |
| Base URL | `https://api.deepseek.com` | Any OpenAI-compatible endpoint |
| Model | `deepseek-chat` | See note below |
| Max steps | `25` | Hard cap on agent actions per task |
| Temperature | `0.2` | Lower = more deterministic |

### About the model

The public DeepSeek API exposes `deepseek-chat` and `deepseek-reasoner`. There is
currently **no `deepseek-v4.1-flash` model ID** at `api.deepseek.com`, so the
extension defaults to `deepseek-chat`. The model field is free-text (with a
datalist of suggestions) — if you have access to a specific model such as a
`deepseek-v4.1-flash` deployment, type its exact ID and point the Base URL at the
matching endpoint.

## Usage

1. Open any website in the active tab.
2. Click the Hawki Link icon.
3. Type a goal and press **Run**.
4. Watch the log. When the agent asks a question (e.g. for a password or approval)
   the input box turns into a reply field — answer it and press **Reply**.
5. Press **Stop** at any time to abort.

## How it works

```
popup.js ──hawki:start──▶ background.js ──▶ Agent (src/lib/agent.js)
                               │                    │
                               │              chatCompletion (src/lib/deepseek.js)
                               │                    │
                               ▼                    ▼
                        active tab ◀── content.js (DOM toolbox)
```

- `src/content.js` assigns stable `data-hawki-id`s to interactive elements and
  performs the actual clicks/typing, reporting a snapshot of the page.
- `src/background.js` owns the run loop, tab navigation, and tab lifecycle.
- `src/lib/agent.js` is provider/browser agnostic: it feeds tool results back to
  the model until `finish` is called.

## Security & limitations

- The agent acts **as you** on sites where you are logged in. Only run tasks you
  trust, and prefer a dedicated browser profile if you want isolation.
- Credentials you supply are typed into the page and are **not persisted** by the
  extension. Never paste secrets you don't want an LLM to see in the prompt.
- It cannot yet solve CAPTCHAs or bypass bot protection.
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
    deepseek.js        API client
    prompt.js          system prompt + tool schemas
    agent.js           agent loop
```
