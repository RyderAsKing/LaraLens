/**
 * EnvAnalyzer — reads the Laravel .env file and returns a masked key=>value map.
 * Secret values are masked to avoid leaking credentials into the UI.
 */
import fs from "node:fs/promises";
import path from "node:path";

const SECRET_HINTS = [
  "PASSWORD", "SECRET", "TOKEN", "KEY", "PASS", "CREDENTIAL", "PRIVATE",
  "API_KEY", "ACCESS", "CLIENT_SECRET",
];

export async function analyzeEnv(projectRoot: string): Promise<Record<string, string>> {
  const envPath = path.join(projectRoot, ".env");
  const source = await fs.readFile(envPath, "utf8").catch(() => "");
  if (!source) return {};

  const result: Record<string, string> = {};
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = isSecretKey(key) ? maskValue(value) : value;
  }
  return result;
}

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_HINTS.some((h) => upper.includes(h));
}

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "••••" + value.slice(-2);
}
