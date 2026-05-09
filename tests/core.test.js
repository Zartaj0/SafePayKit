import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuote,
  createDemoPolicy,
  createProviderKeyPair
} from "../packages/policy-schema/src/index.js";
import {
  authorizePayment,
  createEmptyState,
  settleReservation
} from "../packages/core/src/index.js";

test("reuses a reservation when the same idempotency key retries the same quote", () => {
  const policy = createDemoPolicy();
  let state = createEmptyState();
  const quote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research-timeout",
    resource: "Retry-safe request",
    recipient: "merchant_demo_main",
    amountMinor: 140
  });

  const first = authorizePayment({
    policy,
    state,
    quote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_1"
  });

  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  state = first.state;

  const second = authorizePayment({
    policy,
    state,
    quote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_1"
  });

  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(Object.keys(second.state.reservations).length, 1);
  assert.equal(second.reservation.reusedCount, 1);
});

test("blocks a rogue recipient before settlement", () => {
  const policy = createDemoPolicy();
  const state = createEmptyState();
  const quote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research-recipient-drift",
    resource: "Recipient drift test",
    recipient: "merchant_rogue_sink",
    amountMinor: 125
  });

  const result = authorizePayment({
    policy,
    state,
    quote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_rogue"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "recipient_not_allowlisted");
});

test("trips the breaker after repeated blocked attempts", () => {
  const policy = createDemoPolicy({
    anomalyTripThreshold: 3
  });
  let state = createEmptyState();

  for (let index = 0; index < 3; index += 1) {
    const quote = buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/exfiltrate",
      resource: `Blocked route ${index}`,
      recipient: "merchant_demo_main",
      amountMinor: 75
    });

    const result = authorizePayment({
      policy,
      state,
      quote,
      runId: "run_demo_main",
      agentId: "agent_demo",
      idempotencyKey: `idem_blocked_${index}`
    });

    state = result.state;
  }

  assert.equal(state.breaker.tripped, true);
  assert.equal(state.breaker.reason, "route_not_allowlisted");
});

test("does not allow settlement above the reserved amount", () => {
  const policy = createDemoPolicy();
  let state = createEmptyState();
  const quote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research",
    resource: "Price drift after authorization",
    recipient: "merchant_demo_main",
    amountMinor: 125
  });

  const auth = authorizePayment({
    policy,
    state,
    quote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_settle"
  });
  state = auth.state;

  const settlement = settleReservation({
    state,
    reservationId: auth.reservation.reservationId,
    providerReceiptId: "provider-demo",
    actualAmountMinor: 160
  });

  assert.equal(settlement.ok, false);
  assert.equal(settlement.code, "price_drift");
});

test("counts open reservations against the per-run budget", () => {
  const policy = createDemoPolicy({
    perRunBudgetMinor: 300,
    dailyBudgetMinor: 1_000,
    maxSpendVelocityMinor: 1_000
  });
  let state = createEmptyState();

  const firstQuote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research",
    resource: "First open reservation",
    recipient: "merchant_demo_main",
    amountMinor: 200
  });
  const secondQuote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research",
    resource: "Second open reservation",
    recipient: "merchant_demo_main",
    amountMinor: 200
  });

  const first = authorizePayment({
    policy,
    state,
    quote: firstQuote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_open_1"
  });
  assert.equal(first.ok, true);
  state = first.state;

  const second = authorizePayment({
    policy,
    state,
    quote: secondQuote,
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_open_2"
  });

  assert.equal(second.ok, false);
  assert.equal(second.code, "run_budget_exhausted");
});

test("counts open reservations against the daily budget", () => {
  const policy = createDemoPolicy({
    dailyBudgetMinor: 300,
    perRunBudgetMinor: 1_000,
    maxSpendVelocityMinor: 1_000
  });
  let state = createEmptyState();

  const first = authorizePayment({
    policy,
    state,
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "First daily reservation",
      recipient: "merchant_demo_main",
      amountMinor: 200
    }),
    runId: "run_a",
    agentId: "agent_demo",
    idempotencyKey: "idem_daily_1"
  });
  assert.equal(first.ok, true);
  state = first.state;

  const second = authorizePayment({
    policy,
    state,
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Second daily reservation",
      recipient: "merchant_demo_main",
      amountMinor: 200
    }),
    runId: "run_b",
    agentId: "agent_demo",
    idempotencyKey: "idem_daily_2"
  });

  assert.equal(second.ok, false);
  assert.equal(second.code, "daily_budget_exhausted");
});

