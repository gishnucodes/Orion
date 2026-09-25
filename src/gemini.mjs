/**
 * Gemini over the Generative Language REST API, shared by extract (job facts)
 * and apply (form answers, memory merges, Computer Use). No SDK: one fetch with
 * retry is all either caller needs.
 *
 * The API key is read from options.apiKey, then GEMINI_API_KEY (GOOGLE_API_KEY
 * is accepted as a fallback). The applier passes GEMINI_APPLY_API_KEY so it
 * draws on its own free-tier quota rather than the nightly extraction's.
 */
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function resolveKey(options) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set (required for model.runner: gemini)');
  }
  return apiKey;
}

/**
 * POST a JSON body to a Gemini endpoint and return the parsed response.
 *
 * Retries on rate-limit / transient errors with exponential backoff. The
 * free-tier Gemini quota is per-minute, and at concurrency > 1 a burst will
 * draw 429s; without backoff those calls would simply fail. 429 and 503 are
 * retried; other statuses fail fast.
 */
export async function geminiPost(url, body, options = {}) {
  const apiKey = resolveKey(options);
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffMs = options.backoffMs ?? 1000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      lastErr = new Error(`gemini error ${res.status}: ${text.slice(0, 300)}`);
      lastErr.status = res.status;
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Single-prompt generateContent call; returns the concatenated text parts.
 *
 * responseMimeType: 'application/json' (the default, `json: false` to disable)
 * makes the model return a bare JSON object with no markdown fence, so
 * extractJsonBlock downstream is a no-op but kept for safety.
 */
export async function runGemini(modelName, params, prompt, options = {}) {
  const base = (options.url || DEFAULT_BASE).replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(modelName)}:generateContent`;
  const generationConfig = {
    temperature: params.temp ?? 0,
    topP: params.top_p ?? 1,
    topK: params.top_k ?? 1,
    maxOutputTokens: params.num_predict ?? 300
  };
  if (options.json !== false) generationConfig.responseMimeType = 'application/json';
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig };
  if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };

  const data = await geminiPost(url, body, options);
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

/** Base URL for endpoints outside models/* (e.g. the Interactions API). */
export function geminiBase(options = {}) {
  return (options.url || DEFAULT_BASE).replace(/\/$/, '');
}
