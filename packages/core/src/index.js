import {
  fingerprintQuote,
  isoTime,
  makeId,
  normalizeDomain,
  validateQuote,
  verifyQuoteSignature
} from "../../policy-schema/src/index.js";

function clone(value) {
  return structuredClone(value);
}

export function createEmptyState() {
  return {
    reservations: {},
    receipts: {},
    refunds: {},
    idempotency: {},
    blockedAttempts: [],
    auditLog: [],
    dailySpendMinor: {},
    breaker: {
      tripped: false,
      reason: null,
      anomalyCount: 0,
      triggeredAt: null
    }
  };
}

function recordAudit(state, type, summary, data = {}, at = Date.now()) {
  state.auditLog.push({
    eventId: makeId("evt"),
    type,
    summary,
    at: isoTime(at),
    data
  });
}

function recordBlockedAttempt(state, policy, reason, details = {}, at = Date.now()) {
  const attempt = {
    attemptId: makeId("blk"),
    reason,
    at: isoTime(at),
    details
  };

  state.blockedAttempts.push(attempt);
  state.breaker.anomalyCount += 1;

  if (
    policy.breakerEnabled &&
    !state.breaker.tripped &&
    state.breaker.anomalyCount >= policy.anomalyTripThreshold
  ) {
    state.breaker.tripped = true;
    state.breaker.reason = reason;
    state.breaker.triggeredAt = isoTime(at);
    recordAudit(
      state,
      "breaker.tripped",
      `Breaker tripped after ${state.breaker.anomalyCount} anomalies`,
      {
        reason,
        anomalyCount: state.breaker.anomalyCount
      },
      at
    );
  }

  recordAudit(state, "attempt.blocked", `Blocked attempt: ${reason}`, details, at);
  return attempt;
}

function dayKey(at) {
  return isoTime(at).slice(0, 10);
}

function isOpenReservation(reservation) {
  return reservation.status === "reserved";
}

function runSpentMinor(state, runId) {
  return Object.values(state.receipts)
    .filter((receipt) => receipt.runId === runId)
    .reduce((sum, receipt) => sum + receipt.amountMinor, 0);
}

function runReservedMinor(state, runId) {
  return Object.values(state.reservations)
    .filter((reservation) => reservation.runId === runId && isOpenReservation(reservation))
    .reduce((sum, reservation) => sum + reservation.reservedAmountMinor, 0);
}

function dailyReservedMinor(state, at) {
  const currentDay = dayKey(at);
  return Object.values(state.reservations)
    .filter(
      (reservation) =>
        isOpenReservation(reservation) && reservation.createdAt.slice(0, 10) === currentDay
    )
    .reduce((sum, reservation) => sum + reservation.reservedAmountMinor, 0);
}

function velocitySpentMinor(state, at) {
  const lowerBound = at - 60_000;
  return Object.values(state.receipts)
    .filter((receipt) => new Date(receipt.settledAt).getTime() >= lowerBound)
    .reduce((sum, receipt) => sum + receipt.amountMinor, 0);
}

function velocityReservedMinor(state, at) {
  const lowerBound = at - 60_000;
  return Object.values(state.reservations)
    .filter(
      (reservation) =>
        isOpenReservation(reservation) &&
        new Date(reservation.createdAt).getTime() >= lowerBound
    )
    .reduce((sum, reservation) => sum + reservation.reservedAmountMinor, 0);
}

export function expireOpenReservations(state, at = Date.now()) {
  let expiredCount = 0;

  for (const reservation of Object.values(state.reservations)) {
    if (
      reservation.status === "reserved" &&
      new Date(reservation.expiresAt).getTime() < at
    ) {
      reservation.status = "expired";
      reservation.expiredAt = isoTime(at);
      expiredCount += 1;
      recordAudit(
        state,
        "reservation.expired",
        `Reservation ${reservation.reservationId} expired`,
        {
          reservationId: reservation.reservationId,
          runId: reservation.runId
        },
        at
      );
    }
  }

  return expiredCount;
}

