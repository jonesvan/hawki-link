// Options page: persist settings to chrome.storage.local and allow a quick
// connection test against the configured endpoint.

import { DEFAULT_BASE_URL, DEFAULT_MODEL, chatCompletion } from "./lib/deepseek.js";

const DEFAULTS = {
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  temperature: 0.2,
  maxSteps: 25
};

const fields = {
  apiKey: document.getElementById("apiKey"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  maxSteps: document.getElementById("maxSteps"),
  temperature: document.getElementById("temperature")
};
const status = document.getElementById("status");

function setStatus(text, cls = "") {
  status.textContent = text;
  status.className = "status " + cls;
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  fields.apiKey.value = s.apiKey || "";
  fields.baseUrl.value = s.baseUrl || DEFAULT_BASE_URL;
  fields.model.value = s.model || DEFAULT_MODEL;
  fields.maxSteps.value = s.maxSteps;
  fields.temperature.value = s.temperature;
}

function read() {
  return {
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim() || DEFAULT_BASE_URL,
    model: fields.model.value.trim() || DEFAULT_MODEL,
    maxSteps: Number(fields.maxSteps.value) || 25,
    temperature: Number(fields.temperature.value)
  };
}

document.getElementById("save").addEventListener("click", async () => {
  const settings = read();
  await chrome.storage.local.set({ settings });
  setStatus("Saved.", "ok");
  setTimeout(() => setStatus(""), 2000);
});

document.getElementById("test").addEventListener("click", async () => {
  const btn = document.getElementById("test");
  btn.disabled = true;
  setStatus("Testing...");
  try {
    const settings = read();
    if (!settings.apiKey) throw new Error("Enter an API key first.");
    const res = await chatCompletion({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with the single word: pong" }]
    });
    setStatus("OK - model replied: " + (res.message.content || "").slice(0, 40), "ok");
  } catch (err) {
    setStatus(err.message || String(err), "err");
  } finally {
    btn.disabled = false;
  }
});

load();
