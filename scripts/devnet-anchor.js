import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runScenario } from "../examples/demo-agent/src/index.js";
import { startPaidApiServer } from "../examples/paid-api-server/src/server.js";
import {
  createSolanaMemoAnchor,
  verifyReceiptEvidence
} from "../packages/policy-schema/src/index.js";
import { startVaultServer } from "../packages/vault-service/src/index.js";

const execFileAsync = promisify(execFile);
const DEVNET_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const TRANSFER_AMOUNT_SOL = process.env.SAFEPAY_ANCHOR_TRANSFER_SOL ?? "0.000001";

const adminToken = "devnet-admin-token";
const agentToken = "devnet-agent-token";
const providerToken = "devnet-provider-token";
const silentLogger = { log() {} };

function print(message = "") {
  process.stdout.write(`${message}\n`);
}

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readDevnetPrivateKey() {
  if (process.env.DEVNET_PRIVATE_KEY) {
    return process.env.DEVNET_PRIVATE_KEY;
  }

  try {
    const env = parseEnvFile(await fs.readFile(".env", "utf8"));
    return env.DEVNET_PRIVATE_KEY ?? null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const indexes = new Map([...alphabet].map((char, index) => [char, index]));
  const bytes = [0];

  for (const char of value) {
    const index = indexes.get(char);
    if (index === undefined) {
      throw new Error("invalid_base58_private_key");
    }

    let carry = index;
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
      carry += bytes[byteIndex] * 58;
      bytes[byteIndex] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== "1") {
      break;
    }
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

function parsePrivateKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("DEVNET_PRIVATE_KEY is empty");
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const parsed = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 32 ||
      parsed.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)
    ) {
      throw new Error("DEVNET_PRIVATE_KEY JSON must be a byte array");
    }
    return parsed;
  }

  if (trimmed.includes(",")) {
    const parsed = trimmed.split(",").map((entry) => Number(entry.trim()));
    if (
      parsed.length < 32 ||
      parsed.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)
    ) {
      throw new Error("DEVNET_PRIVATE_KEY comma list must contain byte values");
    }
    return parsed;
  }

  return [...decodeBase58(trimmed)];
}

async function createTempKeypairFile() {
  const privateKey = await readDevnetPrivateKey();
  if (!privateKey) {
    throw new Error("DEVNET_PRIVATE_KEY is missing. Add it to .env or export it.");
  }

  const keypairBytes = parsePrivateKey(privateKey);
  const filePath = path.join(
    os.tmpdir(),
    `safepaykit-devnet-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  await fs.writeFile(filePath, JSON.stringify(keypairBytes));
  await fs.chmod(filePath, 0o600);
  return filePath;
}

async function solana(args) {
  const { stdout, stderr } = await execFileAsync("solana", args, {
    maxBuffer: 1024 * 1024
  });
  return `${stdout}${stderr}`.trim();
}

async function solanaKeygen(args) {
  const { stdout, stderr } = await execFileAsync("solana-keygen", args, {
    maxBuffer: 1024 * 1024
  });
  return `${stdout}${stderr}`.trim();
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

async function buildVerifiedReceiptEvidence() {
  const vault = await startVaultServer({
    port: 0,
    adminToken,
    agentToken,
    providerToken,
    logger: silentLogger
  });
  const api = await startPaidApiServer({
    port: 0,
    vaultUrl: `http://127.0.0.1:${vault.port}`,
    providerToken,
    logger: silentLogger
  });

  const vaultUrl = `http://127.0.0.1:${vault.port}`;
  const apiUrl = `http://127.0.0.1:${api.port}`;

  try {
    await postJson(
      `${vaultUrl}/demo/bootstrap`,
      {
        policy: {
          allowedDomains: [new URL(apiUrl).host],
          allowedProviderKeys: [api.providerPublicKey]
        }
      },
      {
        "x-safepay-admin-token": adminToken
      }
    );

    const paid = await runScenario({
      scenario: "normal",
      vaultUrl,
      apiUrl,
      agentToken,
      adminToken
    });
    const state = await fetch(`${vaultUrl}/state`, {
      headers: {
        "x-safepay-admin-token": adminToken
      }
    }).then((response) => response.json());
    const receipt = state.receipts.find((entry) => entry.receiptId === paid.receipt.receiptId);
    const reservation = state.reservations.find(
      (entry) => entry.reservationId === receipt.reservationId
    );
    const anchor = createSolanaMemoAnchor({ receipt, reservation });
    const evidence = verifyReceiptEvidence({
      policy: state.policy,
      reservation,
      receipt,
      anchor
    });

    if (!evidence.ok) {
      throw new Error("local receipt evidence did not verify");
    }

    return { receipt, reservation, anchor };
  } finally {
    await new Promise((resolve) => vault.server.close(resolve));
    await new Promise((resolve) => api.server.close(resolve));
  }
}

async function main() {
  print("SafePayKit devnet anchor");
  print("Creates a verified local receipt, then anchors its hash in a real devnet Memo transaction.");
  print("");

  const keypairFile = await createTempKeypairFile();
  try {
    const publicKey = await solanaKeygen(["pubkey", keypairFile]);
    print(`Devnet signer: ${publicKey}`);

    if (process.env.SAFEPAY_SKIP_AIRDROP !== "1") {
      try {
        await solana(["airdrop", "1", publicKey, "--url", DEVNET_URL]);
        print("PASS devnet account funded or already fundable");
      } catch {
        print("WARN devnet airdrop failed; continuing with existing balance");
      }
    }

    const { receipt, reservation, anchor } = await buildVerifiedReceiptEvidence();
    print(`PASS verified receipt ${receipt.receiptId}`);
    print(`PASS reservation ${reservation.reservationId}`);
    print(`PASS anchor memo ${anchor.memo}`);

    const raw = await solana([
      "transfer",
      publicKey,
      TRANSFER_AMOUNT_SOL,
      "--keypair",
      keypairFile,
      "--from",
      keypairFile,
      "--fee-payer",
      keypairFile,
      "--allow-unfunded-recipient",
      "--with-memo",
      anchor.memo,
      "--url",
      DEVNET_URL,
      "--output",
      "json"
    ]);
    const parsed = JSON.parse(raw);
    const signature = parsed.signature;

    print(`PASS devnet memo transaction ${signature}`);
    print(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    print("");
    print("Devnet anchor complete.");
  } finally {
    await fs.rm(keypairFile, { force: true });
  }
}

main().catch((error) => {
  print(`FAIL ${error.message}`);
  process.exitCode = 1;
});
