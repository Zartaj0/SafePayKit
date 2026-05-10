const stateRoute = "/api/state";

const SCENARIOS = {
  normal: {
    title: "Approve safe call",
    badge: "Allowed",
    why: "The provider signs a price quote. The vault checks policy, reserves budget, and authorizes the paid API call without giving the agent a spend key.",
    proofs: [
      "Provider quote is signed.",
      "Budget is reserved before settlement.",
      "Receipt is signed after the provider settles."
    ]
  },
  timeout: {
    title: "Reuse on retry",
    badge: "Retry-safe",
    why: "A network timeout happens after authorization. The retry uses the same run and idempotency key, so the vault reuses the existing reservation instead of approving a second spend.",
    proofs: [
      "The same run and idempotency key map to one reservation.",
      "The provider settles exactly once.",
      "The retry does not create another payment intent."
    ]
  },
  price: {
    title: "Block expensive quote",
    badge: "Blocked",
    why: "The provider asks for more than the policy allows. The vault rejects the quote before money can move.",
    proofs: [
      "Per-request limit is enforced before payment.",
      "No reservation is created for the unsafe quote.",
      "The blocked attempt is logged for audit."
    ]
  },
  recipient: {
    title: "Block wrong recipient",
    badge: "Blocked",
    why: "The payment recipient changes away from the policy allowlist. The vault stops the request before settlement.",
    proofs: [
      "Recipient must match policy.",
      "The spend never reaches settlement.",
      "The failure becomes part of the anomaly trail."
    ]
  },
  route: {
    title: "Block wrong route",
    badge: "Blocked",
    why: "The agent tries to call a non-allowlisted API route. The vault blocks the request.",
    proofs: [
      "Non-allowlisted routes are blocked.",
      "Blocked attempts increment anomaly tracking.",
      "No reservation is created for a disallowed route."
    ]
  },
  breaker: {
    title: "Trip breaker",
    badge: "Stop-loss",
    why: "Repeated unsafe requests escalate from individual blocks into a breaker state, stopping further autonomous spend attempts.",
    proofs: [
      "Each blocked attempt increments anomaly count.",
      "The breaker trips once the threshold is reached.",
      "Subsequent attempts are stopped by breaker state."
    ]
  }
};

const FLOW_STEPS = ["normal", "timeout", "price", "breaker"];

const appState = {
  selectedScenario: "timeout",
  runningScenario: null,
  runningAgentRun: false,
  snapshot: null,
  lastResult: null
};

function formatMoney(minor = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(minor / 100);
}

