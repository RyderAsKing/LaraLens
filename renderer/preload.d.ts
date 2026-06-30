// Self-contained preload type declarations for the renderer.
// The real implementation lives in main/preload.ts; these mirror its shape so
// the renderer can call window.laralens without importing main-process code.

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

declare global {
  interface Window {
    laralens: {
      scan: (projectPath: string) => Promise<ScanResult>;
      pickDirectory: () => Promise<string | null>;
      openCodeWindow: (file: string, line?: number) => Promise<void>;
      readCodeFile: (file: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
    };
  }
}

export {};
