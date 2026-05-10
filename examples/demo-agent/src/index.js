import { createSafePayClient } from "../../../packages/x402-client/src/index.js";

const SCENARIO_MAP = {
  normal: {
    path: "/api/research",
    body: {
      task: "Summarize three sources about stablecoin payment infrastructure."
    },
    requestTimeoutMs: 900
  },
  timeout: {
    path: "/api/research-timeout",
    body: {
      task: "Retry-safe search with the same idempotency key."
    },
    requestTimeoutMs: 700
  },
  price: {
    path: "/api/research-premium",
    body: {
      task: "Attempt a price-drifted premium request."
    },
    requestTimeoutMs: 900
  },
  recipient: {
    path: "/api/research-recipient-drift",
    body: {
      task: "Attempt a rogue recipient request."
    },
    requestTimeoutMs: 900
  },
  route: {
    path: "/api/exfiltrate",
    body: {
      task: "Attempt a non-allowlisted route."
    },
    requestTimeoutMs: 900
  },
  breaker: {
    type: "breaker"
  }
};

async function runPaidRequest({
  client,
  apiUrl,
  path,
  body,
  idempotencyKey = null
}) {
  const headers = {
    "content-type": "application/json"
  };
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey;
  }

  const response = await client.fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.code ?? "scenario_failed");
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function runAgentRequest({
  apiUrl = "http://127.0.0.1:4200",
  vaultUrl = "http://127.0.0.1:4100",
  path = "/api/live-research",
  task = "Live agent research request.",
  amountMinor = 125,
  recipient = "merchant_demo_main",
  timeoutFirst = false,
  runId = "run_live",
  agentId = "agent_demo",
  idempotencyKey = null,
  agentToken = null,
  requestTimeoutMs = 900
} = {}) {
  const trace = [];
  const client = createSafePayClient({
    vaultUrl,
    runId,
    agentId,
    agentToken,
    requestTimeoutMs,
    onEvent(event) {
      trace.push(event);
    }
  });

  try {
    const result = await runPaidRequest({
      client,
      apiUrl,
      path,
      idempotencyKey,
      body: {
        task,
        amountMinor,
        recipient,
        timeoutFirst
      }
    });
    return {
      ...result,
      trace
    };
  } catch (error) {
    if (!error.payload && error.details) {
      error.payload = error.details;
    }
    error.trace = trace;
    throw error;
  }
}

async function runBreakerScenario({
  apiUrl,
  vaultUrl,
  runId,
  agentId,
  agentToken,
  adminToken
}) {
  const client = createSafePayClient({
    vaultUrl,
    runId,
    agentId,
    agentToken,
    requestTimeoutMs: 900
  });

  const attempts = [];
  for (let index = 0; index < 3; index += 1) {
    try {
      await runPaidRequest({
        client,
        apiUrl,
        path: "/api/exfiltrate",
        body: {
          task: `Trip the breaker attempt ${index + 1}.`
        }
      });

      attempts.push({
        attempt: index + 1,
        ok: true
      });
    } catch (error) {
      attempts.push({
        attempt: index + 1,
        ok: false,
        code: error.payload?.code ?? error.details?.code ?? error.message
      });
    }
  }

  const state = await fetch(`${vaultUrl}/state`, {
    headers: adminToken ? { "x-safepay-admin-token": adminToken } : {}
  }).then((response) => response.json());
  return {
    ok: true,
    scenario: "breaker_trip",
    attempts,
    breaker: state.breaker,
    result: {
      summary: "Repeated blocked attempts escalated into a breaker trip.",
      citationCount: 0,
      confidence: state.breaker.tripped ? "high" : "low",
      answerPreview:
        "SafePayKit moved from single-attempt policy blocks to a circuit-breaker response."
    }
  };
}

export async function runScenario({
  scenario = "normal",
  apiUrl = "http://127.0.0.1:4200",
  vaultUrl = "http://127.0.0.1:4100",
  runId = "run_demo_main",
  agentId = "agent_demo",
  agentToken = null,
  adminToken = null
} = {}) {
  const config = SCENARIO_MAP[scenario];
  if (!config) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }

  if (config.type === "breaker") {
    return runBreakerScenario({
      apiUrl,
      vaultUrl,
      runId,
      agentId,
      agentToken,
      adminToken
    });
  }

  const client = createSafePayClient({
    vaultUrl,
    runId,
    agentId,
    agentToken,
    requestTimeoutMs: config.requestTimeoutMs
  });

  try {
    return await runPaidRequest({
      client,
      apiUrl,
      path: config.path,
      body: config.body
    });
  } catch (error) {
    if (!error.payload && error.details) {
      error.payload = error.details;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scenario = process.argv[2] ?? "normal";
  const vaultUrl = process.env.SAFEPAY_VAULT_URL ?? "http://127.0.0.1:4100";
  const apiUrl = process.env.SAFEPAY_API_URL ?? "http://127.0.0.1:4200";
  const adminToken = process.env.SAFEPAY_ADMIN_TOKEN ?? null;
  const agentToken = process.env.SAFEPAY_AGENT_TOKEN ?? null;
  const provider = await fetch(`${apiUrl}/provider-metadata`).then((response) => response.json());

  const bootstrap = await fetch(`${vaultUrl}/demo/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminToken ? { "x-safepay-admin-token": adminToken } : {})
    },
    body: JSON.stringify({
      policy: {
        allowedProviderKeys: [provider.providerPublicKey]
      }
    })
  });

  if (!bootstrap.ok) {
    throw new Error("Failed to bootstrap demo policy");
  }

  try {
    const result = await runScenario({
      scenario,
      apiUrl,
      vaultUrl,
      agentToken,
      adminToken
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.payload ?? error);
    process.exitCode = 1;
  }
}
