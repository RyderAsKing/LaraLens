/**
 * SQLite-backed persistence for OpenCode chat sessions.
 *
 * Today the in-memory `sessions` Map in `chat.ts` is lost on restart. This
 * module mirrors settled message state to a local SQLite database so past
 * conversations survive app restarts and can be browsed/restored from the
 * renderer.
 *
 * Design:
 * - One row per conversation in `sessions` (id, project_root, title, ts,
 *   opencode_session_id). The OpenCode server session id is stored best-effort
 *   — it may be stale after a server restart, so loaders treat it as a hint.
 * - One row per local `ChatMessage` in `messages`, keyed by the local UUID
 *   that `chat.ts` already mints. `parts` and `tokens` are JSON-encoded.
 * - Writes are synchronous (better-sqlite3). Each write is < 1ms for our row
 *   sizes, so blocking the main process event loop briefly is acceptable and
 *   avoids async plumbing through every streaming event handler.
 * - We only persist *settled* state: the user message + pending assistant
 *   bubble on send, then the final canonical content/parts on completion or
 *   error. Intermediate streaming deltas are intentionally not persisted —
 *   history only needs the finished conversation.
 *
 * Callers in `chat.ts` wrap mutations in try/catch so a persistence failure
 * never breaks the live chat.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { app } from "electron";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ChatMessage, ChatPart, ChatTokens, ChatSessionMeta } from "./types";

let db: DatabaseType | null = null;

interface DbSessionRow {
  id: string;
  project_root: string;
  title: string;
  created_at: number;
  last_active_at: number;
  opencode_session_id: string | null;
}

interface DbMessageRow {
  id: string;
  role: string;
  content: string;
  parts: string | null;
  status: string;
  error: string | null;
  tokens: string | null;
  created_at: number;
}

function getDbPath(): string {
  return path.join(app.getPath("userData"), "laralens-chat.db");
}

function requireDb(): DatabaseType {
  if (!db) {
    throw new Error("Persistence not initialized. Call initPersistence() first.");
  }
  return db;
}

function rowToMeta(row: DbSessionRow): ChatSessionMeta {
  return {
    id: row.id,
    projectRoot: row.project_root,
    title: row.title,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    opencodeSessionId: row.opencode_session_id,
  };
}

function rowToMessage(row: DbMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatMessage["role"],
    content: row.content,
    parts: row.parts ? (JSON.parse(row.parts) as ChatPart[]) : undefined,
    createdAt: row.created_at,
    status: row.status as ChatMessage["status"],
    error: row.error ?? undefined,
    tokens: row.tokens ? (JSON.parse(row.tokens) as ChatTokens) : undefined,
  };
}

/** Open the database and ensure schema exists. Safe to call once per process. */
export function initPersistence(): void {
  if (db) return;
  const database = new Database(getDbPath());
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      opencode_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions(project_root, last_active_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      parts TEXT,
      status TEXT NOT NULL,
      error TEXT,
      tokens TEXT,
      created_at INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, sort_order);
  `);
  db = database;
  // Clean up any sessions left empty by a "new conversation" that was never
  // sent to (or a crashed session creation). Safe no-op on a fresh DB.
  try {
    pruneEmptySessions();
  } catch {
    /* ignore — best-effort cleanup */
  }
}

/** Close the database handle. Called on app shutdown. */
export function closePersistence(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Insert a new session row and return its generated id. The caller is
 * responsible for then saving messages with that id.
 */
export function createSession(projectRoot: string, title: string): string {
  const d = requireDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    `INSERT INTO sessions (id, project_root, title, created_at, last_active_at, opencode_session_id)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(id, projectRoot, title, now, now);
  return id;
}

