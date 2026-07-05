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

  /** Open an https URL in the user's default browser. Resolves false on bad input. */
  openExternal: (url: string) =>
    ipcRenderer.invoke("laralens:open-external", url) as Promise<boolean>,

  readCodeFile: (file: string) =>
    ipcRenderer.invoke("laralens:read-code-file", file) as Promise<{ ok: boolean; content?: string; error?: string }>,

  settings: {
    get: () => ipcRenderer.invoke("laralens:settings:get") as Promise<LaraLensSettings>,
    update: (patch: Partial<LaraLensSettings>) =>
      ipcRenderer.invoke("laralens:settings:update", patch) as Promise<LaraLensSettings>,
    options: (projectRoot?: string | null) =>
      ipcRenderer.invoke("laralens:settings:options", { projectRoot }) as Promise<SettingsOptionsResult>,
  },

  /** App auto-update API. Nothing downloads or installs without an explicit call. */
  updater: {
    /** Manually check for an update. Resolves with the latest status. */
    check: () =>
      ipcRenderer.invoke("laralens:update:check") as Promise<UpdateStatus>,
    /** Begin downloading the known update (only after `check` found one). */
    download: () =>
      ipcRenderer.invoke("laralens:update:download") as Promise<UpdateStatus>,
    /** Quit and run the installer for a fully-downloaded update. */
    install: () =>
      ipcRenderer.invoke("laralens:update:install") as Promise<boolean>,
    /** Read the current status without triggering a check. */
    getState: () =>
      ipcRenderer.invoke("laralens:update:get-state") as Promise<UpdateStatus>,
    /** Subscribe to status broadcasts from main. Returns unsubscribe. */
    onState: (callback: (status: UpdateStatus) => void) => {
      const listener = (_event: IpcRendererEvent, status: UpdateStatus) =>
        callback(status);
      ipcRenderer.on("laralens:update:state", listener);
      return () => {
        ipcRenderer.off("laralens:update:state", listener);
      };
    },
  },
};

/** Chat streaming event payloads pushed from main → renderer. */
type ChatPartPayload = { projectRoot: string; messageId: string; part: ChatPart; delta?: string };
type ChatDonePayload = { projectRoot: string; messageId: string; content?: string; parts?: ChatPart[] };
type ChatErrorPayload = { projectRoot: string; messageId: string; error: string };
type ChatTokensPayload = { projectRoot: string; messageId: string; tokens: ChatTokens };

