import crypto from "node:crypto";
import http from "node:http";
import {
  createDemoPolicy,
  createDemoRun,
  hashValue,
  isoTime,
  makeId,
  normalizePolicy,
  parseJsonSafely,
  receiptSignaturePayload,
  validatePolicy
} from "../../policy-schema/src/index.js";
import {
  authorizePayment,
  createEmptyState,
  expireOpenReservations,
  refundReservation,
  resetBreaker,
  settleReservation,
  snapshotState,
  tripBreaker
} from "../../core/src/index.js";
import { createFilePersistence } from "./persistence.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type,x-idempotency-key,x-safepay-agent,x-safepay-authorization,x-safepay-admin-token,x-safepay-agent-token,x-safepay-provider-token"
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

function signReceipt(privateKey, receipt) {
  const payloadHash = hashValue(receiptSignaturePayload(receipt));

  return crypto.sign(null, Buffer.from(payloadHash), privateKey).toString("base64url");
}

function headerValue(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(expected, actual) {
  if (!expected) {
    return true;
  }

  if (typeof actual !== "string") {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function requireToken(request, response, expectedToken, headerName, code) {
  if (tokenMatches(expectedToken, headerValue(request, headerName))) {
    return true;
  }

  sendJson(response, 401, { ok: false, code });
  return false;
}

function createSignerBundle(keys = null) {
  if (keys?.privateKeyPem && keys?.publicKeyPem) {
    return {
      privateKey: crypto.createPrivateKey(keys.privateKeyPem),
      publicKey: crypto.createPublicKey(keys.publicKeyPem),
      exported: {
        privateKeyPem: keys.privateKeyPem,
        publicKeyPem: keys.publicKeyPem
      }
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    exported: {
      privateKeyPem: privateKey.export({
        type: "pkcs8",
        format: "pem"
      }),
      publicKeyPem: publicKey.export({
        type: "spki",
        format: "pem"
      })
    }
  };
}

export function createVaultRuntime({
  policy = null,
  runs = {},
  state = createEmptyState(),
  authTokens = {},
  persistedKeys = null,
  persistence = null
} = {}) {
  const signer = createSignerBundle(persistedKeys);

  function currentSnapshot() {
    return {
      ...snapshotState({
        policy,
        state,
        runs,
        publicKey: signer.exported.publicKeyPem
      }),
      storage: persistence?.getMeta() ?? {
        mode: "memory",
        filePath: null,
        lastSavedAt: null
      }
    };
  }

  async function persist() {
    if (!persistence) {
      return;
    }

    await persistence.save({
      policy,
      state,
      runs,
      authTokens,
      keys: signer.exported,
      savedAt: isoTime()
    });
  }

  function bootstrapDemo(overrides = {}) {
    policy = createDemoPolicy(overrides.policy ?? {});
    state = createEmptyState();
    for (const key of Object.keys(runs)) {
      delete runs[key];
    }
    for (const key of Object.keys(authTokens)) {
      delete authTokens[key];
    }
    const run = createDemoRun(overrides.run ?? {});
    runs[run.runId] = run;
    return { policy, run };
  }

  return {
    get policy() {
      return policy;
    },
    get runs() {
      return runs;
    },
    get state() {
      return state;
    },
    currentSnapshot,
    persist,
    bootstrapDemo,
    updatePolicy(nextPolicy) {
      policy = nextPolicy;
    },
    replaceState(nextState) {
      state = nextState;
    },
    issueToken(reservation) {
      const tokenId = makeId("auth");
      authTokens[tokenId] = {
        tokenId,
        reservationId: reservation.reservationId,
        runId: reservation.runId,
        quoteFingerprint: reservation.quoteFingerprint,
        expiresAt: reservation.expiresAt,
        createdAt: isoTime()
      };
      return authTokens[tokenId];
    },
    verifyToken(tokenId) {
      return authTokens[tokenId] ?? null;
    },
    signReceipt(receipt) {
      return {
        ...receipt,
        vaultSignature: signReceipt(signer.privateKey, receipt),
        vaultPublicKey: signer.exported.publicKeyPem
      };
    }
  };
}

export async function startVaultServer({
  port = 4100,
  runtime = null,
  storeFile = null,
  adminToken = null,
  agentToken = null,
  providerToken = null,
  logger = console
} = {}) {
  let resolvedRuntime = runtime;

  if (!resolvedRuntime) {
    const persistence = storeFile ? createFilePersistence(storeFile) : null;
    const persisted = await persistence?.load();

    resolvedRuntime = createVaultRuntime({
      policy: persisted?.policy ?? null,
      runs: persisted?.runs ?? {},
      state: persisted?.state ?? createEmptyState(),
      authTokens: persisted?.authTokens ?? {},
      persistedKeys: persisted?.keys ?? null,
      persistence
    });

    if (persistence) {
      if (persisted) {
        logger.log(`[vault-service] loaded persisted state from ${persistence.filePath}`);
      } else {
        await resolvedRuntime.persist();
        logger.log(`[vault-service] persistence enabled at ${persistence.filePath}`);
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "vault-service" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/state") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const expiredCount = expireOpenReservations(resolvedRuntime.state);
      if (expiredCount > 0) {
        await resolvedRuntime.persist();
      }
      sendJson(response, 200, resolvedRuntime.currentSnapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/demo/bootstrap") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const demo = resolvedRuntime.bootstrapDemo(body);
      await resolvedRuntime.persist();
      sendJson(response, 200, {
        ok: true,
        ...demo,
        snapshot: resolvedRuntime.currentSnapshot()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/policy") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const nextPolicy = normalizePolicy(body);
      const errors = validatePolicy(nextPolicy);

      if (errors.length > 0) {
        sendJson(response, 400, { ok: false, code: "invalid_policy", errors });
        return;
      }

      resolvedRuntime.updatePolicy(nextPolicy);
      await resolvedRuntime.persist();
      sendJson(response, 200, { ok: true, policy: nextPolicy });
      return;
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const run = createDemoRun(body);
      resolvedRuntime.runs[run.runId] = run;
      await resolvedRuntime.persist();
      sendJson(response, 200, { ok: true, run });
      return;
    }

    if (request.method === "POST" && url.pathname === "/authorize") {
      if (
        !requireToken(
          request,
          response,
          agentToken,
          "x-safepay-agent-token",
          "agent_auth_required"
        )
      ) {
        return;
      }

      if (!resolvedRuntime.policy) {
        sendJson(response, 409, { ok: false, code: "policy_not_set" });
        return;
      }

      const body = await readJson(request);
      const { quote, runId, agentId, idempotencyKey } = body;
      if (resolvedRuntime.runs[runId] && resolvedRuntime.runs[runId].agentId !== agentId) {
        sendJson(response, 403, { ok: false, code: "run_agent_mismatch" });
        return;
      }

      if (!resolvedRuntime.runs[runId]) {
        resolvedRuntime.runs[runId] = createDemoRun({ runId, agentId });
      }

      const result = authorizePayment({
        policy: resolvedRuntime.policy,
        state: resolvedRuntime.state,
        quote,
        runId,
        agentId,
        idempotencyKey
      });
      resolvedRuntime.replaceState(result.state);

      if (!result.ok) {
        await resolvedRuntime.persist();
        sendJson(response, 403, {
          ok: false,
          code: result.code,
          reason: result.code,
          snapshot: resolvedRuntime.currentSnapshot()
        });
        return;
      }

      const authorization = resolvedRuntime.issueToken(result.reservation);
      await resolvedRuntime.persist();
      sendJson(response, 200, {
        ok: true,
        decision: result.reused ? "reused" : "authorized",
        reservation: result.reservation,
        authorization
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/verify-authorization") {
      if (
        !requireToken(
          request,
          response,
          providerToken,
          "x-safepay-provider-token",
          "provider_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const token = resolvedRuntime.verifyToken(body.tokenId);
      if (!token) {
        sendJson(response, 404, { ok: false, code: "authorization_not_found" });
        return;
      }

      if (new Date(token.expiresAt).getTime() < Date.now()) {
        sendJson(response, 410, { ok: false, code: "authorization_expired" });
        return;
      }

      const reservation = resolvedRuntime.state.reservations[token.reservationId];
      if (!reservation) {
        sendJson(response, 404, { ok: false, code: "reservation_not_found" });
        return;
      }

      if (body.expectedQuoteFingerprint && body.expectedQuoteFingerprint !== reservation.quoteFingerprint) {
        sendJson(response, 403, { ok: false, code: "quote_fingerprint_mismatch" });
        return;
      }

      sendJson(response, 200, { ok: true, token, reservation });
      return;
    }

    if (request.method === "POST" && url.pathname === "/settle") {
      if (
        !requireToken(
          request,
          response,
          providerToken,
          "x-safepay-provider-token",
          "provider_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const token = resolvedRuntime.verifyToken(body.tokenId);
      if (!token) {
        sendJson(response, 404, { ok: false, code: "authorization_not_found" });
        return;
      }

      const result = settleReservation({
        state: resolvedRuntime.state,
        reservationId: token.reservationId,
        providerReceiptId: body.providerReceiptId ?? makeId("provider"),
        actualAmountMinor: Number(body.actualAmountMinor)
      });

      resolvedRuntime.replaceState(result.state);

      if (!result.ok) {
        await resolvedRuntime.persist();
        sendJson(response, 409, { ok: false, code: result.code });
        return;
      }

      const signedReceipt = resolvedRuntime.signReceipt(result.receipt);
      resolvedRuntime.state.receipts[signedReceipt.receiptId] = signedReceipt;
      await resolvedRuntime.persist();
      sendJson(response, 200, {
        ok: true,
        reused: result.reused,
        receipt: signedReceipt
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/refund") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      const result = refundReservation({
        state: resolvedRuntime.state,
        reservationId: body.reservationId,
        amountMinor: Number(body.amountMinor),
        reason: body.reason
      });

      resolvedRuntime.replaceState(result.state);

      if (!result.ok) {
        await resolvedRuntime.persist();
        sendJson(response, 409, { ok: false, code: result.code });
        return;
      }

      await resolvedRuntime.persist();
      sendJson(response, 200, { ok: true, refund: result.refund });
      return;
    }

    if (request.method === "POST" && url.pathname === "/breaker/trip") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      const body = await readJson(request);
      resolvedRuntime.replaceState(
        tripBreaker(resolvedRuntime.state, body.reason ?? "manual_trip")
      );
      await resolvedRuntime.persist();
      sendJson(response, 200, { ok: true, breaker: resolvedRuntime.state.breaker });
      return;
    }

    if (request.method === "POST" && url.pathname === "/breaker/reset") {
      if (
        !requireToken(
          request,
          response,
          adminToken,
          "x-safepay-admin-token",
          "admin_auth_required"
        )
      ) {
        return;
      }

      resolvedRuntime.replaceState(resetBreaker(resolvedRuntime.state));
      await resolvedRuntime.persist();
      sendJson(response, 200, { ok: true, breaker: resolvedRuntime.state.breaker });
      return;
    }

    sendJson(response, 404, { ok: false, code: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      logger.log(
        `[vault-service] listening on http://127.0.0.1:${address.port}`
      );
      resolve({
        server,
        port: address.port,
        runtime: resolvedRuntime
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startVaultServer({
    port: Number(process.env.SAFEPAY_VAULT_PORT ?? 4100),
    storeFile:
      process.env.SAFEPAY_STORE_FILE ??
      new URL("../../../tmp/safepaykit-demo.json", import.meta.url).pathname,
    adminToken: process.env.SAFEPAY_ADMIN_TOKEN ?? "demo-admin-token",
    agentToken: process.env.SAFEPAY_AGENT_TOKEN ?? "demo-agent-token",
    providerToken: process.env.SAFEPAY_PROVIDER_TOKEN ?? "demo-provider-token"
  });
}
