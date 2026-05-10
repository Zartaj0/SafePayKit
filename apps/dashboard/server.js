import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "../../examples/demo-agent/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  return { response, payload };
}

function withToken(headers, name, value) {
  return value
    ? {
        ...headers,
        [name]: value
      }
    : headers;
}

export function startDashboardServer({
  port = 4300,
  host = "127.0.0.1",
  vaultUrl = "http://127.0.0.1:4100",
  apiUrl = "http://127.0.0.1:4200",
  adminToken = null,
  agentToken = null,
  logger = console
} = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "dashboard" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const { response: upstream, payload } = await proxyJson(`${vaultUrl}/state`, {
        headers: withToken({}, "x-safepay-admin-token", adminToken)
      });
      sendJson(response, upstream.status, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/seed") {
      const provider = await fetch(`${apiUrl}/provider-metadata`).then((providerResponse) =>
        providerResponse.json()
      );
      const { response: upstream, payload } = await proxyJson(`${vaultUrl}/demo/bootstrap`, {
        method: "POST",
        headers: withToken(
          {
            "content-type": "application/json"
          },
          "x-safepay-admin-token",
          adminToken
        ),
        body: JSON.stringify({
          policy: {
            allowedDomains: [new URL(apiUrl).host],
            allowedProviderKeys: [provider.providerPublicKey]
          }
        })
      });
      sendJson(response, upstream.status, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/breaker/reset") {
      const { response: upstream, payload } = await proxyJson(`${vaultUrl}/breaker/reset`, {
        method: "POST",
        headers: withToken(
          {
            "content-type": "application/json"
          },
          "x-safepay-admin-token",
          adminToken
        ),
        body: JSON.stringify({})
      });
      sendJson(response, upstream.status, payload);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/scenarios/")) {
      const scenario = url.pathname.split("/").pop();
      try {
        const result = await runScenario({
          scenario,
          apiUrl,
          vaultUrl,
          agentToken,
          adminToken
        });
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 409, {
          ok: false,
          code: error.payload?.code ?? error.message,
          message: error.message,
          details: error.payload ?? null
        });
      }
      return;
    }

    const filePath =
      url.pathname === "/"
        ? path.join(publicDir, "index.html")
        : path.join(publicDir, url.pathname.replace(/^\/+/, ""));

    try {
      const contents = await fs.readFile(filePath);
      response.writeHead(200, {
        "content-type": contentTypeFor(filePath)
      });
      response.end(contents);
    } catch {
      sendJson(response, 404, { ok: false, code: "not_found" });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      logger.log(`[dashboard] listening on http://${host}:${address.port}`);
      resolve({
        server,
        port: address.port
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboardServer({
    port: Number(process.env.SAFEPAY_DASHBOARD_PORT ?? 4300),
    host: process.env.SAFEPAY_DASHBOARD_HOST ?? "127.0.0.1",
    vaultUrl: process.env.SAFEPAY_VAULT_URL ?? "http://127.0.0.1:4100",
    apiUrl: process.env.SAFEPAY_API_URL ?? "http://127.0.0.1:4200",
    adminToken: process.env.SAFEPAY_ADMIN_TOKEN ?? null,
    agentToken: process.env.SAFEPAY_AGENT_TOKEN ?? null
  });
}
