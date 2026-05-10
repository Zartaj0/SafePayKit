import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboardServer } from "../apps/dashboard/server.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adminToken = "demo-admin-token";
const agentToken = "demo-agent-token";
const providerToken = "demo-provider-token";
const vaultPort = Number(process.env.SAFEPAY_VAULT_PORT ?? 0);
const apiPort = Number(process.env.SAFEPAY_API_PORT ?? 0);
const dashboardPort = Number(process.env.SAFEPAY_DASHBOARD_PORT ?? 0);
const storeFile =
  process.env.SAFEPAY_STORE_FILE ??
  path.join(rootDir, "tmp", `safepaykit-demo-${Date.now()}.json`);

function print(message = "") {
  process.stdout.write(`${message}\n`);
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.code ?? data.message ?? `request_failed_${response.status}`);
  }

  return data;
}

const vault = await startVaultServer({
  port: vaultPort,
  storeFile,
  adminToken,
  agentToken,
  providerToken
});
const api = await startPaidApiServer({
  port: apiPort,
  vaultUrl: `http://127.0.0.1:${vault.port}`,
  providerToken
});
const dashboard = await startDashboardServer({
  port: dashboardPort,
  vaultUrl: `http://127.0.0.1:${vault.port}`,
  apiUrl: `http://127.0.0.1:${api.port}`,
  adminToken,
  agentToken
});

const vaultUrl = `http://127.0.0.1:${vault.port}`;
const apiUrl = `http://127.0.0.1:${api.port}`;
const dashboardUrl = `http://127.0.0.1:${dashboard.port}`;

try {
  const provider = await fetch(`${apiUrl}/provider-metadata`).then((response) =>
    response.json()
  );

  await postJson(
    `${vaultUrl}/demo/bootstrap`,
    {
      policy: {
        allowedDomains: [new URL(apiUrl).host],
        allowedProviderKeys: [provider.providerPublicKey]
      }
    },
    {
      "x-safepay-admin-token": adminToken
    }
  );

  print("");
  print("SafePayKit local console is ready.");
  print("");
  print(`Dashboard: ${dashboardUrl}`);
  print(`Fresh state file: ${storeFile}`);
  print("");
  print("Product flow:");
  print("1. Open the dashboard.");
  print("2. Edit the Live Agent Request fields and click Send Agent Request.");
  print("3. Change price to 900 or recipient to merchant_rogue_sink to prove live blocking.");
  print("4. Click Start Agent Run for the full retry/block/breaker sweep.");
  print("5. Run npm run demo:devnet in a second terminal to show the Solana explorer link.");
  print("");
  print("Optional terminal proof after the dashboard:");
  print("npm run demo:proof");
  print("");
  print("Press Ctrl+C to stop the local console.");
} catch (error) {
  print(`Console setup failed: ${error.message}`);
  process.exitCode = 1;
}

function shutdown() {
  dashboard.server.close(() => {});
  api.server.close(() => {});
  vault.server.close(() => {});
  print("\nSafePayKit local console stopped.");
  setTimeout(() => process.exit(0), 150);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
