import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import {
  createSolanaMemoAnchor,
  verifyReceiptEvidence
} from "../packages/policy-schema/src/index.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const adminToken = "conformance-admin-token";
const agentToken = "conformance-agent-token";
const providerToken = "conformance-provider-token";

const logger = {
  log(message) {
    if (process.env.SAFEPAY_VERBOSE_CONFORMANCE === "1") {
      console.log(message);
    }
  }
};

function check(name, ok, details = {}) {
  return { name, ok: Boolean(ok), details };
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  return {
    response,
    payload: await response.json()
  };
}

const vault = await startVaultServer({
  port: 0,
  adminToken,
  agentToken,
  providerToken,
  logger
});
const api = await startPaidApiServer({
  port: 0,
  vaultUrl: `http://127.0.0.1:${vault.port}`,
  providerToken,
  logger
});

const vaultUrl = `http://127.0.0.1:${vault.port}`;
const apiUrl = `http://127.0.0.1:${api.port}`;

try {
  const checks = [];
  const unauthenticatedState = await getJson(`${vaultUrl}/state`);
  checks.push(
    check("admin_endpoints_require_auth", unauthenticatedState.response.status === 401, {
      status: unauthenticatedState.response.status,
      code: unauthenticatedState.payload.code
    })
  );

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
  checks.push(check("normal_payment_settles", normal.ok === true));

  const timeout = await runScenario({
    scenario: "timeout",
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });
  checks.push(check("timeout_retry_completes", timeout.ok === true));

  let blockedPrice = null;
  try {
    await runScenario({
      scenario: "price",
      vaultUrl,
      apiUrl,
      agentToken,
      adminToken
    });
  } catch (error) {
    blockedPrice = error.payload ?? { code: error.message };
  }
  checks.push(
    check("unsafe_price_blocked_before_settlement", blockedPrice?.code === "per_request_limit_exceeded", {
      code: blockedPrice?.code ?? null
    })
  );

  const { payload: state } = await getJson(`${vaultUrl}/state`, {
    "x-safepay-admin-token": adminToken
  });

  checks.push(check("provider_key_allowlisted", state.policy.allowedProviderKeys.length === 1));
  checks.push(check("retry_reused_one_reservation", state.metrics.reusedCount === 1, state.metrics));
  checks.push(check("exactly_two_receipts_settled", state.metrics.receiptCount === 2, state.metrics));
  checks.push(check("blocked_attempt_recorded", state.metrics.blockedCount >= 1, state.metrics));

  const reservationsById = new Map(
    state.reservations.map((reservation) => [reservation.reservationId, reservation])
  );
  const evidenceBundles = state.receipts.map((receipt) => {
    const reservation = reservationsById.get(receipt.reservationId);
    const anchor = createSolanaMemoAnchor({
      receipt,
      reservation,
      chain: "solana",
      cluster: "devnet",
      program: "spl-memo"
    });
    const evidence = verifyReceiptEvidence({
      policy: state.policy,
      reservation,
      receipt,
      anchor
    });

    checks.push(
      check(`receipt_evidence_valid:${receipt.receiptId}`, evidence.ok, {
        failedChecks: evidence.checks.filter((entry) => !entry.ok)
      })
    );

    return {
      receiptId: receipt.receiptId,
      reservationId: receipt.reservationId,
      amountMinor: receipt.amountMinor,
      providerId: reservation?.quote?.providerId ?? null,
      quoteFingerprint: reservation?.quoteFingerprint ?? null,
      anchorHash: anchor.anchorHash,
      solanaMemo: anchor.memo,
      evidence
    };
  });

  const report = {
    ok: checks.every((entry) => entry.ok),
    standard: "safepay-spend-control-v0",
    publicGoodsClaim:
      "Independent conformance proof for quote authenticity, retry-safe reservations, budget blocks, signed receipts, and Solana Memo-compatible receipt anchors.",
    endpoints: {
      vaultUrl,
      apiUrl
    },
    checks,
    evidenceBundles,
    metrics: state.metrics
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await new Promise((resolve) => vault.server.close(resolve));
  await new Promise((resolve) => api.server.close(resolve));
}
