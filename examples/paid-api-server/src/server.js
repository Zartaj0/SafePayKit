import http from "node:http";
import {
  buildQuote,
  createProviderKeyPair,
  fingerprintQuote,
  parseJsonSafely
} from "../../../packages/policy-schema/src/index.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-idempotency-key,x-safepay-agent,x-safepay-authorization"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return parseJsonSafely(Buffer.concat(chunks).toString("utf8"), {});
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });
  return {
    response,
    data: await response.json()
  };
}

function normalizeLiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 125;
  }
  return Math.max(1, Math.min(25_000, Math.round(amount)));
}

function normalizeLiveText(value, fallback) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 160) : fallback;
}

function resolveScenario(pathname, body = {}) {
  switch (pathname) {
    case "/api/live-research":
      return {
        name: body.timeoutFirst ? "live_timeout_retry" : "live_request",
        amountMinor: normalizeLiveAmount(body.amountMinor),
        recipient: normalizeLiveText(body.recipient, "merchant_demo_main"),
        timeoutFirst: Boolean(body.timeoutFirst),
        resource: normalizeLiveText(body.task, "live agent research request")
      };
    case "/api/research":
      return {
        name: "normal",
        amountMinor: 125,
        recipient: "merchant_demo_main",
        resource: "agent research request"
      };
    case "/api/research-timeout":
      return {
        name: "timeout_retry",
        amountMinor: 140,
        recipient: "merchant_demo_main",
        timeoutFirst: true,
        resource: "agent research request"
      };
    case "/api/research-premium":
      return {
        name: "price_drift",
        amountMinor: 900,
        recipient: "merchant_demo_main",
        resource: "agent research request"
      };
    case "/api/research-recipient-drift":
      return {
        name: "recipient_drift",
        amountMinor: 125,
        recipient: "merchant_rogue_sink",
        resource: "agent research request"
      };
    case "/api/exfiltrate":
      return {
        name: "route_not_allowlisted",
        amountMinor: 75,
        recipient: "merchant_demo_main",
        resource: "agent research request"
      };
    default:
      return null;
  }
}

export function startPaidApiServer({
  port = 4200,
  vaultUrl = "http://127.0.0.1:4100",
  providerToken = null,
  providerId = "provider_demo_api",
  providerKeyPair = createProviderKeyPair(),
  logger = console
} = {}) {
  const cachedResponses = {};
  const timeoutOnce = new Set();

  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "paid-api-server" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/provider-metadata") {
      sendJson(response, 200, {
        ok: true,
        providerId,
        providerPublicKey: providerKeyPair.publicKeyPem,
        quoteSignatureScheme: "ed25519:quote-signature-payload-v0"
      });
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, code: "method_not_allowed" });
      return;
    }

    const body = await readJson(request);
    const scenario = resolveScenario(url.pathname, body);
    if (!scenario) {
      sendJson(response, 404, { ok: false, code: "route_not_found" });
      return;
    }

    const quote = buildQuote({
      domain: request.headers.host ?? `127.0.0.1:${port}`,
      route: url.pathname,
      resource: scenario.resource,
      recipient: scenario.recipient,
      amountMinor: scenario.amountMinor,
      providerId,
      providerPrivateKeyPem: providerKeyPair.privateKeyPem,
      providerPublicKeyPem: providerKeyPair.publicKeyPem,
      metadata: {
        scenario: scenario.name
      }
    });

    const tokenId = request.headers["x-safepay-authorization"];
    if (!tokenId) {
      sendJson(response, 402, {
        ok: false,
        code: "payment_required",
        quote
      });
      return;
    }

    const verification = await postJson(`${vaultUrl}/verify-authorization`, {
      tokenId,
      expectedQuoteFingerprint: fingerprintQuote(quote)
    }, providerToken ? { "x-safepay-provider-token": providerToken } : {});

    if (!verification.response.ok) {
      sendJson(response, 403, {
        ok: false,
        code: verification.data.code ?? "authorization_invalid"
      });
      return;
    }

    const { reservation } = verification.data;
    if (cachedResponses[reservation.reservationId]) {
      sendJson(response, 200, cachedResponses[reservation.reservationId]);
      return;
    }

    const settlement = await postJson(`${vaultUrl}/settle`, {
      tokenId,
      actualAmountMinor: scenario.amountMinor,
      providerReceiptId: `provider_${reservation.reservationId}`
    }, providerToken ? { "x-safepay-provider-token": providerToken } : {});

    if (!settlement.response.ok) {
      sendJson(response, 409, {
        ok: false,
        code: settlement.data.code ?? "settlement_failed"
      });
      return;
    }

    const payload = {
      ok: true,
      scenario: scenario.name,
      reservationId: reservation.reservationId,
      receipt: settlement.data.receipt,
      result: {
        summary: `Paid API call completed for ${body.task ?? "research task"}`,
        citationCount: 3,
        confidence: "high",
        answerPreview: "SafePayKit reserved budget, settled once, and kept the retry idempotent."
      }
    };

    cachedResponses[reservation.reservationId] = payload;

    if (scenario.timeoutFirst && !timeoutOnce.has(reservation.reservationId)) {
      timeoutOnce.add(reservation.reservationId);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      if (response.destroyed || response.writableEnded) {
        return;
      }
    }

    sendJson(response, 200, payload);
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      logger.log(
        `[paid-api-server] listening on http://127.0.0.1:${address.port}`
      );
      resolve({
        server,
        port: address.port,
        providerId,
        providerPublicKey: providerKeyPair.publicKeyPem
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPaidApiServer({
    port: Number(process.env.SAFEPAY_API_PORT ?? 4200),
    vaultUrl: process.env.SAFEPAY_VAULT_URL ?? "http://127.0.0.1:4100",
    providerToken: process.env.SAFEPAY_PROVIDER_TOKEN ?? null
  });
}
