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
