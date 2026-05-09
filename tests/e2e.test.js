import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

test("end-to-end flow settles once, reuses on retry, and blocks bad quotes", async () => {
  const adminToken = "test-admin-token";
  const agentToken = "test-agent-token";
  const providerToken = "test-provider-token";
  const silentLogger = {
    log() {}
  };

  const vault = await startVaultServer({
    port: 0,
    adminToken,
    agentToken,
    providerToken,
    logger: silentLogger
  });
  const api = await startPaidApiServer({
    port: 0,
    vaultUrl: `http://127.0.0.1:${vault.port}`,
    providerToken,
    logger: silentLogger
  });

  const vaultUrl = `http://127.0.0.1:${vault.port}`;
  const apiUrl = `http://127.0.0.1:${api.port}`;

  try {
    await fetch(`${vaultUrl}/demo/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-safepay-admin-token": adminToken
      },
      body: JSON.stringify({
        policy: {
          allowedDomains: [new URL(apiUrl).host],
          allowedProviderKeys: [api.providerPublicKey]
        }
      })
    });

    const normal = await runScenario({
      scenario: "normal",
      vaultUrl,
      apiUrl,
      agentToken,
      adminToken
    });
    assert.equal(normal.ok, true);

    const timeout = await runScenario({
      scenario: "timeout",
      vaultUrl,
      apiUrl,
      agentToken,
      adminToken
    });
    assert.equal(timeout.ok, true);

    let blocked = null;
    try {
      await runScenario({
        scenario: "price",
        vaultUrl,
        apiUrl,
        agentToken,
        adminToken
      });
    } catch (error) {
      blocked = error.payload ?? { code: error.message };
    }

    assert.equal(blocked.code, "per_request_limit_exceeded");

    const state = await fetch(`${vaultUrl}/state`, {
      headers: {
        "x-safepay-admin-token": adminToken
      }
    }).then((response) => response.json());
    assert.equal(state.metrics.receiptCount, 2);
    assert.equal(state.metrics.totalSettledMinor, 265);
    assert.equal(state.metrics.reusedCount, 1);
    assert.equal(state.metrics.blockedCount, 1);
  } finally {
    await new Promise((resolve) => vault.server.close(resolve));
    await new Promise((resolve) => api.server.close(resolve));
  }
});

test("vault rejects unauthenticated admin and agent requests when tokens are configured", async () => {
  const silentLogger = {
    log() {}
  };

  const vault = await startVaultServer({
    port: 0,
    adminToken: "locked-admin",
    agentToken: "locked-agent",
    providerToken: "locked-provider",
    logger: silentLogger
  });

  try {
    const stateResponse = await fetch(`http://127.0.0.1:${vault.port}/state`);
    assert.equal(stateResponse.status, 401);
    assert.equal((await stateResponse.json()).code, "admin_auth_required");

    const authorizeResponse = await fetch(`http://127.0.0.1:${vault.port}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        quote: {
          quoteId: "quote_demo",
          domain: "127.0.0.1:4200",
          route: "/api/research",
          resource: "demo",
          recipient: "merchant_demo_main",
          tokenMint: "USDC",
          amountMinor: 100,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10_000).toISOString()
        },
        runId: "run_demo_main",
        agentId: "agent_demo",
        idempotencyKey: "idem_demo"
      })
    });

    assert.equal(authorizeResponse.status, 401);
    assert.equal((await authorizeResponse.json()).code, "agent_auth_required");
  } finally {
    await new Promise((resolve) => vault.server.close(resolve));
  }
});
