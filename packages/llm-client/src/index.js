const TIMEOUT_MS = 7000;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function resolveLlmConfig(env = process.env) {
  return {
    geminiApiKey: env.GEMINI_API_KEY ?? null,
    geminiModel: env.GEMINI_MODEL ?? "gemini-2.0-flash",

    zeroGApiKey: env.ZERO_G_PRIVATE_KEY ?? null,
    zeroGUrl: env.ZERO_G_URL ?? "https://api.0g.ai/v1/chat/completions",
    zeroGModel: env.ZERO_G_MODEL ?? "llama-3.3-70b-instruct",

    openrouterApiKey: env.OPENROUTER ?? null,
    openrouterModel: env.OPENROUTER_MODEL ?? "google/gemma-3-27b-it:free",

    nvidiaApiKey: env.NVIDIA ?? null,
    nvidiaModel: env.NVIDIA_MODEL ?? "meta/llama-3.1-8b-instruct",

    mistralApiKey: env.MISTRAL ?? null,
    mistralModel: env.MISTRAL_MODEL ?? "mistral-small-latest",

    opencodeApiKey: env.OPENCODE ?? null,
    opencodeUrl: env.OPENCODE_URL ?? "https://api.opencode.ai/v1/chat/completions",
    opencodeModel: env.OPENCODE_MODEL ?? "gpt-4o-mini"
  };
}

export function hasLlmProvider(config = {}) {
  return Boolean(
    config.geminiApiKey ||
    config.zeroGApiKey ||
    config.openrouterApiKey ||
    config.nvidiaApiKey ||
    config.mistralApiKey ||
    config.opencodeApiKey
  );
}

function openAiBody(model, prompt, maxTokens = 256) {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }]
  });
}

function openAiText(data) {
  return (data?.choices ?? []).map((c) => c.message?.content ?? "").join("").trim() || null;
}

export async function callLlm(prompt, config, { maxTokens = 256 } = {}) {
  const providers = [];

  if (config.geminiApiKey) {
    providers.push(async () => {
      const model = config.geminiModel ?? "gemini-2.0-flash";
      const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.geminiApiKey
        },
        body: JSON.stringify({
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const d = await res.json();
      const text = (d?.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => p.text)
        .map((p) => p.text)
        .join("")
        .trim();
      return { provider: "gemini", model, text: text || null };
    });
  }

  if (config.zeroGApiKey) {
    providers.push(async () => {
      const model = config.zeroGModel ?? "llama-3.3-70b-instruct";
      const res = await fetch(config.zeroGUrl ?? "https://api.0g.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.zeroGApiKey}`
        },
        body: openAiBody(model, prompt, maxTokens),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`0G ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.message ?? "0G error");
      return { provider: "0g", model, text: openAiText(d) };
    });
  }

  if (config.openrouterApiKey) {
    const model = config.openrouterModel ?? "google/gemma-3-27b-it:free";
    providers.push(async () => {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.openrouterApiKey}`,
          "http-referer": "https://safepaykit.xyz"
        },
        body: openAiBody(model, prompt, maxTokens),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.message ?? "OpenRouter error");
      return { provider: "openrouter", model, text: openAiText(d) };
    });
  }

  if (config.nvidiaApiKey) {
    providers.push(async () => {
      const model = config.nvidiaModel ?? "meta/llama-3.1-8b-instruct";
      const res = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.nvidiaApiKey}`
        },
        body: openAiBody(model, prompt, maxTokens),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
      const d = await res.json();
      return { provider: "nvidia", model, text: openAiText(d) };
    });
  }

  if (config.mistralApiKey) {
    providers.push(async () => {
      const model = config.mistralModel ?? "mistral-small-latest";
      const res = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.mistralApiKey}`
        },
        body: openAiBody(model, prompt, maxTokens),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`Mistral ${res.status}`);
      const d = await res.json();
      return { provider: "mistral", model, text: openAiText(d) };
    });
  }

  if (config.opencodeApiKey) {
    providers.push(async () => {
      const model = config.opencodeModel ?? "gpt-4o-mini";
      const res = await fetch(config.opencodeUrl ?? "https://api.opencode.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.opencodeApiKey}`
        },
        body: openAiBody(model, prompt, maxTokens),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`OpenCode ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.message ?? "OpenCode error");
      return { provider: "opencode", model, text: openAiText(d) };
    });
  }

  for (const fn of providers) {
    try {
      const result = await fn();
      if (result?.text) return result;
    } catch {
      // rate-limited or unavailable — try next
    }
  }

  return null;
}
