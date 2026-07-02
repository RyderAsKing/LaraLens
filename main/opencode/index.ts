/**
 * Opencode subsystem façade — the single entry point the rest of the main
 * process uses. Manages detection, spawn/stop lifecycle, status broadcasting,
 * and the SDK client instance.
 *
 * State machine:
 *   unknown → not_installed | stopped
 *   stopped → starting → connected | error
 *   connected → error (crash) | stopped (explicit stop)
 *   error → starting (retry) | stopped
 */

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeStatus } from "./types";
import { isOpencodeInstalled, clearDetectCache } from "./detect";
import {
  spawnServer,
  findFreePort,
  stopProcess,
  type ServerHandle,
} from "./server";
import { createClient, probeHealth, getServerPassword } from "./client";

const BASE_PORT = 14096;

type Listener = (status: OpencodeStatus) => void;

const listeners = new Set<Listener>();
let currentStatus: OpencodeStatus = { state: "unknown", installed: false };
let serverHandle: ServerHandle | null = null;
let client: OpencodeClient | null = null;
let detectPromise: Promise<void> | null = null;
let startingPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Status broadcasting
// ---------------------------------------------------------------------------

function setStatus(next: OpencodeStatus): void {
  currentStatus = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // listener errors shouldn't break broadcasting
    }
  }
}

/** Subscribe to status changes. Immediately fires with the current status. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentStatus);
  return () => {
    listeners.delete(listener);
  };
}

export function getStatus(): OpencodeStatus {
  return currentStatus;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detect whether opencode is installed. Cached for the process lifetime. */
export async function detect(): Promise<void> {
  if (detectPromise) return detectPromise;
  detectPromise = (async () => {
    const result = await isOpencodeInstalled();
    if (!result.installed) {
      setStatus({ state: "not_installed", installed: false });
    } else {
      setStatus({
        state: "stopped",
        installed: true,
        version: result.version,
      });
    }
  })();
  return detectPromise;
}

/** Force re-detection (clears the cache). */
export async function redetect(): Promise<void> {
  clearDetectCache();
  detectPromise = null;
  await detect();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start an opencode server for the given project root (Mode B).
 * If a server is already running for the same root + connected, this is a no-op.
 * If running for a different root, the old server is stopped first.
 */
export async function startForProject(projectRoot: string): Promise<void> {
  // Already running for the same project — no-op (handles rescan).
  if (
    serverHandle &&
    currentStatus.projectRoot === projectRoot &&
    currentStatus.state === "connected"
  ) {
    return;
  }

  // Already starting for the same project — wait for it.
  if (
    startingPromise &&
    currentStatus.projectRoot === projectRoot &&
    currentStatus.state === "starting"
  ) {
    return startingPromise;
  }

  // Running for a different project — stop first.
  if (serverHandle) {
    await stop();
  }

  // Make sure detection has run.
  if (!currentStatus.installed && currentStatus.state === "unknown") {
    await detect();
  }
  if (!currentStatus.installed) {
    // detect() already set status to not_installed.
    return;
  }

  startingPromise = doStart(projectRoot);
  try {
    await startingPromise;
  } finally {
    startingPromise = null;
  }
}

async function doStart(projectRoot: string): Promise<void> {
  setStatus({
    ...currentStatus,
    state: "starting",
    projectRoot,
    error: undefined,
    port: undefined,
    pid: undefined,
    baseUrl: undefined,
  });

  try {
    const port = await findFreePort(BASE_PORT);
    const handle = await spawnServer(projectRoot, port);
    serverHandle = handle;
    client = createClient(handle.url, getServerPassword());

    // Attach long-lived crash listeners (detached in stop()).
    const proc = handle.process;
    proc.on("exit", (code) => {
      // Only react if this handle is still current (not already stopped).
      if (serverHandle !== handle) return;
      serverHandle = null;
      client = null;
      setStatus({
        ...currentStatus,
        state: "error",
        error: `opencode server exited unexpectedly (code ${code})`,
        port: undefined,
        pid: undefined,
        baseUrl: undefined,
      });
    });
    proc.on("error", (err) => {
      if (serverHandle !== handle) return;
      serverHandle = null;
      client = null;
      setStatus({
        ...currentStatus,
        state: "error",
        error: err.message,
        port: undefined,
        pid: undefined,
        baseUrl: undefined,
      });
    });

    // Verify the server is actually responding.
    const healthy = await probeHealth(client);
    if (!healthy) {
      // Clean up the partially-started server.
      proc.removeAllListeners();
      stopProcess(proc);
      serverHandle = null;
      client = null;
      setStatus({
        ...currentStatus,
        state: "error",
        error: "Server started but health check failed",
      });
      return;
    }

    setStatus({
      state: "connected",
      installed: true,
      version: currentStatus.version,
      port: handle.port,
      pid: handle.pid,
      baseUrl: handle.url,
      projectRoot,
    });
  } catch (err) {
    serverHandle = null;
    client = null;
    setStatus({
      ...currentStatus,
      state: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Stop the running server and transition to "stopped". */
export async function stop(): Promise<void> {
  const handle = serverHandle;
  if (!handle) {
    if (currentStatus.installed) {
      setStatus({
        ...currentStatus,
        state: "stopped",
        port: undefined,
        pid: undefined,
        baseUrl: undefined,
        projectRoot: undefined,
        error: undefined,
      });
    }
    return;
  }

  // Detach crash listeners before killing so they don't fire.
  handle.process.removeAllListeners("exit");
  handle.process.removeAllListeners("error");

  serverHandle = null;
  client = null;
  stopProcess(handle.process);

  setStatus({
    ...currentStatus,
    state: "stopped",
    port: undefined,
    pid: undefined,
    baseUrl: undefined,
    projectRoot: undefined,
    error: undefined,
  });
}

/** Restart the server for the current project root. */
export async function restart(): Promise<void> {
  const root = currentStatus.projectRoot;
  if (!root) return;
  await stop();
  await startForProject(root);
}

/**
 * Synchronously kill the server — for `app.before-quit`.
 * The process kill itself is sync (taskkill / proc.kill); status update is
 * best-effort and won't block quit.
 */
export function dispose(): void {
  if (!serverHandle) return;
  const handle = serverHandle;
  handle.process.removeAllListeners();
  serverHandle = null;
  client = null;
  stopProcess(handle.process);
}

// ---------------------------------------------------------------------------
// Client access (for future phases: context injection, prompting, chat)
// ---------------------------------------------------------------------------

export function getClient(): OpencodeClient | null {
  return client;
}