test("counts open reservations against the velocity limit", () => {
  const policy = createDemoPolicy({
    perRunBudgetMinor: 1_000,
    dailyBudgetMinor: 1_000,
    maxSpendVelocityMinor: 300
  });
  let state = createEmptyState();

  const first = authorizePayment({
    policy,
    state,
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "First velocity reservation",
      recipient: "merchant_demo_main",
      amountMinor: 200
    }),
    runId: "run_velocity_a",
    agentId: "agent_demo",
    idempotencyKey: "idem_velocity_1"
  });
  assert.equal(first.ok, true);
  state = first.state;

  const second = authorizePayment({
    policy,
    state,
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Second velocity reservation",
      recipient: "merchant_demo_main",
      amountMinor: 200
    }),
    runId: "run_velocity_b",
    agentId: "agent_demo",
    idempotencyKey: "idem_velocity_2"
  });

  assert.equal(second.ok, false);
  assert.equal(second.code, "velocity_limit_exceeded");
});

test("enforces the policy agent id", () => {
  const policy = createDemoPolicy({
    agentId: "agent_expected"
  });

  const result = authorizePayment({
    policy,
    state: createEmptyState(),
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Agent mismatch",
      recipient: "merchant_demo_main",
      amountMinor: 100
    }),
    runId: "run_demo_main",
    agentId: "agent_other",
    idempotencyKey: "idem_agent"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "agent_mismatch");
});

test("enforces the policy token mint", () => {
  const policy = createDemoPolicy({
    tokenMint: "BONK"
  });

  const result = authorizePayment({
    policy,
    state: createEmptyState(),
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Token mismatch",
      recipient: "merchant_demo_main",
      amountMinor: 100,
      tokenMint: "USDC"
    }),
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_token"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "token_mint_mismatch");
});

test("does not reuse idempotency across different agents or policies", () => {
  const policyA = createDemoPolicy({
    policyId: "policy_a",
    agentId: "agent_a"
  });
  const policyB = createDemoPolicy({
    policyId: "policy_b",
    agentId: "agent_b"
  });

  let state = createEmptyState();
  const quote = buildQuote({
    domain: "127.0.0.1:4200",
    route: "/api/research",
    resource: "Scoped idempotency",
    recipient: "merchant_demo_main",
    amountMinor: 100
  });

  const first = authorizePayment({
    policy: policyA,
    state,
    quote,
    runId: "run_shared",
    agentId: "agent_a",
    idempotencyKey: "idem_shared"
  });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  state = first.state;

  const second = authorizePayment({
    policy: policyB,
    state,
    quote,
    runId: "run_shared",
    agentId: "agent_b",
    idempotencyKey: "idem_shared"
  });

  assert.equal(second.ok, true);
  assert.equal(second.reused, false);
  assert.equal(Object.keys(second.state.reservations).length, 2);
});

test("requires an allowlisted provider signature when provider keys are configured", () => {
  const provider = createProviderKeyPair();
  const policy = createDemoPolicy({
    allowedProviderKeys: [provider.publicKeyPem]
  });

  const unsigned = authorizePayment({
    policy,
    state: createEmptyState(),
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Unsigned quote",
      recipient: "merchant_demo_main",
      amountMinor: 100
    }),
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_unsigned"
  });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.code, "missing_provider_signature");

  const signed = authorizePayment({
    policy,
    state: createEmptyState(),
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Signed quote",
      recipient: "merchant_demo_main",
      amountMinor: 100,
      providerPrivateKeyPem: provider.privateKeyPem,
      providerPublicKeyPem: provider.publicKeyPem
    }),
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_signed"
  });
  assert.equal(signed.ok, true);
});

test("rejects provider signatures from non-allowlisted keys", () => {
  const trusted = createProviderKeyPair();
  const untrusted = createProviderKeyPair();
  const policy = createDemoPolicy({
    allowedProviderKeys: [trusted.publicKeyPem]
  });

  const result = authorizePayment({
    policy,
    state: createEmptyState(),
    quote: buildQuote({
      domain: "127.0.0.1:4200",
      route: "/api/research",
      resource: "Wrong provider key",
      recipient: "merchant_demo_main",
      amountMinor: 100,
      providerPrivateKeyPem: untrusted.privateKeyPem,
      providerPublicKeyPem: untrusted.publicKeyPem
    }),
    runId: "run_demo_main",
    agentId: "agent_demo",
    idempotencyKey: "idem_wrong_provider"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "provider_key_not_allowlisted");
});
