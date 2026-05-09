import { runScenario } from "../examples/demo-agent/src/index.js";

const scenario = process.argv[2] ?? "normal";
const vaultUrl = process.env.SAFEPAY_VAULT_URL ?? "http://127.0.0.1:4100";
const apiUrl = process.env.SAFEPAY_API_URL ?? "http://127.0.0.1:4200";
const adminToken = process.env.SAFEPAY_ADMIN_TOKEN ?? null;
const agentToken = process.env.SAFEPAY_AGENT_TOKEN ?? null;
const provider = await fetch(`${apiUrl}/provider-metadata`).then((response) => response.json());

await fetch(`${vaultUrl}/demo/bootstrap`, {
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

try {
  const payload = await runScenario({
    scenario,
    vaultUrl,
    apiUrl,
    agentToken,
    adminToken
  });
  console.log(JSON.stringify(payload, null, 2));
} catch (error) {
  console.error(JSON.stringify(error.payload ?? { message: error.message }, null, 2));
  process.exitCode = 1;
}
