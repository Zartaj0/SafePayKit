import {
  fingerprintQuote,
  makeId,
  parseJsonSafely
} from "../../policy-schema/src/index.js";

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
  maxNetworkRetries = 1,
  onEvent = null
}) {
  function emit(type, details = {}) {
    if (typeof onEvent === "function") {
      onEvent({
        type,
        at: new Date().toISOString(),
        ...details
      });
    }
  }

  async function authorize(quote, idempotencyKey) {
    emit("vault.authorize.request", {
      runId,
      agentId,
      idempotencyKey,
      quoteFingerprint: fingerprintQuote(quote)
    });

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
      emit("vault.authorize.blocked", {
        status: response.status,
        code: data.reason ?? data.code ?? "authorization_blocked",
        snapshot: data.snapshot ?? null
      });
      throw new SafePayBlockedError(
        `Authorization blocked: ${data.reason ?? data.code ?? response.status}`,
        data
      );
    }

    emit("vault.authorize.approved", {
      decision: data.decision,
      reservationId: data.reservation?.reservationId,
      reservedAmountMinor: data.reservation?.reservedAmountMinor,
      tokenId: data.authorization?.tokenId
    });
    return data;
  }

  async function safeFetch(url, init = {}, options = {}) {
    const headers = new Headers(init.headers ?? {});
    const idempotencyKey = headers.get("x-idempotency-key") ?? makeId("idem");
    headers.set("x-idempotency-key", idempotencyKey);
    headers.set("x-safepay-agent", agentId);

    emit("agent.request", {
      url,
      method: init.method ?? "GET",
      runId,
      agentId,
      idempotencyKey
    });

    const firstResponse = await fetchImpl(url, {
      ...init,
      headers
    });

    if (firstResponse.status !== 402) {
      emit("provider.free_response", {
        status: firstResponse.status
      });
      return firstResponse;
    }

    const quotePayload = await firstResponse.json();
    emit("provider.quote", {
      status: firstResponse.status,
      quoteId: quotePayload.quote?.quoteId,
      route: quotePayload.quote?.route,
      recipient: quotePayload.quote?.recipient,
      amountMinor: quotePayload.quote?.amountMinor,
      tokenMint: quotePayload.quote?.tokenMint,
      quoteFingerprint: quotePayload.quote ? fingerprintQuote(quotePayload.quote) : null,
      signedByProvider: Boolean(quotePayload.quote?.providerSignature)
    });

    let authorization = await authorize(quotePayload.quote, idempotencyKey);
    let attempts = 0;

    while (attempts <= maxNetworkRetries) {
      attempts += 1;
      const retryHeaders = new Headers(init.headers ?? {});
      retryHeaders.set("x-idempotency-key", idempotencyKey);
      retryHeaders.set("x-safepay-agent", agentId);
      retryHeaders.set("x-safepay-authorization", authorization.authorization.tokenId);

      try {
        emit("agent.retry_with_authorization", {
          attempt: attempts,
          tokenId: authorization.authorization.tokenId,
          reservationId: authorization.reservation?.reservationId
        });

        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            ...init,
            headers: retryHeaders
          },
          options.requestTimeoutMs ?? requestTimeoutMs
        );
        emit("provider.response", {
          attempt: attempts,
          status: response.status,
          reservationId: authorization.reservation?.reservationId
        });
        return response;
      } catch (error) {
        emit("network.timeout", {
          attempt: attempts,
          reservationId: authorization.reservation?.reservationId,
          message: error.message
        });
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
