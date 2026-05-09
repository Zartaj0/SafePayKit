import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboardServer } from "../apps/dashboard/server.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const adminToken = process.env.SAFEPAY_ADMIN_TOKEN ?? "hosted-demo-admin-token";
const agentToken = process.env.SAFEPAY_AGENT_TOKEN ?? "hosted-demo-agent-token";
const providerToken = process.env.SAFEPAY_PROVIDER_TOKEN ?? "hosted-demo-provider-token";
const vaultPort = Number(process.env.SAFEPAY_VAULT_PORT ?? 4100);
const apiPort = Number(process.env.SAFEPAY_API_PORT ?? 4200);
const dashboardPort = Number(process.env.PORT ?? process.env.SAFEPAY_DASHBOARD_PORT ?? 4300);
const dashboardHost = process.env.SAFEPAY_DASHBOARD_HOST ?? "0.0.0.0";
const storeFile =
  process.env.SAFEPAY_STORE_FILE ?? path.join(rootDir, "tmp", "safepaykit-hosted-demo.json");

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
  host: dashboardHost,
  vaultUrl: `http://127.0.0.1:${vault.port}`,
  apiUrl: `http://127.0.0.1:${api.port}`,
  adminToken,
  agentToken
});

function shutdown(exitCode = 0) {
  dashboard.server.close(() => {});
  api.server.close(() => {});
  vault.server.close(() => {});
  setTimeout(() => process.exit(exitCode), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(
  `[hosted-demo] dashboard exposed on http://${dashboardHost}:${dashboard.port}; vault and API remain internal`
);
