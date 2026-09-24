// Minimal client for the TypeSafe AI System One API ("Jev"), a non-generative
// decision model. Instead of chat completions it takes a `state` plus typed
// `questions` (Choice, Score, Noul) and returns typed `answers` with
// probabilities and confidence.
//
// Docs: https://docs.typesafe.ai
// Default provider: OpenRouter, which proxies Jev on POST /v1/systemone.

export const DEFAULT_JEV_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

export class TypeSafeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
  }
}

/**
 * Ask one or more typed questions about a state.
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseUrl]
 * @param {string} [params.model]
 * @param {string|object|Array} params.state   Material to judge.
 * @param {object} params.questions            Map of question id -> question.
 * @param {AbortSignal} [params.signal]
 */
export async function systemOne({
  apiKey,
  baseUrl = DEFAULT_JEV_BASE_URL,
  model = DEFAULT_JEV_MODEL,
  state,
  questions,
  signal
}) {
  if (!apiKey) {
    throw new TypeSafeError(
      "No Jev API key configured. Open Hawki Link settings and add your System One API key."
    );
  }

  const url = systemOneUrl(baseUrl);
  const body = { model, state, questions };

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
    throw new TypeSafeError("Network error contacting the System One API: " + err.message);
  }

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }

  if (!res.ok) {
    const detail =
      json?.error?.message ||
      json?.message ||
      json?.detail?.message ||
      (json ? JSON.stringify(json) : "");
    throw new TypeSafeError(
      `System One API error ${res.status}: ${detail}`.trim(),
      res.status
    );
  }

  if (!json || !json.answers) {
    throw new TypeSafeError("System One returned no answers: " + JSON.stringify(json));
  }

  return {
    model: json.model,
    answers: json.answers,
    usage: json.usage,
    provider: json.provider,
    id: json.id
  };
}

// Accept a base URL of the form https://host, https://host/api, https://host/api/v1,
// or a full .../systemone endpoint, and produce the System One endpoint URL.
export function systemOneUrl(baseUrl) {
  const root = String(baseUrl || DEFAULT_JEV_BASE_URL).replace(/\/+$/, "");
  if (/\/systemone$/.test(root)) return root;
  if (/\/v1$/.test(root)) return root + "/systemone";
  return root + "/v1/systemone";
}

// Question constructors.

export function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

export function score(instructions, criteria) {
  return { type: "score", instructions, criteria };
}

export function noul(instructions, criteria) {
  return criteria == null
    ? { type: "noul", instructions }
    : { type: "noul", instructions, criteria };
}
