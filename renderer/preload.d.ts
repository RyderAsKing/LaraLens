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

export interface ChatTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  parts?: ChatPart[];
  createdAt: number;
  status: ChatMessageStatus;
  error?: string;
  tokens?: ChatTokens;
}

/** Metadata for a persisted conversation (one row in the sessions table). */
export interface ChatSessionMeta {
  id: string;
  projectRoot: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  opencodeSessionId: string | null;
}

export interface ChatSendResult {
  ok: boolean;
  assistantMessageId?: string;
  sessionId?: string;
  error?: string;
}

export type ChatLoadSessionResult =
  | { ok: true; messages: ChatMessage[]; meta: ChatSessionMeta }
  | { ok: false; error: string };

export interface ChatAbortResult {
  ok: boolean;
  error?: string;
}

export interface ChatPartPayload {
  projectRoot: string;
  messageId: string;
  part: ChatPart;
  delta?: string;
}

export interface ChatDonePayload {
  projectRoot: string;
  messageId: string;
  content?: string;
  parts?: ChatPart[];
}

export interface ChatErrorPayload {
  projectRoot: string;
  messageId: string;
  error: string;
}

export interface ChatTokensPayload {
  projectRoot: string;
  messageId: string;
  tokens: ChatTokens;
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
}

export interface LaraLensSettings {
  defaultAgent: string | null;
  defaultModel: ModelSelection | null;
}

export interface SettingsModel {
  id: string;
  providerID: string;
  name: string;
  status: string;
  contextLimit: number;
  outputLimit: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface SettingsProvider {
  id: string;
  name: string;
  source: string;
  models: SettingsModel[];
}

export interface SettingsAgent {
  name: string;
  description?: string;
  mode: string;
  builtIn: boolean;
  color?: string;
  model?: ModelSelection;
}

export interface SettingsOptionsResult {
  ok: boolean;
  settings: LaraLensSettings;
  providers: SettingsProvider[];
  agents: SettingsAgent[];
  error?: string;
}

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

declare global {
  interface Window {
    laralens: {
      scan: (projectPath: string) => Promise<ScanResult>;
      pickDirectory: () => Promise<string | null>;
      openCodeWindow: (file: string, line?: number) => Promise<void>;
      openExternal: (url: string) => Promise<boolean>;
      readCodeFile: (file: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
      settings: {
        get: () => Promise<LaraLensSettings>;
        update: (patch: Partial<LaraLensSettings>) => Promise<LaraLensSettings>;
        options: (projectRoot?: string | null) => Promise<SettingsOptionsResult>;
      };
      updater: {
        check: () => Promise<UpdateStatus>;
        download: () => Promise<UpdateStatus>;
        install: () => Promise<boolean>;
        getState: () => Promise<UpdateStatus>;
        onState: (callback: (status: UpdateStatus) => void) => () => void;
      };
    };
    opencode: {
      getStatus: () => Promise<OpencodeStatus>;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      restart: () => Promise<void>;
      onStatusChange: (callback: (status: OpencodeStatus) => void) => () => void;
      chat: {
        send: (projectRoot: string, text: string) => Promise<ChatSendResult>;
        history: (projectRoot: string) => Promise<ChatMessage[]>;
        clear: (projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
        abort: (projectRoot: string) => Promise<ChatAbortResult>;
        replyPermission: (projectRoot: string, permissionID: string, response: ChatPermissionResponse) => Promise<{ ok: boolean; error?: string }>;
        listSessions: (projectRoot: string) => Promise<ChatSessionMeta[]>;
        loadSession: (projectRoot: string, sessionId: string) => Promise<ChatLoadSessionResult>;
        newSession: (projectRoot: string) => Promise<{ ok: boolean; error?: string }>;
        deleteSession: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        renameSession: (sessionId: string, title: string) => Promise<{ ok: boolean; error?: string }>;
        onPart: (callback: (payload: ChatPartPayload) => void) => () => void;
        onDone: (callback: (payload: ChatDonePayload) => void) => () => void;
        onError: (callback: (payload: ChatErrorPayload) => void) => () => void;
        onTokens: (callback: (payload: ChatTokensPayload) => void) => () => void;
      };
    };
  }
}

export {};