export function authorizePayment({
  policy,
  state,
  quote,
  runId,
  agentId,
  idempotencyKey,
  at = Date.now()
}) {
  const next = clone(state);
  expireOpenReservations(next, at);

  if (next.breaker.tripped) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "breaker_tripped",
      { runId, agentId, breakerReason: next.breaker.reason },
      at
    );
    return { ok: false, code: "breaker_tripped", state: next, attempt };
  }

  const quoteErrors = validateQuote(quote);
  if (quoteErrors.length > 0) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "invalid_quote",
      { errors: quoteErrors, runId, agentId },
      at
    );
    return { ok: false, code: "invalid_quote", state: next, attempt };
  }

  if (policy.requireIdempotencyKey && !idempotencyKey) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "missing_idempotency_key",
      { runId, agentId },
      at
    );
    return { ok: false, code: "missing_idempotency_key", state: next, attempt };
  }

  if (policy.agentId && String(agentId) !== String(policy.agentId)) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "agent_mismatch",
      {
        runId,
        agentId,
        expectedAgentId: policy.agentId
      },
      at
    );
    return { ok: false, code: "agent_mismatch", state: next, attempt };
  }

  if (String(quote.tokenMint) !== String(policy.tokenMint)) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "token_mint_mismatch",
      {
        runId,
        agentId,
        tokenMint: quote.tokenMint,
        expectedTokenMint: policy.tokenMint
      },
      at
    );
    return { ok: false, code: "token_mint_mismatch", state: next, attempt };
  }

  const providerSignature = verifyQuoteSignature(quote, policy.allowedProviderKeys);
  if (!providerSignature.ok) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      providerSignature.code,
      {
        runId,
        agentId,
        providerId: quote.providerId ?? null
      },
      at
    );
    return { ok: false, code: providerSignature.code, state: next, attempt };
  }

  const compositeKey = idempotencyKey
    ? `${policy.policyId}:${agentId}:${runId}:${idempotencyKey}`
    : null;
  const existingReservationId = compositeKey ? next.idempotency[compositeKey] : null;
  const quoteFingerprint = fingerprintQuote(quote);

  if (existingReservationId) {
    const existing = next.reservations[existingReservationId];
    if (!existing) {
      delete next.idempotency[compositeKey];
    } else if (
      existing.agentId !== agentId ||
      existing.runId !== runId ||
      existing.policyId !== policy.policyId
    ) {
      const attempt = recordBlockedAttempt(
        next,
        policy,
        "idempotency_scope_mismatch",
        {
          runId,
          agentId,
          reservationId: existing.reservationId
        },
        at
      );
      return { ok: false, code: "idempotency_scope_mismatch", state: next, attempt };
    } else if (existing.quoteFingerprint !== quoteFingerprint) {
      const attempt = recordBlockedAttempt(
        next,
        policy,
        "idempotency_mismatch",
        {
          runId,
          agentId,
          reservationId: existing.reservationId
        },
        at
      );
      return { ok: false, code: "idempotency_mismatch", state: next, attempt };
    } else if (existing.status === "expired") {
      const attempt = recordBlockedAttempt(
        next,
        policy,
        "reservation_expired",
        {
          runId,
          agentId,
          reservationId: existing.reservationId
        },
        at
      );
      return { ok: false, code: "reservation_expired", state: next, attempt };
    } else {
      if (existing.reusedCount >= policy.maxRetriesPerReservation) {
        const attempt = recordBlockedAttempt(
          next,
          policy,
          "retry_limit_exceeded",
          {
            runId,
            agentId,
            reservationId: existing.reservationId
          },
          at
        );
        return { ok: false, code: "retry_limit_exceeded", state: next, attempt };
      }

      existing.reusedCount += 1;
      existing.attempts += 1;
      existing.lastAuthorizedAt = isoTime(at);
      recordAudit(
        next,
        "reservation.reused",
        `Reservation ${existing.reservationId} reused`,
        {
          reservationId: existing.reservationId,
          runId
        },
        at
      );
      return {
        ok: true,
        reused: true,
        state: next,
        reservation: existing
      };
    }
  }

  const quoteExpiry = new Date(quote.expiresAt).getTime();
  if (Number.isNaN(quoteExpiry) || quoteExpiry <= at) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "quote_expired",
      { runId, agentId, quoteId: quote.quoteId },
      at
    );
    return { ok: false, code: "quote_expired", state: next, attempt };
  }

  const domain = normalizeDomain(quote.domain);
  if (!policy.allowedDomains.includes(domain)) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "domain_not_allowlisted",
      { runId, agentId, domain },
      at
    );
    return { ok: false, code: "domain_not_allowlisted", state: next, attempt };
  }

  if (policy.allowedRoutes.length > 0 && !policy.allowedRoutes.includes(quote.route)) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "route_not_allowlisted",
      { runId, agentId, route: quote.route },
      at
    );
    return { ok: false, code: "route_not_allowlisted", state: next, attempt };
  }

  if (!policy.allowedRecipients.includes(String(quote.recipient))) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "recipient_not_allowlisted",
      { runId, agentId, recipient: quote.recipient },
      at
    );
    return { ok: false, code: "recipient_not_allowlisted", state: next, attempt };
  }

  if (Number(quote.amountMinor) > policy.perRequestLimitMinor) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "per_request_limit_exceeded",
      { runId, agentId, amountMinor: Number(quote.amountMinor) },
      at
    );
    return { ok: false, code: "per_request_limit_exceeded", state: next, attempt };
  }

  if (
    policy.approvalRequiredAboveMinor > 0 &&
    Number(quote.amountMinor) > policy.approvalRequiredAboveMinor
  ) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "manual_approval_required",
      { runId, agentId, amountMinor: Number(quote.amountMinor) },
      at
    );
    return { ok: false, code: "manual_approval_required", state: next, attempt };
  }

  const currentRunSpend = runSpentMinor(next, runId);
  const currentRunReserved = runReservedMinor(next, runId);
  if (
    currentRunSpend + currentRunReserved + Number(quote.amountMinor) >
    policy.perRunBudgetMinor
  ) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "run_budget_exhausted",
      { runId, agentId, currentRunSpend, currentRunReserved },
      at
    );
    return { ok: false, code: "run_budget_exhausted", state: next, attempt };
  }

  const currentDailySpend = next.dailySpendMinor[dayKey(at)] ?? 0;
  const currentDailyReserved = dailyReservedMinor(next, at);
  if (
    currentDailySpend + currentDailyReserved + Number(quote.amountMinor) >
    policy.dailyBudgetMinor
  ) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "daily_budget_exhausted",
      { runId, agentId, currentDailySpend, currentDailyReserved },
      at
    );
    return { ok: false, code: "daily_budget_exhausted", state: next, attempt };
  }

  const velocitySpend = velocitySpentMinor(next, at);
  const velocityReserved = velocityReservedMinor(next, at);
  if (
    velocitySpend + velocityReserved + Number(quote.amountMinor) >
    policy.maxSpendVelocityMinor
  ) {
    const attempt = recordBlockedAttempt(
      next,
      policy,
      "velocity_limit_exceeded",
      { runId, agentId, velocitySpend, velocityReserved },
      at
    );
    return { ok: false, code: "velocity_limit_exceeded", state: next, attempt };
  }

  const reservationId = makeId("res");
  const expiresAt = Math.min(quoteExpiry, at + policy.ttlSeconds * 1_000);
  const reservation = {
    reservationId,
    policyId: policy.policyId,
    runId,
    agentId,
    idempotencyKey,
    quoteFingerprint,
    quote,
    reservedAmountMinor: Number(quote.amountMinor),
    status: "reserved",
    createdAt: isoTime(at),
    lastAuthorizedAt: isoTime(at),
    expiresAt: isoTime(expiresAt),
    attempts: 1,
    reusedCount: 0
  };

  next.reservations[reservationId] = reservation;
  if (compositeKey) {
    next.idempotency[compositeKey] = reservationId;
  }
  recordAudit(
    next,
    "reservation.created",
    `Reservation ${reservationId} created`,
    {
      reservationId,
      runId,
      amountMinor: reservation.reservedAmountMinor
    },
    at
  );

  return { ok: true, reused: false, state: next, reservation };
}

