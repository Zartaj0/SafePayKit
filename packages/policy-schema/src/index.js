import crypto from "node:crypto";

export const DEFAULT_POLICY = Object.freeze({
  agentId: "agent_demo",
  tokenMint: "USDC",
  dailyBudgetMinor: 2_500,
  perRunBudgetMinor: 1_000,
  perRequestLimitMinor: 300,
  allowedDomains: ["127.0.0.1:4200", "localhost:4200"],
  allowedRoutes: [
    "/api/research",
    "/api/research-timeout",
    "/api/research-recipient-drift",
    "/api/research-premium"
  ],
  allowedRecipients: ["merchant_demo_main"],
  allowedProviderKeys: [],
  ttlSeconds: 30,
  requireIdempotencyKey: true,
  approvalRequiredAboveMinor: 0,
  maxRetriesPerReservation: 2,
  maxSpendVelocityMinor: 700,
  breakerEnabled: true,
  anomalyTripThreshold: 3
});

export function makeId(prefix = "spk") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function isoTime(at = Date.now()) {
  return new Date(at).toISOString();
}

export function normalizeDomain(input) {
  if (!input) {
    return "";
  }

  return String(input).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function normalizePolicy(input = {}) {
  const merged = {
    ...DEFAULT_POLICY,
    ...input
  };

  return {
    policyId: input.policyId ?? makeId("policy"),
    agentId: String(merged.agentId),
    tokenMint: String(merged.tokenMint),
    dailyBudgetMinor: Number(merged.dailyBudgetMinor),
    perRunBudgetMinor: Number(merged.perRunBudgetMinor),
    perRequestLimitMinor: Number(merged.perRequestLimitMinor),
    allowedDomains: [...new Set((merged.allowedDomains ?? []).map(normalizeDomain))],
    allowedRoutes: [...new Set((merged.allowedRoutes ?? []).map((route) => String(route)))],
    allowedRecipients: [
      ...new Set((merged.allowedRecipients ?? []).map((recipient) => String(recipient)))
    ],
    allowedProviderKeys: [
      ...new Set((merged.allowedProviderKeys ?? []).map((key) => String(key)))
    ],
    ttlSeconds: Number(merged.ttlSeconds),
    requireIdempotencyKey: Boolean(merged.requireIdempotencyKey),
    approvalRequiredAboveMinor: Number(merged.approvalRequiredAboveMinor ?? 0),
    maxRetriesPerReservation: Number(merged.maxRetriesPerReservation),
    maxSpendVelocityMinor: Number(merged.maxSpendVelocityMinor),
    breakerEnabled: Boolean(merged.breakerEnabled),
    anomalyTripThreshold: Number(merged.anomalyTripThreshold ?? 3)
  };
}

export function validatePolicy(policy) {
  const errors = [];

  if (!policy.agentId) {
    errors.push("agentId is required");
  }
  if (policy.dailyBudgetMinor <= 0) {
    errors.push("dailyBudgetMinor must be greater than zero");
  }
  if (policy.perRunBudgetMinor <= 0) {
    errors.push("perRunBudgetMinor must be greater than zero");
  }
  if (policy.perRequestLimitMinor <= 0) {
    errors.push("perRequestLimitMinor must be greater than zero");
  }
  if (policy.allowedDomains.length === 0) {
    errors.push("allowedDomains must include at least one origin");
  }
  if (policy.allowedRecipients.length === 0) {
    errors.push("allowedRecipients must include at least one recipient");
  }
  if (policy.ttlSeconds <= 0) {
    errors.push("ttlSeconds must be greater than zero");
  }
  if (policy.maxRetriesPerReservation < 0) {
    errors.push("maxRetriesPerReservation cannot be negative");
  }
  if (policy.maxSpendVelocityMinor <= 0) {
    errors.push("maxSpendVelocityMinor must be greater than zero");
  }
  if (policy.anomalyTripThreshold <= 0) {
    errors.push("anomalyTripThreshold must be greater than zero");
  }

  return errors;
}

export function createDemoPolicy(overrides = {}) {
  const policy = normalizePolicy(overrides);
  const errors = validatePolicy(policy);

  if (errors.length > 0) {
    throw new Error(`Invalid policy: ${errors.join(", ")}`);
  }

  return policy;
}

export function createDemoRun({
  agentId = "agent_demo",
  runId = "run_demo_main",
  label = "Paid API research run"
} = {}) {
  return {
    runId,
    agentId,
    label,
    createdAt: isoTime(),
    status: "active"
  };
}

export function validateQuote(quote) {
  const errors = [];
  const required = [
    "quoteId",
    "domain",
    "route",
    "resource",
    "recipient",
    "tokenMint",
    "amountMinor",
    "issuedAt",
    "expiresAt"
  ];

  for (const field of required) {
    if (quote[field] === undefined || quote[field] === null || quote[field] === "") {
      errors.push(`${field} is required`);
    }
  }

  if (Number(quote.amountMinor) <= 0) {
    errors.push("amountMinor must be greater than zero");
  }

  return errors;
}

export function fingerprintQuote(quote) {
  return hashValue({
    domain: normalizeDomain(quote.domain),
    route: quote.route,
    resource: quote.resource,
    recipient: quote.recipient,
    tokenMint: quote.tokenMint,
    amountMinor: Number(quote.amountMinor)
  });
}

export function quoteSignaturePayload(quote) {
  return {
    quoteId: quote.quoteId,
    domain: normalizeDomain(quote.domain),
    route: quote.route,
    resource: quote.resource,
    recipient: quote.recipient,
    tokenMint: quote.tokenMint,
    amountMinor: Number(quote.amountMinor),
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    providerId: quote.providerId ?? null,
    metadata: quote.metadata ?? {}
  };
}

export function createProviderKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem"
    }),
    publicKeyPem: publicKey.export({
      type: "spki",
      format: "pem"
    })
  };
}