function formatDateTime(value) {
  if (!value) {
    return "N/A";
  }

  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function truncateMiddle(value, start = 14, end = 8) {
  const input = String(value ?? "");
  if (input.length <= start + end + 3) {
    return input;
  }
  return `${input.slice(0, start)}...${input.slice(-end)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function humanizeCode(code) {
  const raw = String(code ?? "")
    .replaceAll("_", " ")
    .trim();
  if (!raw) {
    return "Unknown result";
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message ?? payload.code ?? "request_failed");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function renderFlowSteps() {
  const host = document.querySelector("#flow-steps");
  host.innerHTML = FLOW_STEPS.map(
    (scenario, index) => `
      <article class="flow-step">
        <span class="flow-index">0${index + 1}</span>
        <strong>${SCENARIOS[scenario].title}</strong>
        <p>${SCENARIOS[scenario].why}</p>
      </article>
    `
  ).join("");
}

function renderProofStrip(snapshot) {
  const host = document.querySelector("#proof-strip");
  if (!snapshot) {
    host.innerHTML = `<p class="empty">Reset the console to activate the live proof panels.</p>`;
    return;
  }

  const cards = [
    {
      label: "Spend key boundary",
      value: snapshot.publicKey ? "Signer held by vault" : "Signer unavailable",
      note: "The agent never receives the spend key."
    },
    {
      label: "Retry safety",
      value:
        snapshot.metrics.reusedCount > 0
          ? `${snapshot.metrics.reusedCount} reservation reuse(s)`
          : "No retries reused yet",
      note: "Reuse is anchored to runId plus idempotencyKey."
    },
    {
      label: "Receipts",
      value: `${snapshot.metrics.receiptCount} signed receipt(s)`,
      note: "Settlement proof comes from the vault signer."
    },
    {
      label: "Audit trail",
      value:
        snapshot.storage?.mode === "file"
          ? "Restart-safe state enabled"
          : "In-memory only",
      note:
        snapshot.storage?.mode === "file"
          ? "Receipts, runs, and audit logs survive restart."
          : "Useful for tests, but weaker for a real deployment."
    }
  ];

  host.innerHTML = cards
    .map(
      (card) => `
        <article class="proof-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <p>${escapeHtml(card.note)}</p>
        </article>
      `
    )
    .join("");
}

function renderDemoStatus(snapshot) {
  const host = document.querySelector("#console-status");
  if (!snapshot?.metrics) {
    host.innerHTML = `
      <strong>Console is starting.</strong>
      <span>Waiting for vault state.</span>
    `;
    return;
  }

  if (appState.runningAgentRun) {
    host.innerHTML = `
      <strong>Processing agent run...</strong>
      <span>The vault is checking quotes, reserving budget, reusing retry state, and blocking unsafe spend.</span>
    `;
    return;
  }

  const metrics = snapshot.metrics;
  const complete =
    metrics.receiptCount >= 2 && metrics.reusedCount >= 1 && snapshot.breaker?.tripped;

  host.innerHTML = complete
    ? `
      <strong>Agent run complete.</strong>
      <span>${metrics.receiptCount} signed receipts, ${metrics.reusedCount} retry reuse, ${metrics.blockedCount} blocked attempts, breaker tripped.</span>
    `
    : `
      <strong>Ready.</strong>
      <span>Start an agent run to create live reservations, receipts, policy blocks, and breaker state.</span>
    `;
}

function renderStorage(snapshot) {
  const host = document.querySelector("#storage-summary");
  if (!snapshot) {
    host.innerHTML = `<p class="empty">No runtime loaded yet.</p>`;
    return;
  }

  const items = [
    ["Store mode", snapshot.storage?.mode ?? "memory"],
    ["Store path", snapshot.storage?.filePath ?? "Ephemeral runtime"],
    ["Last saved", snapshot.storage?.lastSavedAt ? formatDateTime(snapshot.storage.lastSavedAt) : "Not persisted"],
    ["Vault public key", truncateMiddle(snapshot.publicKey ?? "unavailable")]
  ];

  host.innerHTML = items
    .map(
      ([label, value]) => `
        <div class="stat-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `
    )
    .join("");
}

function renderPolicy(policy) {
  const host = document.querySelector("#policy-summary");
  if (!policy) {
    host.innerHTML = `<p class="empty">Reset the console to begin.</p>`;
    return;
  }

  const items = [
    ["Daily budget", formatMoney(policy.dailyBudgetMinor)],
    ["Per-run budget", formatMoney(policy.perRunBudgetMinor)],
    ["Per-request limit", formatMoney(policy.perRequestLimitMinor)],
    ["Retry TTL", `${policy.ttlSeconds}s`],
    ["Allowed domains", policy.allowedDomains.join(", ")],
    ["Allowed routes", policy.allowedRoutes.join(", ")],
    ["Allowed recipients", policy.allowedRecipients.join(", ")],
    ["Provider quote keys", `${policy.allowedProviderKeys?.length ?? 0} allowlisted`]
  ];

  host.innerHTML = items
    .map(
      ([label, value]) => `
        <div class="stat-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `
    )
    .join("");
}

function renderMetrics(metrics) {
  const host = document.querySelector("#metric-summary");
  if (!metrics) {
    host.innerHTML = `<p class="empty">No metrics yet.</p>`;
    return;
  }

  const cards = [
    ["Reservations", metrics.reservationCount],
    ["Retry reuses", metrics.reusedCount],
    ["Settled spend", formatMoney(metrics.totalSettledMinor)],
    ["Blocked", metrics.blockedCount]
  ];

  host.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="metric-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `
    )
    .join("");
}