/** Patch a session's mutable metadata. Unknown fields are ignored. */
export function updateSessionMeta(
  id: string,
  patch: {
    title?: string;
    opencodeSessionId?: string | null;
    lastActiveAt?: number;
  }
): void {
  const d = requireDb();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    vals.push(patch.title);
  }
  if (patch.opencodeSessionId !== undefined) {
    sets.push("opencode_session_id = ?");
    vals.push(patch.opencodeSessionId);
  }
  if (patch.lastActiveAt !== undefined) {
    sets.push("last_active_at = ?");
    vals.push(patch.lastActiveAt);
  }
  if (sets.length === 0) return;
  vals.push(id);
  d.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Bump a session's last_active_at to now. */
export function touchSession(id: string): void {
  updateSessionMeta(id, { lastActiveAt: Date.now() });
}

/** List sessions for a project, most recently active first. */
export function listSessions(projectRoot: string): ChatSessionMeta[] {
  const d = requireDb();
  const rows = d
    .prepare(
      `SELECT id, project_root, title, created_at, last_active_at, opencode_session_id
       FROM sessions WHERE project_root = ?
       ORDER BY last_active_at DESC`
    )
    .all(projectRoot) as DbSessionRow[];
  return rows.map(rowToMeta);
}

/** Return a single session by id, or null if not found. */
export function getSession(id: string): ChatSessionMeta | null {
  const d = requireDb();
  const row = d
    .prepare(
      `SELECT id, project_root, title, created_at, last_active_at, opencode_session_id
       FROM sessions WHERE id = ?`
    )
    .get(id) as DbSessionRow | undefined;
  return row ? rowToMeta(row) : null;
}

/** Return all messages for a session in chronological (sort_order) order. */
export function getSessionMessages(sessionId: string): ChatMessage[] {
  const d = requireDb();
  const rows = d
    .prepare(
      `SELECT id, role, content, parts, status, error, tokens, created_at
       FROM messages WHERE session_id = ?
       ORDER BY sort_order ASC`
    )
    .all(sessionId) as DbMessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Upsert a message row. `sort_order` is the message's index within the
 * session's `messages[]` array, so reloads preserve ordering.
 */
export function saveMessage(
  sessionId: string,
  sortOrder: number,
  msg: ChatMessage
): void {
  const d = requireDb();
  d.prepare(
    `INSERT INTO messages (id, session_id, role, content, parts, status, error, tokens, created_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       parts = excluded.parts,
       status = excluded.status,
       error = excluded.error,
       tokens = excluded.tokens,
       sort_order = excluded.sort_order`
  ).run(
    msg.id,
    sessionId,
    msg.role,
    msg.content,
    msg.parts ? JSON.stringify(msg.parts) : null,
    msg.status,
    msg.error ?? null,
    msg.tokens ? JSON.stringify(msg.tokens) : null,
    msg.createdAt,
    sortOrder
  );
}

/**
 * Update an existing message row's mutable fields (content/parts/status/error/
 * tokens). The row must already exist (created via `saveMessage` on send).
 */
export function updateMessage(sessionId: string, msg: ChatMessage): void {
  const d = requireDb();
  d.prepare(
    `UPDATE messages SET
       content = ?, parts = ?, status = ?, error = ?, tokens = ?
     WHERE id = ? AND session_id = ?`
  ).run(
    msg.content,
    msg.parts ? JSON.stringify(msg.parts) : null,
    msg.status,
    msg.error ?? null,
    msg.tokens ? JSON.stringify(msg.tokens) : null,
    msg.id,
    sessionId
  );
}

/** Delete a session and (via cascade) all of its messages. */
export function deleteSession(id: string): void {
  const d = requireDb();
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** Delete every session for a project (and their messages, via cascade). */
export function deleteSessionsForProject(projectRoot: string): void {
  const d = requireDb();
  d.prepare("DELETE FROM sessions WHERE project_root = ?").run(projectRoot);
}

/**
 * Remove sessions that have no messages. A "new conversation" that was never
 * sent to leaves an empty row; prune those on startup so the history list
 * stays clean.
 */
export function pruneEmptySessions(): void {
  const d = requireDb();
  d.prepare(
    `DELETE FROM sessions WHERE id NOT IN (
       SELECT DISTINCT session_id FROM messages
     )`
  ).run();
}