export function settleReservation({
  state,
  reservationId,
  providerReceiptId,
  actualAmountMinor,
  at = Date.now()
}) {
  const next = clone(state);
  const reservation = next.reservations[reservationId];

  if (!reservation) {
    return { ok: false, code: "reservation_not_found", state: next };
  }

  if (reservation.status === "settled") {
    const existing = Object.values(next.receipts).find(
      (receipt) => receipt.reservationId === reservationId
    );
    return { ok: true, reused: true, state: next, receipt: existing };
  }

  if (reservation.status === "expired") {
    recordBlockedAttempt(
      next,
      {
        breakerEnabled: false,
        anomalyTripThreshold: Number.MAX_SAFE_INTEGER
      },
      "settlement_after_expiry",
      { reservationId },
      at
    );
    return { ok: false, code: "reservation_expired", state: next };
  }

  if (new Date(reservation.expiresAt).getTime() < at) {
    reservation.status = "expired";
    reservation.expiredAt = isoTime(at);
    recordAudit(
      next,
      "reservation.expired",
      `Reservation ${reservationId} expired before settlement`,
      { reservationId },
      at
    );
    return { ok: false, code: "reservation_expired", state: next };
  }

  if (actualAmountMinor > reservation.reservedAmountMinor) {
    reservation.status = "rejected";
    recordAudit(
      next,
      "settlement.rejected",
      `Reservation ${reservationId} rejected because provider price drifted`,
      {
        reservationId,
        reservedAmountMinor: reservation.reservedAmountMinor,
        actualAmountMinor
      },
      at
    );
    return { ok: false, code: "price_drift", state: next };
  }

  const receiptId = makeId("rcpt");
  const receipt = {
    receiptId,
    reservationId,
    providerReceiptId,
    runId: reservation.runId,
    agentId: reservation.agentId,
    amountMinor: actualAmountMinor,
    settledAt: isoTime(at)
  };

  reservation.status = "settled";
  reservation.settledAt = receipt.settledAt;
  reservation.actualAmountMinor = actualAmountMinor;
  reservation.providerReceiptId = providerReceiptId;

  next.receipts[receiptId] = receipt;
  next.dailySpendMinor[dayKey(at)] = (next.dailySpendMinor[dayKey(at)] ?? 0) + actualAmountMinor;
  recordAudit(
    next,
    "payment.settled",
    `Reservation ${reservationId} settled`,
    {
      reservationId,
      receiptId,
      amountMinor: actualAmountMinor
    },
    at
  );

  return { ok: true, reused: false, state: next, receipt };
}