function renderBreaker(breaker) {
  const host = document.querySelector("#breaker-summary");
  if (!breaker) {
    host.innerHTML = `<p class="empty">No breaker state yet.</p>`;
    return;
  }

  host.className = `breaker-card ${breaker.tripped ? "tripped" : ""}`;
  host.innerHTML = `
    <div class="breaker-status ${breaker.tripped ? "alert" : "safe"}">
      ${breaker.tripped ? "Tripped" : "Healthy"}
    </div>
    <p><strong>Anomaly count:</strong> ${breaker.anomalyCount}</p>
    <p><strong>Reason:</strong> ${escapeHtml(breaker.reason ?? "None")}</p>
    <p><strong>Triggered at:</strong> ${escapeHtml(formatDateTime(breaker.triggeredAt))}</p>
  `;
}

function renderScenarioCards() {
  for (const button of document.querySelectorAll("[data-scenario]")) {
    const scenario = button.dataset.scenario;
    const isActive = scenario === appState.selectedScenario;
    const isRunning = scenario === appState.runningScenario;
    button.classList.toggle("active", isActive);
    button.classList.toggle("running", isRunning);
    button.disabled = Boolean(appState.runningScenario || appState.runningAgentRun);
  }

  document.querySelector("#start-agent-run").disabled = Boolean(
    appState.runningScenario || appState.runningAgentRun
  );
  document.querySelector("#reset-console").disabled = Boolean(
    appState.runningScenario || appState.runningAgentRun
  );
  document.querySelector("#reset-breaker").disabled = Boolean(
    appState.runningScenario || appState.runningAgentRun
  );
}