export function signQuote(quote, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const payloadHash = hashValue(quoteSignaturePayload(quote));
  return crypto.sign(null, Buffer.from(payloadHash), privateKey).toString("base64url");
}

export function verifyQuoteSignature(quote, allowedProviderKeys = []) {
  if (!allowedProviderKeys || allowedProviderKeys.length === 0) {
    return { ok: true, skipped: true };
  }

  if (!quote.providerPublicKey || !quote.providerSignature) {
    return { ok: false, code: "missing_provider_signature" };
  }

  if (!allowedProviderKeys.includes(quote.providerPublicKey)) {
    return { ok: false, code: "provider_key_not_allowlisted" };
  }

  try {
    const publicKey = crypto.createPublicKey(quote.providerPublicKey);
    const payloadHash = hashValue(quoteSignaturePayload(quote));
    const valid = crypto.verify(
      null,
      Buffer.from(payloadHash),
      publicKey,
      Buffer.from(quote.providerSignature, "base64url")
    );

    return valid
      ? { ok: true }
      : { ok: false, code: "invalid_provider_signature" };
  } catch {
    return { ok: false, code: "invalid_provider_signature" };
  }
}

export function receiptSignaturePayload(receipt) {
  return {
    receiptId: receipt.receiptId,
    reservationId: receipt.reservationId,
    amountMinor: Number(receipt.amountMinor),
    settledAt: receipt.settledAt,
    providerReceiptId: receipt.providerReceiptId
  };
}

export function verifyReceiptSignature(receipt) {
  if (!receipt?.vaultPublicKey || !receipt?.vaultSignature) {
    return { ok: false, code: "missing_vault_signature" };
  }

  try {
    const publicKey = crypto.createPublicKey(receipt.vaultPublicKey);
    const payloadHash = hashValue(receiptSignaturePayload(receipt));
    const valid = crypto.verify(
      null,
      Buffer.from(payloadHash),
      publicKey,
      Buffer.from(receipt.vaultSignature, "base64url")
    );

    return valid
      ? { ok: true }
      : { ok: false, code: "invalid_vault_signature" };
  } catch {
    return { ok: false, code: "invalid_vault_signature" };
  }
}

export function receiptAnchorPayload({
  receipt,
  reservation,
  chain = "solana",
  cluster = "devnet",
  program = "spl-memo"
}) {
  return {
    standard: "safepay-receipt-anchor-v0",
    chain,
    cluster,
    program,
    receiptId: receipt.receiptId,
    reservationId: receipt.reservationId,
    runId: receipt.runId,
    agentId: receipt.agentId,
    providerId: reservation?.quote?.providerId ?? null,
    providerReceiptId: receipt.providerReceiptId,
    amountMinor: Number(receipt.amountMinor),
    tokenMint: reservation?.quote?.tokenMint ?? null,
    quoteFingerprint: reservation?.quoteFingerprint ?? null,
    vaultPublicKey: receipt.vaultPublicKey ?? null,
    vaultSignature: receipt.vaultSignature ?? null,
    settledAt: receipt.settledAt
  };
}

export function createSolanaMemoAnchor(input) {
  const payload = receiptAnchorPayload(input);
  const anchorHash = hashValue(payload);

  return {
    anchorHash,
    chain: payload.chain,
    cluster: payload.cluster,
    program: payload.program,
    memo: `safepay:v0:${anchorHash}`,
    payload
  };
}

