/**
 * Thin wrapper over the @opencode-ai/sdk client.
 *
 * The SDK doesn't wrap the server's `/global/health` endpoint, so we probe
 * health via `config.get()` — a cheap GET that succeeds iff the server is up.
 * This keeps us SDK-only (no raw fetch) per the integration constraint.
 *
 * If `OPENCODE_SERVER_PASSWORD` is set in the environment, the server requires
 * HTTP basic auth (username `opencode`). We read the password and inject the
 * `Authorization` header into every SDK request via the client's `headers`
 * config.
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

/** Basic-auth header value for the opencode server, or undefined if no auth. */
function authHeader(password?: string): string | undefined {
  if (!password) return undefined;
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return `Basic ${token}`;
}

export function createClient(
  baseUrl: string,
  password?: string
): OpencodeClient {
  const headers: Record<string, string> = {};
  const auth = authHeader(password);
  if (auth) headers["Authorization"] = auth;

  return createOpencodeClient({
    baseUrl,
    throwOnError: false,
    headers,
  });
}

/**
 * Returns true if the server responds to a simple SDK call.
 * Uses `config.get()` as the probe since `global.health()` isn't in the SDK.
 */
export async function probeHealth(client: OpencodeClient): Promise<boolean> {
  try {
    const result = await client.config.get();
    return !result.error;
  } catch {
    return false;
  }
}

/** Read the server password from the environment, if set. */
export function getServerPassword(): string | undefined {
  return process.env.OPENCODE_SERVER_PASSWORD;
}
