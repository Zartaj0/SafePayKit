import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuote,
  createDemoPolicy,
  createProviderKeyPair,
  createSolanaMemoAnchor,
  verifyReceiptEvidence
} from "../packages/policy-schema/src/index.js";
import {
  authorizePayment,
  createEmptyState,
  settleReservation
} from "../packages/core/src/index.js";
import { createVaultRuntime } from "../packages/vault-service/src/index.js";

test("verifies the complete quote, reservation, receipt, and anchor evidence bundle", () => {
  const provider = createProviderKeyPair();
  const policy = createDemoPolicy({
    allowedProviderKeys: [provider.publicKeyPem]
  });
  let state = createEmptyState();
  const quote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research",
    resource: "Evidence bundle",
    recipient: "merchant_demo_main",
    amountMinor: 125,
    providerPrivateKeyPem: provider.privateKeyPem,
    providerPublicKeyPem: provider.publicKeyPem
  });

  const authorization = authorizePayment({
    policy,
    state,
    quote,
    runId: "run_evidence",
    agentId: "agent_demo",
    idempotencyKey: "idem_evidence"
  });
  assert.equal(authorization.ok, true);
  state = authorization.state;

  const settlement = settleReservation({
    state,
    reservationId: authorization.reservation.reservationId,
    providerReceiptId: "provider_evidence",
    actualAmountMinor: 125
  });
  assert.equal(settlement.ok, true);

  const runtime = createVaultRuntime({ policy, state: settlement.state });
  const receipt = runtime.signReceipt(settlement.receipt);
  const reservation = settlement.state.reservations[receipt.reservationId];
  const anchor = createSolanaMemoAnchor({ receipt, reservation });
  const evidence = verifyReceiptEvidence({
    policy,
    reservation,
    receipt,
    anchor
  });

  assert.equal(evidence.ok, true);
  assert.match(anchor.memo, /^safepay:v0:[a-f0-9]{64}$/);
});

test("rejects tampered receipt evidence", () => {
  const provider = createProviderKeyPair();
  const policy = createDemoPolicy({
    allowedProviderKeys: [provider.publicKeyPem]
  });
  let state = createEmptyState();

  const authorization = authorizePayment({
    policy,
    state,
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Tampered evidence",
      recipient: "merchant_demo_main",
      amountMinor: 125,
      providerPrivateKeyPem: provider.privateKeyPem,
      providerPublicKeyPem: provider.publicKeyPem
    }),
    runId: "run_tamper",
    agentId: "agent_demo",
    idempotencyKey: "idem_tamper"
  });
  state = authorization.state;

  const settlement = settleReservation({
    state,
    reservationId: authorization.reservation.reservationId,
    providerReceiptId: "provider_tamper",
    actualAmountMinor: 125
  });

  const runtime = createVaultRuntime({ policy, state: settlement.state });
  const receipt = runtime.signReceipt(settlement.receipt);
  const reservation = settlement.state.reservations[receipt.reservationId];
  const anchor = createSolanaMemoAnchor({ receipt, reservation });
  const tamperedReceipt = {
    ...receipt,
    amountMinor: 250
  };
  const evidence = verifyReceiptEvidence({
    policy,
    reservation,
    receipt: tamperedReceipt,
    anchor
  });

  assert.equal(evidence.ok, false);
  assert.ok(evidence.checks.some((entry) => entry.code === "invalid_vault_signature"));
});