export function verifyReceiptEvidence({ policy, reservation, receipt, anchor = null }) {
  const checks = [];
  const add = (name, ok, code = null, details = {}) => {
    checks.push({ name, ok, code, details });
  };

  add("receipt_exists", Boolean(receipt), receipt ? null : "receipt_missing");
  add(
    "reservation_exists",
    Boolean(reservation),
    reservation ? null : "reservation_missing"
  );

  if (!receipt || !reservation) {
    return {
      ok: false,
      checks,
      summary: {
        receiptId: receipt?.receiptId ?? null,
        reservationId: reservation?.reservationId ?? null
      }
    };
  }

  add(
    "receipt_matches_reservation",
    receipt.reservationId === reservation.reservationId,
    receipt.reservationId === reservation.reservationId
      ? null
      : "receipt_reservation_mismatch"
  );
  add(
    "receipt_run_matches",
    receipt.runId === reservation.runId,
    receipt.runId === reservation.runId ? null : "receipt_run_mismatch"
  );
  add(
    "receipt_agent_matches",
    receipt.agentId === reservation.agentId,
    receipt.agentId === reservation.agentId ? null : "receipt_agent_mismatch"
  );
  add(
    "amount_within_reservation",
    Number(receipt.amountMinor) <= Number(reservation.reservedAmountMinor),
    Number(receipt.amountMinor) <= Number(reservation.reservedAmountMinor)
      ? null
      : "receipt_amount_exceeds_reservation"
  );
  const quoteFingerprint = reservation.quote ? fingerprintQuote(reservation.quote) : null;
  add(
    "quote_fingerprint_matches",
    quoteFingerprint === reservation.quoteFingerprint,
    quoteFingerprint === reservation.quoteFingerprint
      ? null
      : "quote_fingerprint_mismatch"
  );

  const quoteSignature = verifyQuoteSignature(
    reservation.quote ?? {},
    policy?.allowedProviderKeys ?? []
  );
  add(
    "provider_quote_signature",
    quoteSignature.ok,
    quoteSignature.ok ? null : quoteSignature.code,
    { skipped: Boolean(quoteSignature.skipped) }
  );

  const receiptSignature = verifyReceiptSignature(receipt);
  add(
    "vault_receipt_signature",
    receiptSignature.ok,
    receiptSignature.ok ? null : receiptSignature.code
  );

  if (anchor) {
    const expectedAnchor = createSolanaMemoAnchor({
      receipt,
      reservation,
      chain: anchor.chain,
      cluster: anchor.cluster,
      program: anchor.program
    });
    add(
      "anchor_hash_matches",
      anchor.anchorHash === expectedAnchor.anchorHash,
      anchor.anchorHash === expectedAnchor.anchorHash ? null : "anchor_hash_mismatch",
      {
        expectedAnchorHash: expectedAnchor.anchorHash,
        anchorHash: anchor.anchorHash
      }
    );
    add(
      "anchor_memo_matches",
      anchor.memo === expectedAnchor.memo,
      anchor.memo === expectedAnchor.memo ? null : "anchor_memo_mismatch"
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    summary: {
      receiptId: receipt.receiptId,
      reservationId: reservation.reservationId,
      providerId: reservation.quote?.providerId ?? null,
      amountMinor: Number(receipt.amountMinor),
      tokenMint: reservation.quote?.tokenMint ?? null,
      settledAt: receipt.settledAt,
      anchorHash: anchor?.anchorHash ?? null
    }
  };
}

export function buildQuote({
  domain,
  route,
  resource,
  recipient,
  amountMinor,
  tokenMint = "USDC",
  ttlSeconds = 15,
  providerId = "provider_demo",
  providerPrivateKeyPem = null,
  providerPublicKeyPem = null,
  metadata = {}
}) {
  const issuedAt = Date.now();
  const quote = {
    quoteId: makeId("quote"),
    domain: normalizeDomain(domain),
    route,
    resource,
    recipient,
    tokenMint,
    amountMinor,
    issuedAt: isoTime(issuedAt),
    expiresAt: isoTime(issuedAt + ttlSeconds * 1_000),
    providerId,
    metadata
  };

  if (providerPrivateKeyPem && providerPublicKeyPem) {
    quote.providerPublicKey = providerPublicKeyPem;
    quote.providerSignature = signQuote(quote, providerPrivateKeyPem);
  }

  return quote;
}

export function parseJsonSafely(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
