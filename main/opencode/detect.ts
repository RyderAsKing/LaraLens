/**
 * Detects whether the `opencode` CLI is available on PATH (or at a custom path).
 *
 * Spawn `opencode --version`:
 *  - spawn 'error' event (ENOENT) => binary not found
 *  - spawn 'exit' event           => binary exists (regardless of exit code)
 *
 * The result is cached for the process lifetime so we don't re-run detection on
 * every scan. Call {@link clearDetectCache} to force a re-check.
 */

import { spawn } from "node:child_process";

interface DetectResult {
  installed: boolean;
  path?: string;
  version?: string;
}

let cache: DetectResult | null = null;

export async function isOpencodeInstalled(
  binaryPath?: string
): Promise<DetectResult> {
  if (cache) return cache;

  const cmd = binaryPath ?? "opencode";

  return new Promise<DetectResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    // `shell: true` is required on Windows so cmd.exe resolves npm-installed
    // `.cmd` shims (e.g. opencode.cmd) via PATHEXT. Without it, spawn throws
    // ENOENT even though the binary is on PATH. On Linux/macOS, npm global
    // bins are real executables/symlinks — no shell needed, and avoiding it
    // keeps proc.pid pointing at the actual process. Args are hardcoded.
    const proc = spawn(cmd, ["--version"], {
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", () => {
      if (settled) return;
      settled = true;
      cache = { installed: false };
      resolve(cache);
    });

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      // The binary exists if we got here at all (ENOENT would have fired 'error').
      const raw = (stdout.trim() || stderr.trim()).split("\n")[0] || undefined;
      cache = { installed: true, path: binaryPath, version: raw };
      resolve(cache);
    });
  });
}

export function clearDetectCache(): void {
  cache = null;
}
