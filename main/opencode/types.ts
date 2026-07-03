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

export type ChatPart =
  | { id: string; type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; tool: string; callID: string; state: ChatToolState }
  | { id: string; type: "subtask"; agent: string; description: string; prompt: string }
  | { id: string; type: "step-start" }
  | { id: string; type: "step-finish"; reason: string }
  | { id: string; type: "file"; mime: string; filename?: string; url: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Structured parts for assistant messages (tool calls, reasoning, etc.). */
  parts?: ChatPart[];
  createdAt: number;
  status: ChatMessageStatus;
  error?: string;
}
