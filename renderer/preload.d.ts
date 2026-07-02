// Self-contained preload type declarations for the renderer.
// The real implementation lives in main/preload.ts; these mirror its shape so
// the renderer can call window.laralens / window.opencode without importing
// main-process code.

export interface ScanResult {
  ok: boolean;
  error?: string;
  graph: GraphPayload;
  summary: ScanSummary;
}

export interface GraphPayload {
  meta: {
    project: string;
    analyzedAt: string;
    nodeCount: number;
    edgeCount: number;
  };
  nodes: unknown[];
  edges: unknown[];
}

export interface ScanSummary {
  totalRoutes: number;
  totalControllers: number;
  totalModels: number;
  totalCommands: number;
  totalMiddleware: number;
  totalProviders: number;
  durationMs: number;
}

export type OpencodeState =
  | "unknown"
  | "not_installed"
  | "starting"
  | "connected"
  | "error"
  | "stopped";

export interface OpencodeStatus {
  state: OpencodeState;
  installed: boolean;
  version?: string;
  port?: number;
  pid?: number;
  baseUrl?: string;
  projectRoot?: string;
  error?: string;
}

declare global {
  interface Window {
    laralens: {
      scan: (projectPath: string) => Promise<ScanResult>;
      pickDirectory: () => Promise<string | null>;
      openCodeWindow: (file: string, line?: number) => Promise<void>;
      readCodeFile: (file: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
    };
    opencode: {
      getStatus: () => Promise<OpencodeStatus>;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      restart: () => Promise<void>;
      onStatusChange: (callback: (status: OpencodeStatus) => void) => () => void;
    };
  }
}

export {};
