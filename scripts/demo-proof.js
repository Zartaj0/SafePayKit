import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import {
  createSolanaMemoAnchor,
  verifyReceiptEvidence
} from "../packages/policy-schema/src/index.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const adminToken = "proof-admin-token";
const agentToken = "proof-agent-token";
const providerToken = "proof-provider-token";
const silentLogger = { log() {} };

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.code ?? payload.message ?? `request_failed_${response.status}`);
  }

  return payload;
}

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
  console.log("SafePayKit local proof");
  console.log("No real funds move in this local reference flow.\n");

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
  pass("provider quote key allowlisted");

  const normal = await runScenario({
    scenario: "normal",
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });
  pass(`normal payment settled receipt ${normal.receipt.receiptId}`);

  const timeout = await runScenario({
    scenario: "timeout",
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });
  pass(`timeout retry reused reservation ${timeout.reservationId}`);

  try {
    await runScenario({
      scenario: "price",
      vaultUrl,
      apiUrl,
      agentToken,
      adminToken
    });
    throw new Error("price drift unexpectedly settled");
  } catch (error) {
    const code = error.payload?.code ?? error.message;
    if (code !== "per_request_limit_exceeded") {
      throw error;
    }
    pass("price drift blocked before settlement");
  }

  const breaker = await runScenario({
    scenario: "breaker",
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });
  if (!breaker.breaker.tripped) {
    throw new Error("breaker did not trip");
  }
  pass(`breaker tripped on ${breaker.breaker.reason}`);

  const state = await getJson(`${vaultUrl}/state`, {
    "x-safepay-admin-token": adminToken
  });
  if (state.metrics.receiptCount !== 2 || state.metrics.reusedCount !== 1) {
    throw new Error("unexpected final metrics");
  }
  pass("final metrics show two receipts and one retry reuse");

  const reservationsById = new Map(
    state.reservations.map((reservation) => [reservation.reservationId, reservation])
  );
  const anchors = state.receipts.map((receipt) => {
    const reservation = reservationsById.get(receipt.reservationId);
    const anchor = createSolanaMemoAnchor({ receipt, reservation });
    const evidence = verifyReceiptEvidence({
      policy: state.policy,
      reservation,
      receipt,
      anchor
    });

    if (!evidence.ok) {
      throw new Error(`receipt evidence failed for ${receipt.receiptId}`);
    }

    return anchor;
  });

  pass(`verified ${state.receipts.length} receipt evidence bundle(s)`);
  pass(`sample Solana Memo payload ${anchors[0].memo}`);
  console.log("\nLocal proof complete.");
} catch (error) {
  fail(error.message);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => vault.server.close(resolve));
  await new Promise((resolve) => api.server.close(resolve));
}