/**
 * The OpenCode API exposed to the renderer process.
 * The opencode server lifecycle is managed in the main process; the renderer
 * only observes status, triggers start/stop/restart, and uses the chat API.
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

  /** Chat API — send prompts, manage history, and subscribe to streaming events. */
  chat: {
    /** Send a prompt. Returns a local assistant message ID for tracking. */
    send: (projectRoot: string, text: string) =>
      ipcRenderer.invoke("opencode:chat:send", { projectRoot, text }) as Promise<{
        ok: boolean;
        assistantMessageId?: string;
        error?: string;
      }>,

    /** Get the conversation history for a project. */
    history: (projectRoot: string) =>
      ipcRenderer.invoke("opencode:chat:history", projectRoot) as Promise<ChatMessage[]>,

    /** Clear the conversation history for a project and start a fresh session. */
    clear: (projectRoot: string) =>
      ipcRenderer.invoke("opencode:chat:clear", projectRoot) as Promise<{
        ok: boolean;
        error?: string;
      }>,

    /** Abort the current streaming response. */
    abort: (projectRoot: string) =>
      ipcRenderer.invoke("opencode:chat:abort", projectRoot) as Promise<{
        ok: boolean;
        error?: string;
      }>,

    replyPermission: (projectRoot: string, permissionID: string, response: ChatPermissionResponse) =>
      ipcRenderer.invoke("opencode:chat:permission:reply", { projectRoot, permissionID, response }) as Promise<{
        ok: boolean;
        error?: string;
      }>,

    /** Subscribe to part updates for a streaming assistant message. */
    onPart: (callback: (payload: ChatPartPayload) => void) => {
      const listener = (_event: IpcRendererEvent, payload: ChatPartPayload) =>
        callback(payload);
      ipcRenderer.on("opencode:chat:part", listener);
      return () => {
        ipcRenderer.off("opencode:chat:part", listener);
      };
    },

    /** Subscribe to completion events for an assistant message. */
    onDone: (callback: (payload: ChatDonePayload) => void) => {
      const listener = (_event: IpcRendererEvent, payload: ChatDonePayload) =>
        callback(payload);
      ipcRenderer.on("opencode:chat:done", listener);
      return () => {
        ipcRenderer.off("opencode:chat:done", listener);
      };
    },

    /** Subscribe to error events for an assistant message. */
    onError: (callback: (payload: ChatErrorPayload) => void) => {
      const listener = (_event: IpcRendererEvent, payload: ChatErrorPayload) =>
        callback(payload);
      ipcRenderer.on("opencode:chat:error", listener);
      return () => {
        ipcRenderer.off("opencode:chat:error", listener);
      };
    },

    /** Subscribe to token-usage updates for an assistant message. */
    onTokens: (callback: (payload: ChatTokensPayload) => void) => {
      const listener = (_event: IpcRendererEvent, payload: ChatTokensPayload) =>
        callback(payload);
      ipcRenderer.on("opencode:chat:tokens", listener);
      return () => {
        ipcRenderer.off("opencode:chat:tokens", listener);
      };
    },
  },
};

export type LaraLensApi = typeof laralens;
export type OpencodeApi = typeof opencode;

export type UpdateState =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  progress?: number;
  error?: string;
}

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

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";

export type ChatToolState =
  | { status: "pending"; input: Record<string, unknown> }
  | { status: "running"; input: Record<string, unknown>; title?: string }
  | { status: "completed"; input: Record<string, unknown>; output: string; title?: string }
  | { status: "error"; input: Record<string, unknown>; error: string };

export type ChatPermissionResponse = "once" | "always" | "reject";

export type ChatPart =
  | { id: string; type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; tool: string; callID: string; state: ChatToolState }
  | { id: string; type: "subtask"; agent: string; description: string; prompt: string }
  | {
      id: string;
      type: "permission";
      permissionID: string;
      permissionType: string;
      title: string;
      pattern?: string | string[];
      metadata: Record<string, unknown>;
      callID?: string;
      status: "pending" | "approved" | "rejected";
      response?: ChatPermissionResponse;
    }
  | { id: string; type: "step-start" }
  | { id: string; type: "step-finish"; reason: string }
  | { id: string; type: "file"; mime: string; filename?: string; url: string };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  parts?: ChatPart[];
  createdAt: number;
  status: ChatMessageStatus;
  error?: string;
  tokens?: ChatTokens;
};

export type ChatTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type ModelSelection = {
  providerID: string;
  modelID: string;
};

export type LaraLensSettings = {
  defaultAgent: string | null;
  defaultModel: ModelSelection | null;
};

export type SettingsModel = {
  id: string;
  providerID: string;
  name: string;
  status: string;
  contextLimit: number;
  outputLimit: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
};

export type SettingsProvider = {
  id: string;
  name: string;
  source: string;
  models: SettingsModel[];
};

export type SettingsAgent = {
  name: string;
  description?: string;
  mode: string;
  builtIn: boolean;
  color?: string;
  model?: ModelSelection;
};

export type SettingsOptionsResult = {
  ok: boolean;
  settings: LaraLensSettings;
  providers: SettingsProvider[];
  agents: SettingsAgent[];
  error?: string;
};

contextBridge.exposeInMainWorld("laralens", laralens);
contextBridge.exposeInMainWorld("opencode", opencode);
