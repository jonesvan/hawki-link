// Minimal OpenAI-compatible client for the DeepSeek chat completions API.
// Docs: https://api.deepseek.com

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-flash";

export class DeepSeekError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
  }
}

/**
 * Send a chat completion request.
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseUrl]
 * @param {string} [params.model]
 * @param {Array}  params.messages
 * @param {Array}  [params.tools]
 * @param {number} [params.temperature]
 * @param {AbortSignal} [params.signal]
 */
export async function chatCompletion({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  messages,
  tools,
  temperature = 0.2,
  signal
}) {
  if (!apiKey) {
    throw new DeepSeekError(
      "No API key configured. Open Hawki Link settings and add your DeepSeek API key."
    );
  }

  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model,
    messages,
    temperature,
    stream: false
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new DeepSeekError("Network error contacting DeepSeek: " + err.message);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const json = await res.json();
      detail = json?.error?.message || JSON.stringify(json);
    } catch (_) {
      detail = await res.text().catch(() => "");
    }
    throw new DeepSeekError(
      `DeepSeek API error ${res.status}: ${detail}`.trim(),
      res.status
    );
  }

  const json = await res.json();
  const choice = json?.choices?.[0];
  if (!choice) {
    throw new DeepSeekError("DeepSeek returned no choices: " + JSON.stringify(json));
  }
  return {
    message: choice.message,
    usage: json.usage,
    finishReason: choice.finish_reason
  };
}
