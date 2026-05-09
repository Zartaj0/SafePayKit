import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demoAdminToken = "demo-admin-token";
const demoAgentToken = "demo-agent-token";
const demoProviderToken = "demo-provider-token";

const services = [
  {
    name: "vault",
    script: "packages/vault-service/src/index.js",
    env: {
      SAFEPAY_VAULT_PORT: "4100",
      SAFEPAY_STORE_FILE: path.join(rootDir, "tmp", "safepaykit-demo.json"),
      SAFEPAY_ADMIN_TOKEN: demoAdminToken,
      SAFEPAY_AGENT_TOKEN: demoAgentToken,
      SAFEPAY_PROVIDER_TOKEN: demoProviderToken
    }
  },
  {
    name: "api",
    script: "examples/paid-api-server/src/server.js",
    env: {
      SAFEPAY_API_PORT: "4200",
      SAFEPAY_VAULT_URL: "http://127.0.0.1:4100",
      SAFEPAY_PROVIDER_TOKEN: demoProviderToken
    }
  },
  {
    name: "dashboard",
    script: "apps/dashboard/server.js",
    env: {
      SAFEPAY_DASHBOARD_PORT: "4300",
      SAFEPAY_VAULT_URL: "http://127.0.0.1:4100",
      SAFEPAY_API_URL: "http://127.0.0.1:4200",
      SAFEPAY_ADMIN_TOKEN: demoAdminToken,
      SAFEPAY_AGENT_TOKEN: demoAgentToken
    }
  }
];

const children = services.map((service) => {
  const child = spawn("node", [service.script], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...service.env
    },
    stdio: ["inherit", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${service.name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${service.name}] ${chunk}`);
  });

  return child;
});

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      shutdown(code);
    }
  });
}

console.log("SafePayKit dev stack starting on http://127.0.0.1:4300");