function renderScenarioDetail() {
  const host = document.querySelector("#scenario-detail");
  const scenario = SCENARIOS[appState.selectedScenario];
  if (!scenario) {
    host.innerHTML = `<p class="empty">Select a scenario.</p>`;
    return;
  }

  host.innerHTML = `
    <div class="detail-card">
      <span class="detail-tag">${escapeHtml(scenario.badge)}</span>
      <h3>${escapeHtml(scenario.title)}</h3>
      <p>${escapeHtml(scenario.why)}</p>
      <ul class="detail-list">
        ${scenario.proofs.map((proof) => `<li>${escapeHtml(proof)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderList(selector, items, renderItem, emptyLabel) {
  const host = document.querySelector(selector);
  if (!items || items.length === 0) {
    host.innerHTML = `<p class="empty">${emptyLabel}</p>`;
    return;
  }

  host.innerHTML = `<div class="list-stack">${items.map(renderItem).join("")}</div>`;
}

function renderReservation(reservation) {
  return `
    <div class="list-card">
      <span>${escapeHtml(humanizeCode(reservation.status))} · ${escapeHtml(reservation.runId)}</span>
      <strong>${escapeHtml(formatMoney(reservation.reservedAmountMinor))}</strong>
      <code title="${escapeHtml(reservation.reservationId)}">${escapeHtml(truncateMiddle(reservation.reservationId))}</code>
      <span>Authorized ${reservation.attempts} time(s), reused ${reservation.reusedCount} time(s)</span>
      <span>Expires ${escapeHtml(formatDateTime(reservation.expiresAt))}</span>
    </div>
  `;
}

function renderReceipt(receipt) {
  return `
    <div class="list-card">
      <span>${escapeHtml(formatDateTime(receipt.settledAt))}</span>
      <strong>${escapeHtml(formatMoney(receipt.amountMinor))}</strong>
      <code title="${escapeHtml(receipt.receiptId)}">${escapeHtml(truncateMiddle(receipt.receiptId))}</code>
      <span>${escapeHtml(receipt.providerReceiptId)}</span>
    </div>
  `;
}

function renderBlockedAttempt(attempt) {
  return `
    <div class="list-card">
      <span>${escapeHtml(formatDateTime(attempt.at))}</span>
      <strong>${escapeHtml(humanizeCode(attempt.reason))}</strong>
      <code>${escapeHtml(JSON.stringify(attempt.details))}</code>
    </div>
  `;
}

function renderAuditEvent(event) {
  return `
    <div class="list-card">
      <span>${escapeHtml(formatDateTime(event.at))}</span>
      <strong>${escapeHtml(event.summary)}</strong>
      <code>${escapeHtml(event.type)}</code>
    </div>
  `;
}

function renderScenarioResult() {
  const host = document.querySelector("#scenario-result");

  if (appState.runningScenario) {
    const scenario = SCENARIOS[appState.runningScenario];
    host.innerHTML = `
      <article class="result-card">
        <div class="result-head">
          <span class="result-badge pending">Running</span>
          <strong>${escapeHtml(scenario.title)}</strong>
        </div>
        <p>Executing the scenario and refreshing live state.</p>
      </article>
    `;
    return;
  }

  if (appState.runningAgentRun) {
    host.innerHTML = `
      <article class="result-card">
        <div class="result-head">
          <span class="result-badge pending">Running</span>
          <strong>Agent run</strong>
        </div>
        <p>SafePayKit is processing a safe paid call, a timeout retry, an expensive quote, and repeated unsafe calls.</p>
      </article>
    `;
    return;
  }

  if (!appState.lastResult) {
    host.innerHTML = `
      <article class="result-card">
        <div class="result-head">
          <span class="result-badge idle">Ready</span>
          <strong>Start an agent run to see the control path.</strong>
        </div>
        <p>This panel explains what the vault approved, reused, blocked, or escalated.</p>
      </article>
    `;
    return;
  }

  const scenario = SCENARIOS[appState.lastResult.scenario] ?? {
    title: humanizeCode(appState.lastResult.scenario ?? "result")
  };

  const rawPayload = appState.lastResult.payload ?? {};
  const rawJson = escapeHtml(JSON.stringify(rawPayload, null, 2));
  const badge =
    appState.lastResult.status === "success"
      ? `<span class="result-badge success">Completed</span>`
      : appState.lastResult.status === "info"
        ? `<span class="result-badge idle">Updated</span>`
        : `<span class="result-badge blocked">Blocked</span>`;

  let summary = "";
  let facts = [];

  if (appState.lastResult.status === "success") {
    if (appState.lastResult.scenario === "breaker") {
      summary = "Breaker protection escalated after repeated blocked attempts.";
      facts = [
        `${rawPayload.attempts?.length ?? 0} blocked attempt(s) executed`,
        `Breaker state: ${rawPayload.breaker?.tripped ? "tripped" : "healthy"}`,
        `Reason: ${humanizeCode(rawPayload.breaker?.reason ?? "none")}`
      ];
    } else {
      summary = rawPayload.result?.summary ?? "Scenario completed successfully.";
      facts = [
        rawPayload.receipt
          ? `Settled ${formatMoney(rawPayload.receipt.amountMinor)}`
          : "No settlement returned",
        rawPayload.reservationId
          ? `Reservation ${truncateMiddle(rawPayload.reservationId)}`
          : "No reservation id",
        rawPayload.receipt?.receiptId
          ? `Receipt ${truncateMiddle(rawPayload.receipt.receiptId)}`
          : "No receipt id"
      ];

      if (appState.lastResult.scenario === "timeout") {
        facts[1] = "Reservation reused after timeout";
      }
    }
  } else if (appState.lastResult.status === "info") {
    summary = rawPayload.message ?? "Dashboard state updated.";
    facts = rawPayload.facts ?? [];
  } else {
    const code = rawPayload.code ?? rawPayload.details?.code ?? appState.lastResult.message;
    summary = `Policy blocked the request before unsafe spend could settle.`;
    facts = [
      `Reason: ${humanizeCode(code)}`,
      `Breaker anomalies: ${appState.snapshot?.breaker?.anomalyCount ?? 0}`,
      "Audit log updated with the failed attempt"
    ];
  }

  host.innerHTML = `
    <article class="result-card">
      <div class="result-head">
        ${badge}
        <strong>${escapeHtml(scenario.title)}</strong>
      </div>
      <p>${escapeHtml(summary)}</p>
      <div class="result-facts">
        ${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}
      </div>
      <details class="result-raw">
        <summary>Raw output</summary>
        <pre>${rawJson}</pre>
      </details>
    </article>
  `;
}

async function refresh() {
  const snapshot = await requestJson(stateRoute);
  appState.snapshot = snapshot;
  renderDemoStatus(snapshot);
  renderProofStrip(snapshot);
  renderStorage(snapshot);
  renderPolicy(snapshot.policy);
  renderMetrics(snapshot.metrics);
  renderBreaker(snapshot.breaker);
  renderList("#reservations", snapshot.reservations, renderReservation, "No reservations yet.");
  renderList("#receipts", snapshot.receipts, renderReceipt, "No receipts yet.");
  renderList(
    "#blocked-attempts",
    snapshot.blockedAttempts,
    renderBlockedAttempt,
    "No blocked attempts yet."
  );
  renderList("#audit-log", snapshot.auditLog, renderAuditEvent, "No audit events yet.");
  renderScenarioResult();
}

async function resetConsole() {
  const payload = await requestJson("/api/seed", {
    method: "POST",
    body: JSON.stringify({})
  });
  appState.lastResult = {
    status: "info",
    scenario: appState.selectedScenario,
    payload: {
      message: "Console reset. Policy, run state, receipts, and breaker counters are clean.",
      facts: [
        "Reservations, receipts, and anomaly counters reset",
        "Persisted store updated immediately",
        "Ready for the next agent run"
      ],
      snapshot: payload.snapshot
    }
  };
  await refresh();
}

async function runScenario(scenario) {
  appState.selectedScenario = scenario;
  appState.runningScenario = scenario;
  renderScenarioCards();
  renderScenarioDetail();
  renderScenarioResult();

  try {
    const payload = await requestJson(`/api/scenarios/${scenario}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    appState.lastResult = {
      status: "success",
      scenario,
      payload: payload.result
    };
  } catch (error) {
    appState.lastResult = {
      status: "blocked",
      scenario,
      message: error.message,
      payload: error.payload ?? { message: error.message }
    };
  } finally {
    appState.runningScenario = null;
  }

  await refresh();
  renderScenarioCards();
  renderScenarioDetail();
}

async function runAgentRun() {
  appState.runningAgentRun = true;
  appState.selectedScenario = "normal";
  appState.lastResult = null;
  renderScenarioCards();
  renderScenarioDetail();
  renderScenarioResult();

  try {
    await resetConsole();

    const steps = ["normal", "timeout", "price", "breaker"];
    const results = [];

    for (const step of steps) {
      appState.selectedScenario = step;
      renderScenarioCards();
      renderScenarioDetail();

      try {
        const payload = await requestJson(`/api/scenarios/${step}`, {
          method: "POST",
          body: JSON.stringify({})
        });
        results.push({
          step,
          status: "success",
          payload: payload.result
        });
      } catch (error) {
        results.push({
          step,
          status: "blocked",
          payload: error.payload ?? { message: error.message }
        });
      }

      await refresh();
    }

    appState.lastResult = {
      status: "info",
      scenario: "timeout",
      payload: {
        message: "Agent run complete. The live panels now show the control decisions.",
        facts: [
          "Safe quote approved and settled once",
          "Timeout retry reused one reservation",
          "Expensive quote blocked before settlement",
          "Repeated unsafe calls tripped the breaker"
        ],
        results
      }
    };
  } finally {
    appState.runningAgentRun = false;
  }

  await refresh();
  renderScenarioCards();
  renderScenarioDetail();
}

async function resetBreaker() {
  await requestJson("/api/breaker/reset", {
    method: "POST",
    body: JSON.stringify({})
  });
  appState.lastResult = {
    status: "info",
    scenario: appState.selectedScenario,
    payload: {
      message: "Breaker reset. The stack is back in a healthy state.",
      facts: [
        "Anomaly counter cleared",
        "Future authorizations can proceed again",
        "Audit log preserved the reset event"
      ]
    }
  };
  await refresh();
}

renderFlowSteps();
renderScenarioCards();
renderScenarioDetail();
renderScenarioResult();

document.querySelector("#reset-console").addEventListener("click", resetConsole);
document.querySelector("#reset-breaker").addEventListener("click", resetBreaker);
document.querySelector("#start-agent-run").addEventListener("click", runAgentRun);

for (const button of document.querySelectorAll("[data-scenario]")) {
  button.addEventListener("click", () => {
    appState.selectedScenario = button.dataset.scenario;
    renderScenarioCards();
    renderScenarioDetail();
    void runScenario(button.dataset.scenario);
  });
}

await refresh();
setInterval(refresh, 4_000);
