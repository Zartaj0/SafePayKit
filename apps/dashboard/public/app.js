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
  runningLiveRequest: false,
  snapshot: null,
  lastResult: null,
  liveResult: null
};

function makeClientId(prefix) {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ??
    Math.random().toString(16).slice(2, 14);
  return `${prefix}_${random}`;
}

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

function populateLiveRequestIds() {
  document.querySelector("#request-run-id").value = makeClientId("run_live");
  document.querySelector("#request-idempotency-key").value = makeClientId("idem_live");
}

function readLiveRequestForm() {
  return {
    path: document.querySelector("#request-route").value.trim() || "/api/live-research",
    amountMinor: Number(document.querySelector("#request-amount").value),
    recipient:
      document.querySelector("#request-recipient").value.trim() || "merchant_demo_main",
    runId: document.querySelector("#request-run-id").value.trim() || makeClientId("run_live"),
    agentId: "agent_demo",
    idempotencyKey:
      document.querySelector("#request-idempotency-key").value.trim() ||
      makeClientId("idem_live"),
    timeoutFirst: document.querySelector("#request-timeout").checked,
    task:
      document.querySelector("#request-task").value.trim() ||
      "Live agent research request."
  };
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
      <span>Send a live request to create reservations, receipts, blocks, and retry evidence.</span>
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

function renderBudgetBar(label, usedMinor, limitMinor) {
  const pct = limitMinor > 0 ? Math.min(100, (usedMinor / limitMinor) * 100) : 0;
  const danger = pct >= 80;
  return `
    <div class="budget-bar-row">
      <div class="budget-bar-label">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(formatMoney(usedMinor))} / ${escapeHtml(formatMoney(limitMinor))}</span>
      </div>
      <div class="budget-bar-track">
        <div class="budget-bar-fill ${danger ? "danger" : ""}" style="width:${pct.toFixed(1)}%"></div>
      </div>
    </div>
  `;
}

function renderMetrics(metrics) {
  const host = document.querySelector("#metric-summary");
  if (!metrics) {
    host.innerHTML = `<p class="empty">No metrics yet.</p>`;
    return;
  }

  const policy = appState.snapshot?.policy;
  const cards = [
    ["Reservations", metrics.reservationCount],
    ["Retry reuses", metrics.reusedCount],
    ["Settled spend", formatMoney(metrics.totalSettledMinor)],
    ["Blocked", metrics.blockedCount]
  ];

  const budgetBars = policy
    ? `<div class="budget-bars">
        ${renderBudgetBar("Run budget", metrics.totalSettledMinor + metrics.totalReservedMinor, policy.perRunBudgetMinor)}
        ${renderBudgetBar("Daily budget", metrics.totalSettledMinor + metrics.totalReservedMinor, policy.dailyBudgetMinor)}
      </div>`
    : "";

  host.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="metric-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </div>
      `
    )
    .join("") + budgetBars;
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

  const liveForm = document.querySelector("#agent-request-form");
  for (const control of liveForm.querySelectorAll("input, textarea, button")) {
    control.disabled = Boolean(appState.runningScenario || appState.runningAgentRun || appState.runningLiveRequest);
  }
  for (const control of document.querySelectorAll(".demo-presets button")) {
    control.disabled = Boolean(appState.runningScenario || appState.runningAgentRun || appState.runningLiveRequest);
  }
}

function renderLiveRequestResult() {
  const host = document.querySelector("#live-request-result");

  if (appState.runningLiveRequest) {
    host.innerHTML = `
      <strong>Running live payment path...</strong>
      <span>Agent request -> provider 402 quote -> vault authorization -> paid retry -> settlement or block.</span>
    `;
    return;
  }

  if (!appState.liveResult) {
    host.innerHTML = `
      <strong>Waiting for an edited request.</strong>
      <span>Change price to 900 to trigger a budget block, change recipient to merchant_rogue_sink to trigger a recipient block, or check timeout to prove retry reuse.</span>
    `;
    return;
  }

  const rawPayload = appState.liveResult.payload ?? {};
  const rawJson = escapeHtml(JSON.stringify(rawPayload, null, 2));
  const isSuccess = appState.liveResult.status === "success";
  const aiResult = rawPayload.result ?? rawPayload.response?.result;
  const facts = isSuccess
    ? [
        rawPayload.receipt
          ? `Settled ${formatMoney(rawPayload.receipt.amountMinor)}`
          : "No settlement returned",
        rawPayload.reservationId
          ? `Reservation ${truncateMiddle(rawPayload.reservationId)}`
          : "No reservation id",
        rawPayload.receipt?.receiptId
          ? `Receipt ${truncateMiddle(rawPayload.receipt.receiptId)}`
          : "No receipt id"
      ]
    : [
        `Reason: ${humanizeCode(rawPayload.code ?? rawPayload.details?.code ?? appState.liveResult.message)}`,
        `Route: ${appState.liveResult.request?.path ?? "unknown"}`,
        `Price: ${formatMoney(appState.liveResult.request?.amountMinor ?? 0)}`
      ];

  const aiBlock = isSuccess && aiResult?.answerPreview
    ? `<div class="ai-answer">
        <span class="ai-answer-badge">${aiResult.aiGenerated ? escapeHtml(aiResult.aiProvider ?? "AI") : "Simulated"}</span>
        <p>${escapeHtml(aiResult.answerPreview)}</p>
      </div>`
    : "";

  host.innerHTML = `
    <strong>${isSuccess ? "Approved and settled." : "Blocked before settlement."}</strong>
    <span>${escapeHtml(appState.liveResult.summary)}</span>
    ${aiBlock}
    <div class="live-result-facts">
      ${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}
    </div>
    <details class="result-raw">
      <summary>Raw request and response</summary>
      <pre>${rawJson}</pre>
    </details>
  `;
}

function traceTitle(event) {
  switch (event.type) {
    case "agent.reasoning":
      return "Agent decided to authorize spend";
    case "agent.request":
      return "Agent called paid API without payment proof";
    case "provider.quote":
      return "Provider returned signed 402 quote";
    case "vault.authorize.request":
      return "Vault checked policy and budget";
    case "vault.authorize.approved":
      return event.decision === "reused"
        ? "Vault reused existing reservation"
        : "Vault authorized new reservation";
    case "vault.authorize.blocked":
      return "Vault blocked before settlement";
    case "agent.retry_with_authorization":
      return "Agent retried with vault authorization token";
    case "network.timeout":
      return "First paid response timed out";
    case "provider.response":
      return "Provider returned paid API response";
    case "receipt.signed":
      return "Vault signed settlement receipt";
    default:
      return humanizeCode(event.type);
  }
}

function traceBody(event) {
  switch (event.type) {
    case "agent.reasoning":
      return event.thought || "Agent analyzed the task and chose to authorize payment for a research API call.";
    case "agent.request":
      return `${event.method} ${new URL(event.url).pathname} as ${event.agentId}`;
    case "provider.quote":
      return `${formatMoney(event.amountMinor)} to ${event.recipient}; provider signature present: ${event.signedByProvider ? "yes" : "no"}`;
    case "vault.authorize.request":
      return `Policy check for run ${event.runId} and idempotency key ${event.idempotencyKey}`;
    case "vault.authorize.approved":
      return `${formatMoney(event.reservedAmountMinor)} reserved; short-lived auth token issued`;
    case "vault.authorize.blocked":
      return humanizeCode(event.code);
    case "agent.retry_with_authorization":
      return `Attempt ${event.attempt} used token ${truncateMiddle(event.tokenId, 10, 6)}`;
    case "network.timeout":
      return `Attempt ${event.attempt} timed out; same quote and idempotency key are reused`;
    case "provider.response":
      return `HTTP ${event.status}; provider verified authorization before responding`;
    case "receipt.signed":
      return `${formatMoney(event.amountMinor)} receipt ${truncateMiddle(event.receiptId, 10, 6)}`;
    default:
      return event.code ? humanizeCode(event.code) : "Event recorded";
  }
}

function traceClass(event) {
  if (event.type === "agent.reasoning") {
    return "reasoning";
  }
  if (event.type === "vault.authorize.blocked") {
    return "blocked";
  }
  if (event.type === "network.timeout" || (event.type === "vault.authorize.approved" && event.decision === "reused")) {
    return "retry";
  }
  if (event.type === "vault.authorize.approved" || event.type === "receipt.signed") {
    return "approved";
  }
  return "";
}

function traceMeta(event) {
  const entries = [];
  if (event.type === "agent.reasoning" && event.provider) {
    entries.push(`provider: ${event.provider}`);
    if (event.model) entries.push(`model: ${truncateMiddle(event.model, 24, 0)}`);
    return entries;
  }
  for (const key of [
    "quoteFingerprint",
    "quoteId",
    "reservationId",
    "receiptId",
    "tokenId",
    "code"
  ]) {
    if (event[key]) {
      entries.push(`${key}: ${truncateMiddle(event[key], 14, 8)}`);
    }
  }
  return entries;
}

function renderExecutionTrace() {
  const host = document.querySelector("#execution-trace");
  if (appState.runningLiveRequest) {
    host.innerHTML = `
      <article class="trace-step retry">
        <span class="trace-index">...</span>
        <div>
          <strong>Waiting for live events</strong>
          <p>The trace will fill as the agent, provider, and vault exchange messages.</p>
        </div>
      </article>
    `;
    return;
  }

  const rawPayload = appState.liveResult?.payload ?? {};
  const trace = [...(rawPayload.trace ?? rawPayload.response?.trace ?? [])];
  const receipt = rawPayload.receipt ?? rawPayload.response?.receipt;
  if (receipt && !trace.some((event) => event.type === "receipt.signed")) {
    trace.push({
      type: "receipt.signed",
      at: receipt.settledAt,
      receiptId: receipt.receiptId,
      amountMinor: receipt.amountMinor
    });
  }

  if (trace.length === 0) {
    host.innerHTML = `
      <article class="trace-step">
        <span class="trace-index">0</span>
        <div>
          <strong>No request sent yet</strong>
          <p>Send a live request to see each actual network and vault decision.</p>
        </div>
      </article>
    `;
    return;
  }

  host.innerHTML = trace
    .map((event, index) => {
      const meta = traceMeta(event);
      return `
        <article class="trace-step ${traceClass(event)}">
          <span class="trace-index">${index + 1}</span>
          <div>
            <strong>${escapeHtml(traceTitle(event))}</strong>
            <p>${escapeHtml(traceBody(event))}</p>
            ${
              meta.length > 0
                ? `<div class="trace-meta">${meta.map((entry) => `<code>${escapeHtml(entry)}</code>`).join("")}</div>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");
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
          <strong>Send a live request to see the control path.</strong>
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

  let aiAnswerBlock = "";

  if (appState.lastResult.status === "success") {
    const aiResult = rawPayload.result;
    if (aiResult?.answerPreview && appState.lastResult.scenario !== "breaker") {
      const badge = aiResult.aiGenerated ? escapeHtml(aiResult.aiProvider ?? "AI") : "Simulated";
      aiAnswerBlock = `<div class="ai-answer" style="margin-top:12px">
        <span class="ai-answer-badge">${badge}</span>
        <p>${escapeHtml(aiResult.answerPreview)}</p>
      </div>`;
    }

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
      ${aiAnswerBlock}
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
  renderLiveRequestResult();
  renderExecutionTrace();
}

async function executeLiveAgentRequest() {
  const request = readLiveRequestForm();
  appState.runningLiveRequest = true;
  appState.liveResult = null;
  renderScenarioCards();
  renderLiveRequestResult();
  renderExecutionTrace();

  try {
    const payload = await requestJson("/api/agent-request", {
      method: "POST",
      body: JSON.stringify(request)
    });
    appState.liveResult = {
      status: "success",
      request,
      summary:
        request.timeoutFirst
          ? "The first response timed out; the retry reused the same reservation and settled once."
          : "The provider quote matched policy, so the vault authorized and settled it.",
      payload: {
        request,
        response: payload.result,
        ...payload.result
      }
    };
    appState.lastResult = {
      status: "success",
      scenario: "live_request",
      payload: payload.result
    };
  } catch (error) {
    appState.liveResult = {
      status: "blocked",
      request,
      message: error.message,
      summary: "The vault rejected this edited request before a payment could settle.",
      payload: {
        request,
        response: error.payload ?? { message: error.message },
        ...(error.payload ?? {})
      }
    };
    appState.lastResult = {
      status: "blocked",
      scenario: "live_request",
      message: error.message,
      payload: error.payload ?? { message: error.message }
    };
  } finally {
    appState.runningLiveRequest = false;
  }

  await refresh();
  renderScenarioCards();
  renderLiveRequestResult();
  renderExecutionTrace();
}

async function sendLiveAgentRequest(event) {
  event.preventDefault();
  await executeLiveAgentRequest();
}

function applyLivePreset(kind) {
  const route = document.querySelector("#request-route");
  const amount = document.querySelector("#request-amount");
  const recipient = document.querySelector("#request-recipient");
  const timeout = document.querySelector("#request-timeout");

  route.value = "/api/live-research";
  recipient.value = "merchant_demo_main";
  timeout.checked = false;

  if (kind === "price") {
    amount.value = "900";
  } else if (kind === "recipient") {
    amount.value = "125";
    recipient.value = "merchant_rogue_sink";
  } else if (kind === "timeout") {
    amount.value = "125";
    timeout.checked = true;
  } else {
    amount.value = "125";
  }

  populateLiveRequestIds();
}

async function resetConsole() {
  const payload = await requestJson("/api/seed", {
    method: "POST",
    body: JSON.stringify({})
  });
  appState.liveResult = null;
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

populateLiveRequestIds();
renderFlowSteps();
renderScenarioCards();
renderScenarioDetail();
renderScenarioResult();
renderLiveRequestResult();
renderExecutionTrace();

document.querySelector("#agent-request-form").addEventListener("submit", sendLiveAgentRequest);
document.querySelector("#randomize-request").addEventListener("click", () => {
  populateLiveRequestIds();
  appState.liveResult = null;
  renderLiveRequestResult();
  renderExecutionTrace();
});
document.querySelector("#preset-safe").addEventListener("click", () => {
  applyLivePreset("safe");
  void executeLiveAgentRequest();
});
document.querySelector("#preset-price").addEventListener("click", () => {
  applyLivePreset("price");
  void executeLiveAgentRequest();
});
document.querySelector("#preset-recipient").addEventListener("click", () => {
  applyLivePreset("recipient");
  void executeLiveAgentRequest();
});
document.querySelector("#preset-timeout").addEventListener("click", () => {
  applyLivePreset("timeout");
  void executeLiveAgentRequest();
});
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
