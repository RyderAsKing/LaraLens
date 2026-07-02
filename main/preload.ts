import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * The LaraLens API exposed to the renderer process.
 * All scanning/parsing runs in the main process (Node fs + php-parser);
 * the renderer only receives the resulting JSON schema.
 */
const laralens = {
  /**
   * Scan a Laravel project at the given absolute path.
   * Resolves with the full graph schema { meta, nodes, edges } + summary.
   */
  scan: (projectPath: string) =>
    ipcRenderer.invoke("laralens:scan", projectPath) as Promise<ScanResult>,

  /** Open the OS directory picker and return the chosen absolute path, or null. */
  pickDirectory: () =>
    ipcRenderer.invoke("laralens:pick-directory") as Promise<string | null>,

  openCodeWindow: (file: string, line?: number) =>
    ipcRenderer.invoke("laralens:open-code-window", { file, line }) as Promise<void>,

  readCodeFile: (file: string) =>
    ipcRenderer.invoke("laralens:read-code-file", file) as Promise<{ ok: boolean; content?: string; error?: string }>,
};

/**
 * The OpenCode API exposed to the renderer process.
 * The opencode server lifecycle is managed in the main process; the renderer
 * only observes status and triggers start/stop/restart.
 */
const opencode = {
  /** Get the current opencode subsystem status. */
  getStatus: () =>
    ipcRenderer.invoke("opencode:status") as Promise<OpencodeStatus>,

  /** Start the opencode server for the currently-scanned project. */
  start: () => ipcRenderer.invoke("opencode:start") as Promise<void>,

  /** Stop the running opencode server. */
  stop: () => ipcRenderer.invoke("opencode:stop") as Promise<void>,

  /** Restart the opencode server for the current project. */
  restart: () => ipcRenderer.invoke("opencode:restart") as Promise<void>,

  /** Subscribe to real-time status changes. Returns an unsubscribe function. */
  onStatusChange: (callback: (status: OpencodeStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: OpencodeStatus) =>
      callback(status);
    ipcRenderer.on("opencode:status-changed", listener);
    return () => {
      ipcRenderer.off("opencode:status-changed", listener);
    };
  },
};

export type LaraLensApi = typeof laralens;
export type OpencodeApi = typeof opencode;

export type ScanResult = {
  ok: boolean;
  error?: string;
  graph: GraphPayload;
  summary: ScanSummary;
};

export type GraphPayload = {
  meta: { project: string; analyzedAt: string; nodeCount: number; edgeCount: number };
  nodes: unknown[];
  edges: unknown[];
};

export type ScanSummary = {
  totalRoutes: number;
  totalControllers: number;
  totalModels: number;
  totalCommands: number;
  totalMiddleware: number;
  totalProviders: number;
  durationMs: number;
};

export type OpencodeState =
  | "unknown"
  | "not_installed"
  | "starting"
  | "connected"
  | "error"
  | "stopped";

export type OpencodeStatus = {
  state: OpencodeState;
  installed: boolean;
  version?: string;
  port?: number;
  pid?: number;
  baseUrl?: string;
  projectRoot?: string;
  error?: string;
};

contextBridge.exposeInMainWorld("laralens", laralens);
contextBridge.exposeInMainWorld("opencode", opencode);