export function refundReservation({
  state,
  reservationId,
  amountMinor,
  reason = "credit_back",
  at = Date.now()
}) {
  const next = clone(state);
  const reservation = next.reservations[reservationId];

  if (!reservation || reservation.status !== "settled") {
    return { ok: false, code: "refund_not_allowed", state: next };
  }

  const refundId = makeId("refund");
  const refund = {
    refundId,
    reservationId,
    runId: reservation.runId,
    amountMinor,
    reason,
    refundedAt: isoTime(at)
  };

  next.refunds[refundId] = refund;
  reservation.refundedAmountMinor = (reservation.refundedAmountMinor ?? 0) + amountMinor;
  next.dailySpendMinor[dayKey(at)] = Math.max(
    0,
    (next.dailySpendMinor[dayKey(at)] ?? 0) - amountMinor
  );
  recordAudit(
    next,
    "payment.refunded",
    `Reservation ${reservationId} refunded`,
    {
      reservationId,
      refundId,
      amountMinor,
      reason
    },
    at
  );

  return { ok: true, state: next, refund };
}

export function tripBreaker(state, reason = "manual_trip", at = Date.now()) {
  const next = clone(state);
  next.breaker.tripped = true;
  next.breaker.reason = reason;
  next.breaker.triggeredAt = isoTime(at);
  recordAudit(next, "breaker.tripped", `Breaker tripped: ${reason}`, { reason }, at);
  return next;
}

export function resetBreaker(state, at = Date.now()) {
  const next = clone(state);
  next.breaker = {
    tripped: false,
    reason: null,
    anomalyCount: 0,
    triggeredAt: null
  };
  recordAudit(next, "breaker.reset", "Breaker reset", {}, at);
  return next;
}

export function snapshotState({ policy, state, runs, publicKey }) {
  const reservations = Object.values(state.reservations).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  const receipts = Object.values(state.receipts).sort((left, right) =>
    right.settledAt.localeCompare(left.settledAt)
  );
  const refunds = Object.values(state.refunds).sort((left, right) =>
    right.refundedAt.localeCompare(left.refundedAt)
  );
  const auditLog = [...state.auditLog].sort((left, right) => right.at.localeCompare(left.at));
  const blockedAttempts = [...state.blockedAttempts].sort((left, right) =>
    right.at.localeCompare(left.at)
  );
  const openReservations = reservations.filter((reservation) => isOpenReservation(reservation));
  const totalSettledMinor = receipts.reduce((sum, receipt) => sum + receipt.amountMinor, 0);
  const totalRefundedMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  const totalReservedMinor = openReservations.reduce(
    (sum, reservation) => sum + reservation.reservedAmountMinor,
    0
  );

  return {
    policy,
    publicKey,
    breaker: state.breaker,
    runs: Object.values(runs ?? {}),
    metrics: {
      reservationCount: reservations.length,
      openReservationCount: openReservations.length,
      receiptCount: receipts.length,
      blockedCount: blockedAttempts.length,
      reusedCount: reservations.reduce((sum, reservation) => sum + reservation.reusedCount, 0),
      totalSettledMinor,
      totalRefundedMinor,
      totalReservedMinor
    },
    reservations,
    receipts,
    refunds,
    blockedAttempts,
    auditLog
  };
}
