/**
 * Child-process manager for `opencode serve`.
 *
 * Spawns the server with `cwd = projectRoot` (Mode B — LaraLens launches it so
 * the agent's working directory matches the scanned Laravel project). Waits for
 * the "opencode server listening" stdout line, then returns a handle the façade
 * can attach long-lived crash listeners to.
 *
 * Kill logic mirrors the SDK's own `packages/sdk/js/src/process.ts`:
 *  - Windows: `taskkill /PID <pid> /T /F` (kills the whole tree)
 *  - Other:   `proc.kill()` (SIGTERM)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";

export interface ServerHandle {
  url: string;
  port: number;
  pid: number;
  process: ChildProcess;
  /** Synchronously kill the server process. */
  close(): void;
}

const READY_TIMEOUT_MS = 15_000;

/**
 * Find a free TCP port starting from `basePort`, incrementing on conflict.
 * Caps at basePort + 100 to avoid infinite loops.
 */
export async function findFreePort(basePort: number): Promise<number> {
  for (let port = basePort; port < basePort + 100; port++) {
    const free = await isPortFree(port);
    if (free) return port;
  }
  return basePort; // fallback — let opencode fail if it's taken
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Spawn `opencode serve` with the given project root as cwd.
 * Resolves once the server prints its "listening" line, or rejects on
 * timeout / early exit / spawn error.
 */
export function spawnServer(
  projectRoot: string,
  port: number,
  binaryPath?: string
): Promise<ServerHandle> {
  const cmd = binaryPath ?? "opencode";
  const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];

  // `shell: true` is required on Windows so cmd.exe resolves npm-installed
  // `.cmd` shims (e.g. opencode.cmd) via PATHEXT. Without it, spawn throws
  // ENOENT even though the binary is on PATH. On Linux/macOS, npm global
  // bins are real executables/symlinks — no shell needed, and avoiding it
  // keeps proc.pid pointing at the actual opencode process (not a /bin/sh
  // wrapper) so proc.kill() works cleanly. Args are hardcoded by us.
  const proc = spawn(cmd, args, {
    cwd: projectRoot,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      detach();
      stopProcess(proc);
      reject(
        new Error(
          `opencode server did not become ready within ${READY_TIMEOUT_MS / 1000}s`
        )
      );
    }, READY_TIMEOUT_MS);

    const onStdout = (chunk: Buffer) => {
      if (resolved) return;
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.includes("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            resolved = true;
            clearTimeout(timeout);
            detach();
            const url = match[1];
            const portMatch = url.match(/:(\d+)$/);
            const resolvedPort = portMatch
              ? parseInt(portMatch[1], 10)
              : port;
            resolve({
              url,
              port: resolvedPort,
              pid: proc.pid!,
              process: proc,
              close: () => stopProcess(proc),
            });
            return;
          }
        }
      }
    };

    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const onError = (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      detach();
      reject(new Error(`Failed to spawn opencode: ${err.message}`));
    };

    const onExit = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      detach();
      const msg = `opencode server exited with code ${code}`;
      reject(
        new Error(output.trim() ? `${msg}\n${output.trim()}` : msg)
      );
    };

    function detach() {
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
    }

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

/**
 * Cross-platform process kill. Mirrors the SDK's `stop()` from process.ts.
 * Synchronous — safe to call in `before-quit`.
 */
export function stopProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (!out.error && out.status === 0) return;
  }
  proc.kill();
}
