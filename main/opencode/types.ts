/**
 * Opencode subsystem — shared status type.
 *
 * This is the serializable shape that crosses the IPC boundary, so it must
 * stay free of Node-only types. The renderer mirrors it in
 * `renderer/lib/opencode-types.ts`.
 */

export type OpencodeState =
  | "unknown"        // before detection has run
  | "not_installed"  // `opencode` binary not found on PATH
  | "starting"       // child process spawned, waiting for health
  | "connected"      // server up + client verified
  | "error"          // spawn failed, crashed, or health check failed
  | "stopped";       // intentionally stopped (or never started for a project)

export interface OpencodeStatus {
  state: OpencodeState;
  installed: boolean;
  /** opencode --version output, if known. */
  version?: string;
  /** Port the server is listening on. */
  port?: number;
  /** Child process PID. */
  pid?: number;
  /** Base URL the SDK client is pointed at. */
  baseUrl?: string;
  /** Project root the server was spawned with (cwd). */
  projectRoot?: string;
  /** Human-readable error when state === "error". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Chat — in-memory per-project conversation model that crosses IPC.
// Mirrored in `renderer/lib/opencode-types.ts` and `renderer/preload.d.ts`.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus =
  | "pending" // request accepted, waiting for first token
  | "streaming" // deltas are arriving
  | "complete" // final response assembled
  | "error"; // failed (error field populated)

// ---------------------------------------------------------------------------
// Chat parts — serializable representations of OpenCode message parts.
// These cross the IPC boundary so they must stay JSON-serializable.
// Mirrored in `renderer/lib/opencode-types.ts`.
// ---------------------------------------------------------------------------

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
  /** Structured parts for assistant messages (tool calls, reasoning, etc.). */
  parts?: ChatPart[];
  createdAt: number;
  status: ChatMessageStatus;
  error?: string;
  /** Token usage for the most recent assistant turn (when available). */
  tokens?: ChatTokens;
}

// ---------------------------------------------------------------------------
// Session history metadata — persisted conversation record.
// One project root can have many sessions (conversations); each has its own
// message history. Mirrored in `renderer/lib/opencode-types.ts`.
// ---------------------------------------------------------------------------

export interface ChatSessionMeta {
  /** Local DB id (UUID). Identifies a conversation across restarts. */
  id: string;
  projectRoot: string;
  /** Auto-generated from the first user message (truncated). User-editable. */
  title: string;
  createdAt: number;
  lastActiveAt: number;
  /**
   * OpenCode server session id captured when the conversation was last active.
   * Stored best-effort: the server may have discarded it by the time the
   * session is restored, so loaders treat it as a hint, not a guarantee.
   */
  opencodeSessionId: string | null;
}
