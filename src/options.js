// Options page: persist settings to chrome.storage.local and allow a quick
// connection test against the configured provider.

import { DEFAULT_BASE_URL, DEFAULT_MODEL, chatCompletion } from "./lib/deepseek.js";
import {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  noul,
  systemOne
} from "./lib/typesafe.js";

const DEFAULTS = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  jevApiKey: "",
  jevBaseUrl: DEFAULT_JEV_BASE_URL,
  jevModel: DEFAULT_JEV_MODEL,
  jevConfidence: 0.3,
  temperature: 0.2,
  maxSteps: 40,
  dialogConfirm: "accept",
  dialogPrompt: ""
};

const fields = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("apiKey"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  jevApiKey: document.getElementById("jevApiKey"),
  jevBaseUrl: document.getElementById("jevBaseUrl"),
  jevModel: document.getElementById("jevModel"),
  jevConfidence: document.getElementById("jevConfidence"),
  maxSteps: document.getElementById("maxSteps"),
  temperature: document.getElementById("temperature"),
  dialogConfirm: document.getElementById("dialogConfirm"),
  dialogPrompt: document.getElementById("dialogPrompt")
};
const status = document.getElementById("status");

function setStatus(text, cls = "") {
  status.textContent = text;
  status.className = "status " + cls;
}

function showProviderFields() {
  const jev = fields.provider.value === "jev";
  document.getElementById("deepseekFields").style.display = jev ? "none" : "";
  document.getElementById("jevFields").style.display = jev ? "" : "none";
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  fields.provider.value = s.provider || "deepseek";
  fields.apiKey.value = s.apiKey || "";
  fields.baseUrl.value = s.baseUrl || DEFAULT_BASE_URL;
  fields.model.value = s.model || DEFAULT_MODEL;
  fields.jevApiKey.value = s.jevApiKey || "";
  fields.jevBaseUrl.value = s.jevBaseUrl || DEFAULT_JEV_BASE_URL;
  fields.jevModel.value = s.jevModel || DEFAULT_JEV_MODEL;
  fields.jevConfidence.value = s.jevConfidence ?? 0.3;
  fields.maxSteps.value = s.maxSteps;
  fields.temperature.value = s.temperature;
  fields.dialogConfirm.value = s.dialogConfirm || "accept";
  fields.dialogPrompt.value = s.dialogPrompt || "";
  showProviderFields();
}

function read() {
  return {
    provider: fields.provider.value || "deepseek",
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim() || DEFAULT_BASE_URL,
    model: fields.model.value.trim() || DEFAULT_MODEL,
    jevApiKey: fields.jevApiKey.value.trim(),
    jevBaseUrl: fields.jevBaseUrl.value.trim() || DEFAULT_JEV_BASE_URL,
    jevModel: fields.jevModel.value.trim() || DEFAULT_JEV_MODEL,
    jevConfidence: clamp(Number(fields.jevConfidence.value), 0, 1, 0.3),
    maxSteps: Number(fields.maxSteps.value) || 40,
    temperature: Number(fields.temperature.value),
    dialogConfirm: fields.dialogConfirm.value || "accept",
    dialogPrompt: fields.dialogPrompt.value
  };
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
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
    if (settings.provider === "jev") {
      if (!settings.jevApiKey) throw new Error("Enter a Jev API key first.");
      const res = await systemOne({
        apiKey: settings.jevApiKey,
        baseUrl: settings.jevBaseUrl,
        model: settings.jevModel,
        state: "ping",
        questions: { ok: noul("Is this request a connectivity test?") }
      });
      const answer = res.answers?.ok?.noul;
      setStatus(
        `OK - ${res.model || settings.jevModel} replied (noul=${Number(answer).toFixed(2)})`,
        "ok"
      );
    } else {
      if (!settings.apiKey) throw new Error("Enter an API key first.");
      const res = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with the single word: pong" }]
      });
      setStatus("OK - model replied: " + (res.message.content || "").slice(0, 40), "ok");
    }
  } catch (err) {
    setStatus(err.message || String(err), "err");
  } finally {
    btn.disabled = false;
  }
});

fields.provider.addEventListener("change", showProviderFields);

load();
