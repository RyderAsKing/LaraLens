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
