import { makeId, parseJsonSafely } from "../../policy-schema/src/index.js";

export class SafePayBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SafePayBlockedError";
    this.details = details;
  }
}

async function fetchJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  const data = parseJsonSafely(text, text);
  return { response, data };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  if (!timeoutMs) {
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createSafePayClient({
  vaultUrl,
  runId,
  agentId,
  agentToken = null,
  fetchImpl = fetch,
  requestTimeoutMs = 900,
  maxNetworkRetries = 1
}) {
  async function authorize(quote, idempotencyKey) {
    const { response, data } = await fetchJson(fetchImpl, `${vaultUrl}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agentToken ? { "x-safepay-agent-token": agentToken } : {})
      },
      body: JSON.stringify({
        quote,
        runId,
        agentId,
        idempotencyKey
      })
    });

    if (!response.ok) {
      throw new SafePayBlockedError(
        `Authorization blocked: ${data.reason ?? data.code ?? response.status}`,
        data
      );
    }

    return data;
  }

  async function safeFetch(url, init = {}, options = {}) {
    const headers = new Headers(init.headers ?? {});
    const idempotencyKey = headers.get("x-idempotency-key") ?? makeId("idem");
    headers.set("x-idempotency-key", idempotencyKey);
    headers.set("x-safepay-agent", agentId);

    const firstResponse = await fetchImpl(url, {
      ...init,
      headers
    });

    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    const quotePayload = await firstResponse.json();
    let authorization = await authorize(quotePayload.quote, idempotencyKey);
    let attempts = 0;

    while (attempts <= maxNetworkRetries) {
      attempts += 1;
      const retryHeaders = new Headers(init.headers ?? {});
      retryHeaders.set("x-idempotency-key", idempotencyKey);
      retryHeaders.set("x-safepay-agent", agentId);
      retryHeaders.set("x-safepay-authorization", authorization.authorization.tokenId);

      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            ...init,
            headers: retryHeaders
          },
          options.requestTimeoutMs ?? requestTimeoutMs
        );
        return response;
      } catch (error) {
        if (attempts > maxNetworkRetries) {
          throw error;
        }
        authorization = await authorize(quotePayload.quote, idempotencyKey);
      }
    }

    throw new Error("unreachable");
  }

  return {
    fetch: safeFetch
  };
}
