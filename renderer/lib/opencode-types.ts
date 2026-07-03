/**
 * Status type for the opencode subsystem (renderer-side copy).
 * Mirrors `main/opencode/types.ts` and `renderer/preload.d.ts`.
 */

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

// ---------------------------------------------------------------------------
// Chat — mirrors `main/opencode/types.ts`.
// ---------------------------------------------------------------------------

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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  parts?: ChatPart[];
  createdAt: number;
  status: ChatMessageStatus;
  error?: string;
}
