import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

test("vault persistence keeps receipts and signer identity across restart", async () => {
  const adminToken = "persist-admin-token";
  const agentToken = "persist-agent-token";
  const providerToken = "persist-provider-token";
  const silentLogger = {
    log() {}
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safepaykit-"));
  const storeFile = path.join(tempDir, "vault-store.json");

  let vault = null;
  let api = null;
  let restartedVault = null;

  try {
    vault = await startVaultServer({
      port: 0,
      storeFile,
      adminToken,
      agentToken,
      providerToken,
      logger: silentLogger
    });
    api = await startPaidApiServer({
      port: 0,
      vaultUrl: `http://127.0.0.1:${vault.port}`,
      providerToken,
      logger: silentLogger
    });

    const vaultUrl = `http://127.0.0.1:${vault.port}`;
    const apiUrl = `http://127.0.0.1:${api.port}`;

    await fetch(`${vaultUrl}/demo/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-safepay-admin-token": adminToken
      },
      body: JSON.stringify({
        policy: {
          allowedDomains: [new URL(apiUrl).host],
          allowedProviderKeys: [api.providerPublicKey]
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
    assert.equal(normal.ok, true);

    const beforeRestart = await fetch(`${vaultUrl}/state`, {
      headers: {
        "x-safepay-admin-token": adminToken
      }
    }).then((response) => response.json());
    assert.equal(beforeRestart.storage.mode, "file");
    assert.equal(beforeRestart.metrics.receiptCount, 1);

    const storedFile = await fs.readFile(storeFile, "utf8");
    assert.ok(storedFile.includes("vaultSignature"));

    await new Promise((resolve) => api.server.close(resolve));
    api = null;
    await new Promise((resolve) => vault.server.close(resolve));
    vault = null;

    restartedVault = await startVaultServer({
      port: 0,
      storeFile,
      adminToken,
      agentToken,
      providerToken,
      logger: silentLogger
    });

    const restartedState = await fetch(
      `http://127.0.0.1:${restartedVault.port}/state`,
      {
        headers: {
          "x-safepay-admin-token": adminToken
        }
      }
    ).then((response) => response.json());

    assert.equal(restartedState.metrics.receiptCount, 1);
    assert.equal(restartedState.metrics.totalSettledMinor, 125);
    assert.equal(restartedState.receipts[0].receiptId, beforeRestart.receipts[0].receiptId);
    assert.equal(restartedState.publicKey, beforeRestart.publicKey);
    assert.equal(restartedState.storage.mode, "file");
  } finally {
    if (api) {
      await new Promise((resolve) => api.server.close(resolve));
    }
    if (vault) {
      await new Promise((resolve) => vault.server.close(resolve));
    }
    if (restartedVault) {
      await new Promise((resolve) => restartedVault.server.close(resolve));
    }

    await fs.rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});
