import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const adminToken = "verify-admin-token";
const agentToken = "verify-agent-token";
const providerToken = "verify-provider-token";

const logger = {
  log(message) {
    console.log(message);
  }
};

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
  const provider = await fetch(`${apiUrl}/provider-metadata`).then((response) => response.json());

  await fetch(`${vaultUrl}/demo/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-safepay-admin-token": adminToken
    },
    body: JSON.stringify({
      policy: {
        allowedDomains: [new URL(apiUrl).host],
        allowedProviderKeys: [provider.providerPublicKey]
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
  const timeout = await runScenario({
    scenario: "timeout",
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });

  let priceError = null;
  try {
    await runScenario({ scenario: "price", vaultUrl, apiUrl, agentToken, adminToken });
  } catch (error) {
    priceError = error.payload ?? { message: error.message };
  }

  const state = await fetch(`${vaultUrl}/state`, {
    headers: {
      "x-safepay-admin-token": adminToken
    }
  }).then((response) => response.json());
  console.log(
    JSON.stringify(
      {
        normal: normal.scenario,
        timeout: timeout.scenario,
        blocked: priceError?.code ?? "missing",
        metrics: state.metrics,
        breaker: state.breaker
      },
      null,
      2
    )
  );
} finally {
  await new Promise((resolve) => vault.server.close(resolve));
  await new Promise((resolve) => api.server.close(resolve));
}
