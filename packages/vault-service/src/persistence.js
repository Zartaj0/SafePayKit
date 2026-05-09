import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonSafely } from "../../policy-schema/src/index.js";

function normalizePersistedRuntime(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    version: Number(value.version ?? 1),
    savedAt: value.savedAt ?? null,
    policy: value.policy ?? null,
    runs: value.runs ?? {},
    state: value.state ?? null,
    authTokens: value.authTokens ?? {},
    keys: value.keys ?? null
  };
}

export function createFilePersistence(filePath) {
  const resolvedPath = path.resolve(filePath);
  const meta = {
    mode: "file",
    filePath: resolvedPath,
    lastSavedAt: null
  };

  return {
    filePath: resolvedPath,
    getMeta() {
      return { ...meta };
    },
    async load() {
      try {
        const raw = await fs.readFile(resolvedPath, "utf8");
        const parsed = normalizePersistedRuntime(parseJsonSafely(raw, null));
        if (!parsed) {
          return null;
        }

        meta.lastSavedAt = parsed.savedAt ?? null;
        return parsed;
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async save(snapshot) {
      const payload = {
        version: 1,
        ...snapshot
      };

      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      const tempPath = `${resolvedPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
      await fs.rename(tempPath, resolvedPath);
      meta.lastSavedAt = payload.savedAt ?? null;
    }
  };
}
