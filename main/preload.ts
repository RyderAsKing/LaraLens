import { contextBridge, ipcRenderer } from "electron";

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
};

export type LaraLensApi = typeof laralens;

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

contextBridge.exposeInMainWorld("laralens", laralens);
