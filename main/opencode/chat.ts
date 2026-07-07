/**
 * OpenCode chat manager — in-memory per-project conversation store that
 * bridges the SDK's session/prompt/event APIs to the renderer via IPC.
 *
 * Architecture:
 * - Each project root gets a `ChatSession` holding a local `ChatMessage[]`
 *   and a lazily-created OpenCode session ID.
 * - Prompts are sent via `session.promptAsync` (non-blocking) and the
 *   response is streamed back through a single SSE `event.subscribe` stream.
 * - The stream is started as soon as the SDK client is attached and kept
 *   alive with auto-reconnect until the client is detached.
 * - Events are filtered by session ID and routed to the right conversation,
 *   then forwarded to the renderer as `opencode:chat:*` IPC events.
 *
 * Message ID bridging:
 * - We do NOT pass `messageID` to promptAsync. The server assigns the user
 *   message ID and announces it via a `message.updated` event with role
 *   "user" right after promptAsync is accepted. We map the in-flight
 *   assistant bubble → that server-assigned user message ID so the idle
 *   handler can fetch canonical content scoped to exactly this user turn.
 * - We generate a local UUID for the assistant message upfront. On the first
 *   `message.part.updated` / `message.updated` event for the new assistant
 *   message, we map the OpenCode message ID → local UUID.
 */

import { randomUUID } from "node:crypto";
import type { OpencodeClient, Event, Part, Message, Permission } from "@opencode-ai/sdk";
import type { ChatMessage, ChatPart, ChatToolState, ChatPermissionResponse, ChatTokens, ChatSessionMeta } from "./types";
import { getSettings } from "../settings";
import * as persistence from "./persistence";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatSession {
  /** OpenCode session ID (empty string = not yet created / invalidated). */
  opencodeSessionId: string;
  /**
   * Whether `opencodeSessionId` has been confirmed alive on the current
   * server connection. False on load (we have not verified yet), after a
   * disconnect, and until the first successful verification in `send`.
   * When true, `send` skips the verification round-trip and reuses the id.
   */
  opencodeSessionVerified: boolean;
  /** Local DB session id (null = not yet persisted / fresh conversation). */
  sessionId: string | null;
  /** Auto-generated title from first user message (null until first send). */
  title: string | null;
  /** Local conversation history (user + assistant messages interleaved). */
  messages: ChatMessage[];
  /** Local UUID of the assistant message we're waiting to stream (pre-mapping). */
  pendingAssistantLocalId: string | null;
  /** OpenCode message ID → local ChatMessage.id mapping. */
  opencodeToLocal: Map<string, string>;
  /** OpenCode message IDs known not to be assistant responses (usually user messages). */
  ignoredOpencodeMessageIds: Set<string>;
  /** Local assistant message ID → OpenCode user message ID for that prompt. */
  assistantToUserMessageId: Map<string, string>;
  /** Local assistant message IDs that have seen a primary session busy status. */
  assistantIdsWithObservedBusy: Set<string>;
  /** Full text for text parts that arrived before message.updated confirmed role. */
  pendingPartTextByMessageId: Map<string, string>;
  /** Resolved default model (cached after first successful provider lookup). */
  resolvedModel?: { providerID: string; modelID: string };
}

type Broadcaster = (channel: string, payload: unknown) => void;

interface AssistantContent {
  content: string;
  parts: ChatPart[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, ChatSession>();
const sessionToProject = new Map<string, string>();
const projectsWithSendInProgress = new Set<string>();

let client: OpencodeClient | null = null;
let broadcast: Broadcaster | null = null;

let streamShouldRun = false;
let activeStream: AsyncGenerator<Event> | null = null;
let activeStreamAbort: AbortController | null = null;
let activeStreamDirectory: string | null = null;
let activeStreamReady: Promise<void> | null = null;
let resolveActiveStreamReady: (() => void) | null = null;

function chatLog(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(`[opencode:chat] ${message}`, details);
  } else {
    console.info(`[opencode:chat] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Derive a short, human-readable title from the first user prompt. Collapses
 * whitespace and truncates so the sessions list stays scannable.
 */
function titleFromPrompt(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 60) return trimmed || "New conversation";
  return trimmed.slice(0, 57) + "...";
}

/**
 * Run a persistence mutation, swallowing and logging any error so a DB issue
 * never breaks the live chat. The in-memory session remains the source of
 * truth for the active conversation; persistence is best-effort.
 */
function safePersist(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    chatLog("persistence error", {
      label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Create a DB session row, returning the new id or null on failure. */
function persistCreateSession(projectRoot: string, title: string): string | null {
  try {
    return persistence.createSession(projectRoot, title);
  } catch (err) {
    chatLog("persistence error", {
      label: "createSession",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Upsert a message row at its current index in the session's messages array. */
function persistMessageAt(chatSession: ChatSession, msg: ChatMessage, sortOrder: number): void {
  if (!chatSession.sessionId) return;
  safePersist("saveMessage", () =>
    persistence.saveMessage(chatSession.sessionId!, sortOrder, msg)
  );
}

/** Update a settled message's mutable fields and bump the session's ts. */
function persistMessageUpdate(chatSession: ChatSession, msg: ChatMessage): void {
  if (!chatSession.sessionId) return;
  safePersist("updateMessage", () =>
    persistence.updateMessage(chatSession.sessionId!, msg)
  );
  safePersist("touchSession", () => persistence.touchSession(chatSession.sessionId!));
}

/**
 * Mark any in-flight assistant messages as complete with whatever content
 * streamed so far, and persist them. Used when a conversation is abandoned
 * mid-stream (new conversation, load another session, app quit) so the DB
 * doesn't retain a forever-pending bubble.
 */
function finalizeInflightMessages(chatSession: ChatSession): void {
  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      message.status = "complete";
      persistMessageUpdate(chatSession, message);
      chatSession.assistantToUserMessageId.delete(message.id);
      chatSession.assistantIdsWithObservedBusy.delete(message.id);
    }
  }
  chatSession.pendingAssistantLocalId = null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Set the callback used to push events to all renderer windows. */
export function setBroadcaster(fn: Broadcaster): void {
  broadcast = fn;
}

/**
 * Attach or detach the SDK client. When a client is attached, the SSE event
 * stream is started immediately so prompt events are not missed. When detached,
 * the stream is stopped and all OpenCode session IDs are invalidated (the
 * server is gone).
 */
export function setClient(next: OpencodeClient | null): void {
  if (next === client) return;
  if (client) {
    stopStream();
  }
  client = next;
  if (!next) {
    for (const session of sessions.values()) {
      markInflightMessagesError(session, "OpenCode server disconnected.");
      session.opencodeSessionId = "";
      session.opencodeSessionVerified = false;
      session.opencodeToLocal.clear();
      session.ignoredOpencodeMessageIds.clear();
      session.assistantToUserMessageId.clear();
      session.assistantIdsWithObservedBusy.clear();
      session.pendingPartTextByMessageId.clear();
      session.pendingAssistantLocalId = null;
      delete session.resolvedModel;
    }
    sessionToProject.clear();
    projectsWithSendInProgress.clear();
  } else {
    // The new server may not know about sessions verified against the
    // previous server, so drop all verification state. Sessions with a
    // restored opencode id will re-verify lazily on the next send; sessions
    // whose id was cleared on disconnect stay cleared (send creates fresh).
    for (const session of sessions.values()) {
      session.opencodeSessionVerified = false;
    }
    const existingProjectRoot = [...sessions.keys()][0];
    if (existingProjectRoot) void startStream(existingProjectRoot);
  }
}

/** Clear all state — called on app quit. */
export function dispose(): void {
  stopStream();
  // Finalize any in-flight assistant messages so the DB doesn't retain
  // forever-pending bubbles. Runs before closePersistence() in before-quit.
  for (const session of sessions.values()) {
    finalizeInflightMessages(session);
  }
  client = null;
  sessions.clear();
  sessionToProject.clear();
  projectsWithSendInProgress.clear();
}

// ---------------------------------------------------------------------------
// Public API (called by IPC handlers in main.ts)
// ---------------------------------------------------------------------------

/**
 * Send a prompt for the given project. Creates/reuses an OpenCode session,
 * appends user + pending assistant messages to history, fires `promptAsync`,
 * and returns immediately. Streaming happens via the SSE event stream.
 */
export async function send(
  projectRoot: string,
  text: string
): Promise<{ ok: boolean; assistantMessageId?: string; sessionId?: string; error?: string }> {
  if (!client) {
    return { ok: false, error: "OpenCode server is not connected." };
  }
  if (!text.trim()) {
    return { ok: false, error: "Cannot send an empty message." };
  }
  const promptText = text.trim();

  const chatSession = getOrCreateSession(projectRoot);

  if (
    projectsWithSendInProgress.has(projectRoot) ||
    hasInflightAssistantMessage(chatSession)
  ) {
    return { ok: false, error: "A response is already in progress." };
  }
  projectsWithSendInProgress.add(projectRoot);

  // Ensure we have an OpenCode session. Each await below can be interrupted
  // by a concurrent loadSession/newSession that replaces this chatSession in
  // the `sessions` map. After every await we re-check that we still own the
  // slot; if not, we bail without touching projectsWithSendInProgress (the
  // replacement already cleared it). The orphaned server session we may have
  // created is left for the server to GC.
  if (!chatSession.opencodeSessionId) {
    const created = await createOpencodeSession(projectRoot);
    if (!created.ok) {
      projectsWithSendInProgress.delete(projectRoot);
      return { ok: false, error: created.error };
    }
    if (chatSession !== sessions.get(projectRoot)) {
      return { ok: false, error: "Conversation switched before send completed. Please resend." };
    }
    chatSession.opencodeSessionId = created.id;
    chatSession.opencodeSessionVerified = true;
    sessionToProject.set(created.id, projectRoot);
  } else if (!chatSession.opencodeSessionVerified) {
    // We restored a stored opencode session id on load but have not yet
    // confirmed it is alive on the current server (e.g. load happened while
    // disconnected, or the server has since recycled). Verify before sending;
    // if the id is dead, fall through to create a fresh session so the user
    // does not have to manually recover from a stale-server-session state.
    const status = await verifyOpencodeSession(projectRoot, chatSession.opencodeSessionId);
    if (chatSession !== sessions.get(projectRoot)) {
      return { ok: false, error: "Conversation switched before send completed. Please resend." };
    }
    if (status === "dead") {
      chatLog("stored opencode session is no longer alive; creating a new one", {
        projectRoot,
        opencodeSessionId: chatSession.opencodeSessionId,
      });
      // Drop the stale routing entry before we throw away the id.
      sessionToProject.delete(chatSession.opencodeSessionId);
      chatSession.opencodeSessionId = "";
      if (chatSession.sessionId) {
        safePersist("updateSessionMeta:opencodeSessionId:null", () =>
          persistence.updateSessionMeta(chatSession.sessionId!, { opencodeSessionId: null })
        );
      }
      const created = await createOpencodeSession(projectRoot);
      if (!created.ok) {
        projectsWithSendInProgress.delete(projectRoot);
        return { ok: false, error: created.error };
      }
      if (chatSession !== sessions.get(projectRoot)) {
        return { ok: false, error: "Conversation switched before send completed. Please resend." };
      }
      chatSession.opencodeSessionId = created.id;
      chatSession.opencodeSessionVerified = true;
      sessionToProject.set(created.id, projectRoot);
    } else {
      // alive or unknown — proceed optimistically. Unknown (transient lookup
      // failure) does not block the send; we trust the stored id and let the
      // server reject promptAsync if it really is gone (which surfaces as a
      // normal send error to the user).
      chatSession.opencodeSessionVerified = status === "alive";
      sessionToProject.set(chatSession.opencodeSessionId, projectRoot);
    }
  }

  const sessionId = chatSession.opencodeSessionId;
  const now = Date.now();

  // User message. We do NOT pre-generate an OpenCode message ID here. Kodachi
  // (the reference OpenCode integration) does not pass `messageID` to
  // promptAsync, and LaraLens previously generated `msg_<uuid>` on every
  // prompt. Empirically the OpenCode server accepts the client-supplied ID on
  // the FIRST prompt of a session but on FOLLOW-UP prompts it confirms the
  // user message, transitions busy -> idle, and never emits an assistant
  // message — i.e. it treats the second client-supplied messageID as a
  // duplicate/revision and skips generation. Letting the server assign the
  // user message ID (announced via the subsequent message.updated event with
  // role "user") fixes follow-up prompts in the same session.
  chatSession.messages.push({
    id: randomUUID(),
    role: "user",
    content: promptText,
    createdAt: now,
    status: "complete",
  });

  // Pending assistant message (local UUID; mapped to OpenCode ID on first event).
  const assistantLocalId = randomUUID();
  chatSession.messages.push({
    id: assistantLocalId,
    role: "assistant",
    content: "",
    createdAt: now,
    status: "pending",
  });
  chatSession.pendingAssistantLocalId = assistantLocalId;
  // assistantToUserMessageId is populated in handleMessageUpdated when the
  // server announces the user message it created for this prompt.

  // Persist: create a DB session record on the first message of a new
  // conversation, then save the user + pending assistant messages so the
  // conversation appears in history immediately. Best-effort — a persistence
  // failure never blocks the live chat (the in-memory session is still valid).
  if (chatSession.sessionId === null) {
    const title = titleFromPrompt(promptText);
    const newId = persistCreateSession(projectRoot, title);
    if (newId) {
      chatSession.sessionId = newId;
      chatSession.title = title;
    }
  }
  if (chatSession.sessionId) {
    const userMsg = chatSession.messages[chatSession.messages.length - 2];
    const assistantMsg = chatSession.messages[chatSession.messages.length - 1];
    if (userMsg) persistMessageAt(chatSession, userMsg, chatSession.messages.length - 2);
    if (assistantMsg) persistMessageAt(chatSession, assistantMsg, chatSession.messages.length - 1);
    // Record the OpenCode server session id for future resume support.
    if (chatSession.opencodeSessionId) {
      safePersist("updateSessionMeta:opencodeSessionId", () =>
        persistence.updateSessionMeta(chatSession.sessionId!, {
          opencodeSessionId: chatSession.opencodeSessionId,
        })
      );
    }
    safePersist("touchSession", () => persistence.touchSession(chatSession.sessionId!));
  }

  chatLog("send accepted", {
    projectRoot,
    sessionId,
    assistantLocalId,
    promptLength: promptText.length,
  });

  // Fire the prompt in the background. Returning immediately lets the
  // renderer append the user + pending assistant messages right away, so
  // follow-up prompts visibly start processing even if prompt dispatch is
  // slow or the server performs initial work before producing a response.
  await startStream(projectRoot);
  void dispatchPromptAsync(
    projectRoot,
    sessionId,
    chatSession,
    assistantLocalId,
    promptText
  );

  return { ok: true, assistantMessageId: assistantLocalId, sessionId: chatSession.sessionId ?? undefined };
}

async function dispatchPromptAsync(
  projectRoot: string,
  sessionId: string,
  chatSession: ChatSession,
  assistantLocalId: string,
  promptText: string
): Promise<void> {
  try {
    if (!client) {
      markAssistantError(chatSession, assistantLocalId, "OpenCode server is not connected.");
      return;
    }

    const appSettings = getSettings();

    // Use the user's global model preference when set. Otherwise resolve and
    // cache an automatic fallback, because OpenCode can reject prompts when no
    // model is configured AND none is passed.
    const selectedModel = appSettings.defaultModel ?? chatSession.resolvedModel;
    if (!selectedModel && !chatSession.resolvedModel) {
      const model = await resolveDefaultModel(projectRoot);
      if (model) {
        chatSession.resolvedModel = model;
      }
    }
    const promptModel = appSettings.defaultModel ?? chatSession.resolvedModel;

    chatLog("prompt dispatch start", {
      projectRoot,
      sessionId,
      assistantLocalId,
    });

    const promptAgent = await resolvePromptAgent(projectRoot, appSettings.defaultAgent);

    // Use promptAsync here. We intentionally do NOT pass `messageID`: let the
    // OpenCode server assign the user message ID and announce it via a
    // message.updated event. Passing a client-generated messageID works on the
    // first prompt of a session but causes the server to skip assistant
    // generation on follow-up prompts in the same session.
    const result = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: promptText }],
        ...(promptModel ? { model: promptModel } : {}),
        ...(promptAgent ? { agent: promptAgent } : {}),
      },
      query: { directory: projectRoot },
    });
    if (result.error) {
      const msg = `Prompt failed: ${describeSdkError(result.error)}`;
      console.error("[opencode:chat] promptAsync rejected:", result.error);
      markAssistantError(chatSession, assistantLocalId, msg);
      return;
    }

    chatLog("promptAsync accepted", {
      projectRoot,
      sessionId,
      assistantLocalId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[opencode:chat] promptAsync threw:", err);
    markAssistantError(chatSession, assistantLocalId, msg);
  } finally {
    projectsWithSendInProgress.delete(projectRoot);
  }
}

/** Abort the current streaming response for a project. */
export async function abort(
  projectRoot: string
): Promise<{ ok: boolean; error?: string }> {
  if (!client) return { ok: false, error: "OpenCode server is not connected." };

  const chatSession = sessions.get(projectRoot);
  if (!chatSession || !chatSession.opencodeSessionId) {
    return { ok: false, error: "No active session to abort." };
  }

  try {
    const result = await client.session.abort({
      path: { id: chatSession.opencodeSessionId },
      query: { directory: projectRoot },
    });
    if (result.error) {
      return { ok: false, error: `Abort failed: ${describeSdkError(result.error)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Mark any in-flight assistant messages as complete.
  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      message.status = "complete";
      persistMessageUpdate(chatSession, message);
      chatSession.assistantToUserMessageId.delete(message.id);
      chatSession.assistantIdsWithObservedBusy.delete(message.id);
      emitDone(projectRoot, message.id);
    }
  }
  chatSession.pendingAssistantLocalId = null;
  return { ok: true };
}

/** Reply to an OpenCode permission request so the session can continue. */
export async function replyPermission(
  projectRoot: string,
  permissionID: string,
  response: ChatPermissionResponse
): Promise<{ ok: boolean; error?: string }> {
  if (!client) return { ok: false, error: "OpenCode server is not connected." };
  const chatSession = sessions.get(projectRoot);
  if (!chatSession?.opencodeSessionId) {
    return { ok: false, error: "No active session for this permission." };
  }
  try {
    const result = await client.postSessionIdPermissionsPermissionId({
      path: { id: chatSession.opencodeSessionId, permissionID },
      query: { directory: projectRoot },
      body: { response },
    });
    if (result.error) return { ok: false, error: describeSdkError(result.error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Return the conversation history for a project (may be empty). */
export function history(projectRoot: string): ChatMessage[] {
  return sessions.get(projectRoot)?.messages ?? [];
}

/**
 * Reset a project's in-memory ChatSession to a fresh, empty conversation.
 * The previous conversation is NOT deleted from the database — it remains in
 * history and can be reloaded with `loadSession`. Only the in-memory working
 * state is replaced. The OpenCode server session id mapping is dropped so the
 * next `send()` lazily creates a new server-side session.
 */
function resetToFreshSession(projectRoot: string): void {
  const chatSession = sessions.get(projectRoot);
  if (chatSession?.opencodeSessionId) {
    sessionToProject.delete(chatSession.opencodeSessionId);
  }
  sessions.set(projectRoot, {
    opencodeSessionId: "",
    opencodeSessionVerified: false,
    sessionId: null,
    title: null,
    messages: [],
    pendingAssistantLocalId: null,
    opencodeToLocal: new Map(),
    ignoredOpencodeMessageIds: new Set(),
    assistantToUserMessageId: new Map(),
    assistantIdsWithObservedBusy: new Set(),
    pendingPartTextByMessageId: new Map(),
  });
  projectsWithSendInProgress.delete(projectRoot);
}

/**
 * Start a new conversation for a project. The current OpenCode server session
 * is deleted best-effort; the in-memory ChatSession is reset to empty. The
 * previous conversation (if any) stays in the SQLite history and remains
 * available via `loadSession` / `listSessions`.
 */
export async function newSession(
  projectRoot: string
): Promise<{ ok: boolean; error?: string }> {
  const chatSession = sessions.get(projectRoot);

  // If this project is actively streaming, stop the stream first so we don't
  // race with in-flight events for the session we're about to drop.
  if (activeStreamDirectory === projectRoot) {
    stopStream();
  }

  // Finalize any in-flight assistant message (with whatever streamed so far)
  // so the abandoned conversation doesn't retain a forever-pending bubble.
  if (chatSession) {
    finalizeInflightMessages(chatSession);
  }

  // Delete the server-side session best-effort. Failures (server gone, session
  // already removed) are non-fatal — we still reset locally.
  if (client && chatSession?.opencodeSessionId) {
    try {
      const result = await client.session.delete({
        path: { id: chatSession.opencodeSessionId },
      });
      if (result.error) {
        chatLog("newSession: session.delete returned error", {
          sessionId: chatSession.opencodeSessionId,
          error: describeSdkError(result.error),
        });
      }
    } catch (err) {
      chatLog("newSession: session.delete threw", {
        sessionId: chatSession.opencodeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  resetToFreshSession(projectRoot);
  return { ok: true };
}

/**
 * Clear the current conversation and start fresh. Equivalent to `newSession` —
 * kept for the existing `opencode:chat:clear` IPC channel. The previous
 * conversation remains in history.
 */
export async function clear(
  projectRoot: string
): Promise<{ ok: boolean; error?: string }> {
  return newSession(projectRoot);
}

// ---------------------------------------------------------------------------
// Session history (backed by SQLite persistence)
// ---------------------------------------------------------------------------

/** List persisted conversations for a project, most recently active first. */
export function listSessions(projectRoot: string): ChatSessionMeta[] {
  try {
    return persistence.listSessions(projectRoot);
  } catch (err) {
    chatLog("listSessions error", {
      projectRoot,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Load a persisted conversation into the active in-memory ChatSession for its
 * project and return its messages + metadata. Returns null if the session id
 * is unknown or belongs to a different project.
 *
 * Resume behavior: if the stored `opencodeSessionId` is non-empty, we try to
 * reuse it so the conversation continues with its server-side context intact.
 * When a client is attached we verify the id is still alive on the server via
 * `client.session.list`; when it is alive (or when the lookup fails
 * transiently) we register the id in `sessionToProject` so SSE events route
 * back to this project and the next `send()` continues the session. When the
 * id is confirmed dead we clear it (in memory and in the DB) and the next
 * `send()` will create a fresh server session. When no client is attached we
 * keep the stored id optimistically and mark it unverified; `send()` will
 * verify it lazily before the first prompt.
 */
export async function loadSession(
  projectRoot: string,
  sessionId: string
): Promise<{ messages: ChatMessage[]; meta: ChatSessionMeta } | null> {
  // Validate the session exists and belongs to this project before touching
  // any live state — a bad session id should not disrupt the current chat.
  let meta: ChatSessionMeta | null = null;
  try {
    meta = persistence.getSession(sessionId);
    if (!meta || meta.projectRoot !== projectRoot) return null;
  } catch (err) {
    chatLog("loadSession error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Stop the stream if it's active for this project — we're switching context.
  if (activeStreamDirectory === projectRoot) {
    stopStream();
  }

  // Finalize the currently-active conversation's in-flight messages so the DB
  // never retains a forever-pending bubble. This runs even when reloading the
  // same session: the stream was just stopped, so any in-flight assistant
  // message is now abandoned and should be settled with its partial content.
  const existing = sessions.get(projectRoot);
  if (existing) {
    finalizeInflightMessages(existing);
  }
  if (existing?.opencodeSessionId) {
    sessionToProject.delete(existing.opencodeSessionId);
  }

  // Fetch messages AFTER finalizing so a same-session reload picks up the
  // finalized (complete) state of any abandoned in-flight assistant message.
  let messages: ChatMessage[] = [];
  try {
    messages = persistence.getSessionMessages(sessionId);
  } catch (err) {
    chatLog("loadSession error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Determine whether the stored OpenCode server session can be resumed. We
  // restore the id from the DB meta and, when possible, verify it against the
  // live server. A transient lookup failure is treated as "unknown" so a
  // flaky network never discards resumable context — `send()` re-verifies.
  const storedOpencodeSessionId = meta.opencodeSessionId ?? "";
  let opencodeSessionId = storedOpencodeSessionId;
  let opencodeSessionVerified = false;

  if (opencodeSessionId) {
    if (client) {
      const status = await verifyOpencodeSession(projectRoot, opencodeSessionId);
      if (status === "dead") {
        chatLog("loaded opencode session is no longer alive; dropping stored id", {
          projectRoot,
          sessionId: meta.id,
          opencodeSessionId,
        });
        opencodeSessionId = "";
        opencodeSessionVerified = false;
        safePersist("loadSession:clear dead opencodeSessionId", () =>
          persistence.updateSessionMeta(meta!.id, { opencodeSessionId: null })
        );
      } else {
        // alive or unknown — keep the id and route events for it. send() will
        // re-verify only in the unknown case; alive is marked verified.
        opencodeSessionVerified = status === "alive";
        sessionToProject.set(opencodeSessionId, projectRoot);
      }
    } else {
      // No client attached yet: keep the id optimistically so the first send
      // after reconnect can resume. send() verifies before dispatching.
      sessionToProject.set(opencodeSessionId, projectRoot);
    }
  }

  sessions.set(projectRoot, {
    sessionId: meta.id,
    title: meta.title,
    opencodeSessionId,
    opencodeSessionVerified,
    messages,
    pendingAssistantLocalId: null,
    opencodeToLocal: new Map(),
    ignoredOpencodeMessageIds: new Set(),
    assistantToUserMessageId: new Map(),
    assistantIdsWithObservedBusy: new Set(),
    pendingPartTextByMessageId: new Map(),
  });
  projectsWithSendInProgress.delete(projectRoot);
  return { messages, meta };
}

/** Delete a persisted conversation (and its messages via cascade). */
export function deleteSession(sessionId: string): { ok: boolean; error?: string } {
  try {
    // If this session is the active one for some project, reset that project to
    // a fresh empty session so the UI doesn't keep showing deleted content.
    for (const [projectRoot, chatSession] of sessions) {
      if (chatSession.sessionId === sessionId) {
        if (activeStreamDirectory === projectRoot) stopStream();
        resetToFreshSession(projectRoot);
        break;
      }
    }
    persistence.deleteSession(sessionId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Rename a persisted conversation. Updates the active in-memory title too. */
export function renameSession(
  sessionId: string,
  title: string
): { ok: boolean; error?: string } {
  const trimmed = title.trim();
  if (!trimmed) return { ok: false, error: "Title cannot be empty." };
  try {
    persistence.updateSessionMeta(sessionId, { title: trimmed });
    for (const chatSession of sessions.values()) {
      if (chatSession.sessionId === sessionId) {
        chatSession.title = trimmed;
        break;
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(projectRoot: string): ChatSession {
  let s = sessions.get(projectRoot);
  if (!s) {
    s = {
      opencodeSessionId: "",
      opencodeSessionVerified: false,
      sessionId: null,
      title: null,
      messages: [],
      pendingAssistantLocalId: null,
      opencodeToLocal: new Map(),
      ignoredOpencodeMessageIds: new Set(),
      assistantToUserMessageId: new Map(),
      assistantIdsWithObservedBusy: new Set(),
      pendingPartTextByMessageId: new Map(),
    };
    sessions.set(projectRoot, s);
  }
  return s;
}

function hasInflightAssistantMessage(chatSession: ChatSession): boolean {
  return chatSession.messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
  );
}

function rememberIgnoredMessageId(chatSession: ChatSession, messageId: string): void {
  chatSession.ignoredOpencodeMessageIds.add(messageId);

  // Bound memory for long-lived projects. Once the cap is exceeded, evict the
  // oldest inserted IDs; these are only needed to protect against late user-part
  // events, and role-confirmed assistant messages are tracked separately.
  while (chatSession.ignoredOpencodeMessageIds.size > 200) {
    const oldest = chatSession.ignoredOpencodeMessageIds.values().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    chatSession.ignoredOpencodeMessageIds.delete(oldest);
  }
}

function rememberPendingPartText(
  chatSession: ChatSession,
  messageId: string,
  text: string
): void {
  chatSession.pendingPartTextByMessageId.set(messageId, text);

  while (chatSession.pendingPartTextByMessageId.size > 200) {
    const oldest = chatSession.pendingPartTextByMessageId.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    chatSession.pendingPartTextByMessageId.delete(oldest);
  }
}

/**
 * Extract a human-readable message from an SDK error. Most SDK error types
 * (BadRequest, NotFound, ProviderAuth, Unknown, MessageAborted, API) carry
 * `data.message`; we surface it so the user sees *why* the server rejected
 * the request, not just the error class name.
 */
function describeSdkError(error: { name: string; data?: unknown }): string {
  if (
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof (error.data as { message: unknown }).message === "string"
  ) {
    const msg = (error.data as { message: string }).message;
    if (msg) return `${error.name}: ${msg}`;
  }
  return error.name;
}

/**
 * Query the OpenCode server for available providers/models and pick a default.
 * Prefers providers that are authenticated (source = env/config). The result
 * is cached on the ChatSession so we only query once per server lifecycle.
 */
async function resolveDefaultModel(
  projectRoot: string
): Promise<{ providerID: string; modelID: string } | null> {
  if (!client) return null;
  try {
    const result = await client.config.providers({
      query: { directory: projectRoot },
    });
    if (!result.data) return null;

    // Prefer providers that are likely authenticated (env/config source).
    const providers = result.data.providers;
    const sorted = [...providers].sort((a, b) => {
      const score = (p: (typeof providers)[number]) =>
        p.source === "env" ? 0 : p.source === "config" ? 1 : 2;
      return score(a) - score(b);
    });

    for (const provider of sorted) {
      const models = Object.values(provider.models);
      if (models.length > 0) {
        return { providerID: models[0].providerID, modelID: models[0].id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolvePromptAgent(
  projectRoot: string,
  agentName: string | null
): Promise<string | null> {
  const trimmed = agentName?.trim();
  if (!trimmed) return null;
  if (!client) return trimmed;

  try {
    const result = await client.app.agents({ query: { directory: projectRoot } });
    const agent = result.data?.find((candidate) => candidate.name === trimmed);
    if (agent?.mode === "subagent") {
      chatLog("default agent ignored because it is subagent-only", {
        projectRoot,
        agent: trimmed,
        mode: agent.mode,
      });
      return null;
    }
  } catch {
    // If the agent list cannot be loaded, keep the saved value and let OpenCode
    // validate it. This preserves compatibility with custom/older configs.
  }

  return trimmed;
}

async function createOpencodeSession(
  projectRoot: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!client) return { ok: false, error: "No client." };
  try {
    const result = await client.session.create({
      query: { directory: projectRoot },
    });
    if (result.data) {
      return { ok: true, id: result.data.id };
    }
    return {
      ok: false,
      error: result.error ? describeSdkError(result.error) : "Failed to create session.",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check whether a stored OpenCode session id is still alive on the server.
 *
 * Uses `client.session.list` and tests membership by id. We prefer `list`
 * over `session.get` (which 404s on a dead id) because a single list call
 * also lets future code reason about all known sessions, and over
 * `session.status` (used by kodachi) because `list` returns a plain array
 * of `Session` objects whose `id` field is the stable identifier.
 *
 * Returns:
 * - `"alive"`  — the id is present in the server's session list.
 * - `"dead"`   — the list call succeeded but the id is not present.
 * - `"unknown"` — the client is missing or the list call errored. Callers
 *   must treat this as "proceed optimistically" so a transient failure
 *   never discards resumable context; `send()` will re-verify lazily.
 */
async function verifyOpencodeSession(
  projectRoot: string,
  opencodeSessionId: string
): Promise<"alive" | "dead" | "unknown"> {
  const c = client;
  if (!c) return "unknown";
  try {
    const result = await c.session.list({
      query: { directory: projectRoot },
    });
    // If the client was swapped (disconnect/reconnect) while we were
    // awaiting, the verdict reflects the old server and is no longer
    // meaningful. Return "unknown" so callers re-verify lazily.
    if (c !== client) {
      chatLog("verifyOpencodeSession: client changed during list", {
        projectRoot,
        opencodeSessionId,
      });
      return "unknown";
    }
    if (!result.data) {
      chatLog("verifyOpencodeSession: list returned no data", {
        projectRoot,
        opencodeSessionId,
        error: result.error ? describeSdkError(result.error as { name: string; data?: unknown }) : undefined,
      });
      return "unknown";
    }
    const found = result.data.some((session) => session.id === opencodeSessionId);
    return found ? "alive" : "dead";
  } catch (err) {
    chatLog("verifyOpencodeSession: list threw", {
      projectRoot,
      opencodeSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Part serialization
// ---------------------------------------------------------------------------

/**
 * Convert an SDK `Part` to a serializable `ChatPart` for IPC.
 * Returns null for parts that should not be displayed (synthetic/ignored text,
 * or unsupported part types).
 */
function serializePart(part: Part): ChatPart | null {
  switch (part.type) {
    case "text":
      if (part.synthetic || part.ignored) return null;
      return {
        id: part.id,
        type: "text",
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
      };
    case "reasoning":
      return { id: part.id, type: "reasoning", text: part.text };
    case "tool": {
      const s = part.state;
      const state: ChatToolState =
        s.status === "pending"
          ? { status: "pending", input: s.input }
          : s.status === "running"
            ? { status: "running", input: s.input, title: s.title }
            : s.status === "completed"
              ? { status: "completed", input: s.input, output: s.output, title: s.title }
              : { status: "error", input: s.input, error: s.error };
      return {
        id: part.id,
        type: "tool",
        tool: part.tool,
        callID: part.callID,
        state,
      };
    }
    case "subtask":
      return {
        id: part.id,
        type: "subtask",
        agent: part.agent,
        description: part.description,
        prompt: part.prompt,
      };
    case "step-start":
      return { id: part.id, type: "step-start" };
    case "step-finish":
      return { id: part.id, type: "step-finish", reason: part.reason };
    case "file":
      return {
        id: part.id,
        type: "file",
        mime: part.mime,
        filename: part.filename,
        url: part.url,
      };
    default:
      return null;
  }
}

function isVisibleChatPart(part: ChatPart): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.trim().length > 0;
    case "step-start":
    case "step-finish":
      return false;
    default:
      return true;
  }
}

function hasVisibleAssistantContent(
  value: AssistantContent | ChatMessage | null | undefined
): boolean {
  if (!value) return false;
  if (value.content.trim().length > 0) return true;
  return (value.parts ?? []).some(isVisibleChatPart);
}

function summarizeAssistantContent(
  value: AssistantContent | null | undefined
): Record<string, unknown> | null {
  if (!value) return null;
  return {
    complete: value.complete,
    contentLength: value.content.length,
    partTypes: value.parts.map((part) => part.type),
    visible: hasVisibleAssistantContent(value),
  };
}

function markAssistantError(
  chatSession: ChatSession,
  localId: string,
  error: string
): void {
  const message = chatSession.messages.find((m) => m.id === localId);
  if (!message) return;
  message.status = "error";
  message.error = error;
  persistMessageUpdate(chatSession, message);
  if (chatSession.pendingAssistantLocalId === localId) {
    chatSession.pendingAssistantLocalId = null;
  }
  chatSession.assistantToUserMessageId.delete(localId);
  chatSession.assistantIdsWithObservedBusy.delete(localId);
  emitError(chatSession, localId, error);
}

function markInflightMessagesError(chatSession: ChatSession, error: string): void {
  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      message.status = "error";
      message.error = error;
      persistMessageUpdate(chatSession, message);
      emitError(chatSession, message.id, error);
    }
  }
  chatSession.pendingAssistantLocalId = null;
  chatSession.pendingPartTextByMessageId.clear();
  chatSession.assistantIdsWithObservedBusy.clear();
}

function emitPart(
  chatSession: ChatSession,
  messageId: string,
  part: ChatPart,
  delta?: string
): void {
  const projectRoot = projectRootFor(chatSession);
  if (!projectRoot) return;
  broadcast?.("opencode:chat:part", { projectRoot, messageId, part, delta });
}

function emitDone(
  projectRoot: string,
  messageId: string,
  content?: string,
  parts?: ChatPart[]
): void {
  broadcast?.("opencode:chat:done", { projectRoot, messageId, content, parts });
}

function emitError(chatSession: ChatSession, messageId: string, error: string): void {
  const projectRoot = projectRootFor(chatSession);
  if (!projectRoot) return;
  broadcast?.("opencode:chat:error", { projectRoot, messageId, error });
}

function emitTokens(
  chatSession: ChatSession,
  messageId: string,
  tokens: ChatTokens
): void {
  const projectRoot = projectRootFor(chatSession);
  if (!projectRoot) return;
  broadcast?.("opencode:chat:tokens", { projectRoot, messageId, tokens });
}

function projectRootFor(chatSession: ChatSession): string | undefined {
  for (const [projectRoot, session] of sessions) {
    if (session === chatSession) return projectRoot;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

function startStream(projectRoot: string): Promise<void> {
  if (streamShouldRun && activeStreamDirectory === projectRoot) {
    return activeStreamReady ?? Promise.resolve();
  }
  if (streamShouldRun && activeStreamDirectory !== projectRoot) {
    // The stream is switching to a different project. Finalize any in-flight
    // assistant message in the previous project so it doesn't get orphaned as
    // a forever-pending bubble (its events will no longer arrive once we stop
    // the stream).
    const previousProject = activeStreamDirectory;
    stopStream();
    if (previousProject) {
      const previousSession = sessions.get(previousProject);
      if (previousSession) finalizeInflightMessages(previousSession);
    }
  }
  activeStreamDirectory = projectRoot;
  streamShouldRun = true;
  activeStreamReady = new Promise((resolve) => {
    resolveActiveStreamReady = resolve;
  });
  void consumeStream();
  return activeStreamReady;
}

function stopStream(): void {
  streamShouldRun = false;
  activeStreamDirectory = null;
  resolveActiveStreamReady?.();
  resolveActiveStreamReady = null;
  activeStreamReady = null;
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  if (activeStream) {
    activeStream.return(undefined).catch(() => {});
    activeStream = null;
  }
}

async function consumeStream(): Promise<void> {
  while (streamShouldRun && client) {
    const directory = activeStreamDirectory;
    if (!directory) break;
    let shouldBackoff = false;
    try {
      activeStreamAbort = new AbortController();
      const result = await client.event.subscribe({
        query: { directory },
        signal: activeStreamAbort.signal,
      });
      chatLog("event stream subscribed", { directory });
      if (!streamShouldRun) break;
      activeStream = result.stream;
      resolveActiveStreamReady?.();
      resolveActiveStreamReady = null;

      for await (const event of result.stream) {
        if (!streamShouldRun) break;
        handleEvent(event);
      }
    } catch {
      // Network error or stream closed — loop will retry if still active.
      resolveActiveStreamReady?.();
      resolveActiveStreamReady = null;
      shouldBackoff = true;
    } finally {
      activeStream = null;
      activeStreamAbort = null;
    }

    // Brief pause only after errors (avoids hot-looping on a dead server). When
    // the server closes a healthy SSE response, reconnect immediately so a
    // follow-up prompt sent right after a completed answer does not lose events.
    if (shouldBackoff && streamShouldRun && client) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function eventSessionId(event: Event): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.part.removed":
    case "session.status":
    case "session.idle":
    case "session.error":
    case "session.compacted":
    case "permission.replied":
      return event.properties.sessionID;
    case "permission.updated":
      return event.properties.sessionID;
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return event.properties.info.id;
    default:
      return undefined;
  }
}

function logRelevantEvent(event: Event): void {
  const sessionId = eventSessionId(event);
  if (!sessionId || !sessionToProject.has(sessionId)) return;

  switch (event.type) {
    case "session.status":
      chatLog("event session.status", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        status: event.properties.status,
      });
      break;
    case "session.idle":
      chatLog("event session.idle", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
      });
      break;
    case "session.error":
      chatLog("event session.error", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        error: event.properties.error,
      });
      break;
    case "message.updated":
      const info = event.properties.info;
      chatLog("event message.updated", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        messageId: info.id,
        role: info.role,
        completed: "completed" in info.time ? info.time.completed : undefined,
        hasError: "error" in info ? Boolean(info.error) : false,
      });
      break;
    case "message.part.updated":
      chatLog("event message.part.updated", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        messageId: event.properties.part.messageID,
        partId: event.properties.part.id,
        partType: event.properties.part.type,
        deltaLength: event.properties.delta?.length ?? 0,
      });
      break;
    case "permission.updated":
      chatLog("event permission.updated", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        permissionId: event.properties.id,
        messageId: event.properties.messageID,
        type: event.properties.type,
        title: event.properties.title,
      });
      break;
    case "permission.replied":
      chatLog("event permission.replied", {
        sessionId,
        projectRoot: sessionToProject.get(sessionId),
        permissionId: event.properties.permissionID,
        response: event.properties.response,
      });
      break;
  }
}

function handleEvent(event: Event): void {
  logRelevantEvent(event);
  switch (event.type) {
    case "message.part.updated":
      handlePartUpdated(event.properties.part, event.properties.delta);
      break;
    case "message.updated":
      handleMessageUpdated(event.properties.info);
      break;
    case "session.idle":
      void handleSessionIdle(event.properties.sessionID);
      break;
    case "session.status":
      handleSessionStatus(event.properties.sessionID, event.properties.status);
      break;
    case "session.error":
      handleSessionError(
        event.properties.sessionID,
        event.properties.error
      );
      break;
    case "permission.updated":
      handlePermissionUpdated(event.properties);
      break;
    case "permission.replied":
      handlePermissionReplied(
        event.properties.sessionID,
        event.properties.permissionID,
        event.properties.response as ChatPermissionResponse
      );
      break;
    // Other event types are not relevant to chat.
  }
}

function handleSessionStatus(
  sessionId: string | undefined,
  status: { type: string }
): void {
  if (!sessionId || status.type !== "busy") return;
  const projectRoot = sessionToProject.get(sessionId);
  if (!projectRoot) return;
  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      chatSession.assistantIdsWithObservedBusy.add(message.id);
    }
  }
}

function handlePermissionUpdated(permission: Permission): void {
  const projectRoot = sessionToProject.get(permission.sessionID);
  if (!projectRoot) return;
  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  let localId = chatSession.opencodeToLocal.get(permission.messageID);
  if (!localId && chatSession.pendingAssistantLocalId) {
    localId = chatSession.pendingAssistantLocalId;
    chatSession.opencodeToLocal.set(permission.messageID, localId);
    chatSession.pendingAssistantLocalId = null;
  } else if (!localId) {
    const recent = [...chatSession.messages].reverse().find(
      (m) =>
        m.role === "assistant" &&
        (m.status === "pending" || m.status === "streaming")
    );
    if (!recent) return;
    localId = recent.id;
    chatSession.opencodeToLocal.set(permission.messageID, localId);
  }

  const message = chatSession.messages.find((m) => m.id === localId);
  if (!message || message.status === "complete" || message.status === "error") return;
  const part: ChatPart = {
    id: `permission:${permission.id}`,
    type: "permission",
    permissionID: permission.id,
    permissionType: permission.type,
    title: permission.title,
    pattern: permission.pattern,
    metadata: permission.metadata,
    callID: permission.callID,
    status: "pending",
  };
  if (!message.parts) message.parts = [];
  const idx = message.parts.findIndex((p) => p.id === part.id);
  if (idx >= 0) message.parts[idx] = part;
  else message.parts.push(part);
  if (message.status === "pending") message.status = "streaming";
  persistMessageUpdate(chatSession, message);
  emitPart(chatSession, localId, part);
}

function handlePermissionReplied(
  sessionId: string,
  permissionID: string,
  response: ChatPermissionResponse
): void {
  const projectRoot = sessionToProject.get(sessionId);
  if (!projectRoot) return;
  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;
  for (const message of chatSession.messages) {
    const parts = message.parts;
    const idx = parts?.findIndex(
      (p) => p.type === "permission" && p.permissionID === permissionID
    ) ?? -1;
    if (!parts || idx < 0) continue;
    const current = parts[idx];
    if (current.type !== "permission") continue;
    const updated: ChatPart = {
      ...current,
      status: response === "reject" ? "rejected" : "approved",
      response,
    };
    parts[idx] = updated;
    persistMessageUpdate(chatSession, message);
    emitPart(chatSession, message.id, updated);
    return;
  }
  console.warn(
    `[opencode:chat] permission.replied for unknown permission ${permissionID} in session ${sessionId}`
  );
}

/**
 * Handle a part update event. This is the primary streaming event — it fires
 * for text parts (with incremental `delta`), tool parts (with state changes),
 * subtask parts, reasoning parts, step parts, and file parts.
 */
function handlePartUpdated(part: Part, delta: string | undefined): void {
  const projectRoot = sessionToProject.get(part.sessionID);
  if (!projectRoot) return;

  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  if (chatSession.ignoredOpencodeMessageIds.has(part.messageID)) return;

  let localId = chatSession.opencodeToLocal.get(part.messageID);

  if (!localId) {
    if (part.type === "text") {
      // Do not map unknown text parts to the pending assistant yet. User text
      // parts can arrive before their message.updated role confirmation, and the
      // server is not guaranteed to honor our supplied user messageID. Buffer full
      // text until message.updated confirms this OpenCode message is assistant.
      if (part.text) {
        rememberPendingPartText(chatSession, part.messageID, part.text);
      }
      return;
    }
    // Non-text parts (tool, subtask, reasoning, step, file) are always from
    // assistant messages — map to the pending assistant immediately.
    if (chatSession.pendingAssistantLocalId) {
      localId = chatSession.pendingAssistantLocalId;
      chatSession.opencodeToLocal.set(part.messageID, localId);
    } else {
      // Subsequent assistant message mid-turn — map to the most recent
      // pending/streaming assistant message.
      const recent = [...chatSession.messages].reverse().find(
        (m) =>
          m.role === "assistant" &&
          (m.status === "pending" || m.status === "streaming")
      );
      if (recent) {
        localId = recent.id;
        chatSession.opencodeToLocal.set(part.messageID, localId);
      } else {
        return;
      }
    }
  }

  const message = chatSession.messages.find((m) => m.id === localId);
  if (!message || message.status === "complete" || message.status === "error") {
    return;
  }

  // Serialize the part for IPC.
  const serialized = serializePart(part);
  if (!serialized) return;

  // Update the message's parts array (replace by ID or append).
  if (!message.parts) message.parts = [];
  const existingIdx = message.parts.findIndex((p) => p.id === serialized.id);
  if (existingIdx >= 0) {
    message.parts[existingIdx] = serialized;
  } else {
    message.parts.push(serialized);
  }

  if (message.status === "pending") {
    message.status = "streaming";
  }

  // For text parts, also update the content field (for simple display/fallback).
  if (part.type === "text") {
    if (delta) {
      message.content += delta;
    } else if (part.text && part.text.length > message.content.length) {
      message.content = part.text;
    }
  }

  // Emit the part event to the renderer (carries the delta for text/reasoning).
  emitPart(chatSession, localId, serialized, delta);
}

/** Handle message-level updates (completion, errors). */
function handleMessageUpdated(info: Message): void {
  const projectRoot = sessionToProject.get(info.sessionID);
  if (!projectRoot) return;

  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  if (info.role !== "assistant") {
    rememberIgnoredMessageId(chatSession, info.id);
    chatSession.pendingPartTextByMessageId.delete(info.id);

    // The server just announced the user message it created for our most recent
    // prompt (we no longer pass messageID to promptAsync). Associate this
    // OpenCode user message ID with the in-flight assistant bubble so the idle
    // handler can fetch canonical content for exactly this user turn.
    if (info.role === "user" && chatSession.pendingAssistantLocalId) {
      const pendingId = chatSession.pendingAssistantLocalId;
      const existing = chatSession.assistantToUserMessageId.get(pendingId);
      if (!existing) {
        chatSession.assistantToUserMessageId.set(pendingId, info.id);
        chatLog("user message id assigned", {
          projectRoot,
          sessionId: info.sessionID,
          assistantLocalId: pendingId,
          userMessageId: info.id,
        });
      }
    }
    return;
  }

  // Map on first encounter (in case message.updated arrives before part.updated).
  let localId = chatSession.opencodeToLocal.get(info.id);
  if (!localId && chatSession.pendingAssistantLocalId) {
    // First assistant message for this prompt.
    localId = chatSession.pendingAssistantLocalId;
    chatSession.opencodeToLocal.set(info.id, localId);
    chatSession.pendingAssistantLocalId = null;
  } else if (!localId) {
    // Subsequent assistant message mid-turn (e.g. tool-call message followed by
    // a separate text message). Map it to the same local assistant bubble so
    // the user sees one continuous response.
    const recent = [...chatSession.messages].reverse().find(
      (m) =>
        m.role === "assistant" &&
        (m.status === "pending" || m.status === "streaming")
    );
    if (recent) {
      localId = recent.id;
      chatSession.opencodeToLocal.set(info.id, localId);
    }
  }
  const bufferedText = chatSession.pendingPartTextByMessageId.get(info.id);
  chatSession.pendingPartTextByMessageId.delete(info.id);
  if (!localId) return;

  const message = chatSession.messages.find((m) => m.id === localId);
  if (!message || message.status === "complete" || message.status === "error") {
    return;
  }

  if (info.error) {
    if (info.error.name === "MessageAbortedError") {
      message.status = "complete";
      persistMessageUpdate(chatSession, message);
      if (chatSession.pendingAssistantLocalId === localId) {
        chatSession.pendingAssistantLocalId = null;
      }
      chatSession.assistantToUserMessageId.delete(localId);
      chatSession.assistantIdsWithObservedBusy.delete(localId);
      emitDone(projectRoot, localId);
      return;
    }

    const errorMsg = `Assistant error: ${info.error.name}`;
    message.status = "error";
    message.error = errorMsg;
    persistMessageUpdate(chatSession, message);
    if (chatSession.pendingAssistantLocalId === localId) {
      chatSession.pendingAssistantLocalId = null;
    }
    chatSession.assistantToUserMessageId.delete(localId);
    chatSession.assistantIdsWithObservedBusy.delete(localId);
    emitError(chatSession, localId, errorMsg);
    return;
  }

  if (bufferedText !== undefined) {
    if (bufferedText.length > message.content.length) {
      const newDelta = bufferedText.slice(message.content.length);
      message.content = bufferedText;
      if (message.status === "pending") {
        message.status = "streaming";
      }
      // Emit buffered text as a part event. We don't have the original part
      // ID, so use a derived one — the canonical fetch on idle will replace
      // this with the correct part.
      if (!message.parts) message.parts = [];
      const bufferedPart: ChatPart = {
        id: `${info.id}:buffered-text`,
        type: "text",
        text: bufferedText,
      };
      message.parts.push(bufferedPart);
      emitPart(chatSession, localId, bufferedPart, newDelta);
    }
  }

  // Update token usage for the assistant turn. AssistantMessage always
  // carries a `tokens` field; emit it so the renderer can display context size.
  if (info.tokens) {
    const tokens: ChatTokens = {
      input: info.tokens.input ?? 0,
      output: info.tokens.output ?? 0,
      reasoning: info.tokens.reasoning ?? 0,
      cache: {
        read: info.tokens.cache?.read ?? 0,
        write: info.tokens.cache?.write ?? 0,
      },
    };
    message.tokens = tokens;
    emitTokens(chatSession, localId, tokens);
  }

  // NOTE: Do NOT mark the message complete on info.time.completed here.
  // When tools/agents are involved, OpenCode emits multiple assistant messages
  // per turn (tool-call messages + a final text message). An intermediate
  // message completing does not mean the whole turn is done. The definitive
  // completion signal is `session.idle`, which triggers a canonical text fetch.
}

/**
 * Fetch the canonical assistant content for a session from the server. When
 * tools/agents are involved, streaming deltas may not capture the full text
 * (it may arrive in a separate assistant message after all tool calls
 * complete). This keeps rich non-text progress parts from the whole turn, but
 * uses only the latest assistant text message as the final answer — matching
 * opencode/kodachi's canonical "latest assistant response" pattern and
 * avoiding intermediate protocol text leaks.
 */
async function fetchAssistantContentAfterUser(
  sessionId: string,
  projectRoot: string,
  userMessageId: string
): Promise<AssistantContent | null> {
  if (!client) return null;
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
      query: { directory: projectRoot },
    });
    if (!result.data) return null;

    // Find the exact user prompt this local assistant bubble belongs to. This
    // prevents a delayed/stale session.idle from finalizing a follow-up prompt
    // before the server has produced any assistant response for it.
    const messages = result.data;
    let userIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].info.role === "user" && messages[i].info.id === userMessageId) {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return null;

    // Keep rich progress parts from the whole turn, but use only the latest
    // assistant text message as the final answer. Concatenating every assistant
    // text message after the user turn can leak intermediate/internal protocol
    // text from tool/agent orchestration into the visible reply.
    const nonTextParts: ChatPart[] = [];
    let latestTextParts: ChatPart[] = [];
    let latestText = "";
    const seenIds = new Set<string>();
    let sawAssistant = false;
    let allAssistantCompleted = true;
    for (let i = userIdx + 1; i < messages.length; i++) {
      const serverMessage = messages[i];
      const info = serverMessage.info;
      if (info.role === "user") break;
      if (info.role !== "assistant") continue;
      sawAssistant = true;
      if (!info.time.completed) {
        allAssistantCompleted = false;
      }

      const messageTextParts: ChatPart[] = [];
      let messageText = "";
      for (const part of serverMessage.parts) {
        const serialized = serializePart(part);
        if (!serialized) continue;
        if (serialized.type === "text") {
          messageTextParts.push(serialized);
          messageText += serialized.text;
          continue;
        }
        if (!seenIds.has(serialized.id)) {
          seenIds.add(serialized.id);
          nonTextParts.push(serialized);
        }
      }

      if (messageText.trim()) {
        latestText = messageText.trim();
        latestTextParts = messageTextParts;
      }
    }

    if (!sawAssistant) return null;
    return {
      content: latestText,
      parts: [...nonTextParts, ...latestTextParts],
      complete: allAssistantCompleted,
    };
  } catch {
    return null;
  }
}

function completeAssistantMessage(
  projectRoot: string,
  chatSession: ChatSession,
  message: ChatMessage,
  canonical: AssistantContent | null
): void {
  if (canonical) {
    const existingPermissionParts = (message.parts ?? []).filter(
      (part): part is Extract<ChatPart, { type: "permission" }> =>
        part.type === "permission"
    );
    // Apply the canonical content if it's more complete than what we streamed.
    if (canonical.content && canonical.content.length > message.content.length) {
      message.content = canonical.content;
    }
    // Replace streamed server parts with the canonical set, but keep permission
    // prompts/replies: OpenCode emits permissions as out-of-band events, so
    // they are not returned by session.messages().
    message.parts = [...canonical.parts, ...existingPermissionParts];
  }
  message.status = "complete";
  chatSession.assistantToUserMessageId.delete(message.id);
  chatSession.assistantIdsWithObservedBusy.delete(message.id);
  persistMessageUpdate(chatSession, message);
  emitDone(projectRoot, message.id, message.content, message.parts);
}

/**
 * Session went idle — the turn is complete. Fetch the canonical assistant
 * content + parts from the server (streaming may have missed text/parts when
 * tools/agents produced multiple assistant messages), apply them to the local
 * message, then mark complete.
 */
async function handleSessionIdle(sessionId: string): Promise<void> {
  const projectRoot = sessionToProject.get(sessionId);
  if (!projectRoot) return;

  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  // Capture the exact assistant bubble(s) that were in flight when this idle
  // event arrived. The canonical fetch below yields to the event loop; a user
  // can send a follow-up during that await. If we later complete every pending
  // assistant message, we can accidentally complete the new turn before its
  // streaming events arrive, causing those events to be ignored.
  const targetMessageIds = new Set(
    chatSession.messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          (message.status === "pending" || message.status === "streaming")
      )
      .map((message) => message.id)
  );
  const pendingAssistantLocalIdAtStart = chatSession.pendingAssistantLocalId;
  const pendingPartMessageIdsAtStart = new Set(chatSession.pendingPartTextByMessageId.keys());
  const completedTargetIds = new Set<string>();

  for (const messageId of targetMessageIds) {
    const message = chatSession.messages.find((candidate) => candidate.id === messageId);
    if (
      !message ||
      message.role !== "assistant" ||
      (message.status !== "pending" && message.status !== "streaming")
    ) {
      continue;
    }

    // Fetch canonical content for this exact local turn. The OpenCode server
    // can emit session.idle before session.messages() reflects the assistant
    // response (eventual consistency), so retry a few times when the session
    // was observed busy. A stale idle from a previous turn will find nothing
    // after the retries too, so we leave the bubble pending — a later
    // message.updated or session.idle will complete it.
    const userMessageId = chatSession.assistantToUserMessageId.get(message.id);
    const observedBusy = chatSession.assistantIdsWithObservedBusy.has(message.id);

    let canonical: AssistantContent | null = null;
    if (userMessageId) {
      const maxRetries = observedBusy ? 4 : 1;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        canonical = await fetchAssistantContentAfterUser(sessionId, projectRoot, userMessageId);
        if (canonical) break;
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    if (message.status !== "pending" && message.status !== "streaming") {
      continue;
    }
    const hasStreamedProgress = hasVisibleAssistantContent(message);

    if (!canonical && !hasStreamedProgress) {
      // No assistant content yet — leave the bubble pending. A stale idle from
      // a prior turn, or a slow server write, will be resolved by the next
      // message.updated / message.part.updated / session.idle event.
      chatLog("idle leaving pending (no canonical yet)", {
        projectRoot,
        sessionId,
        messageId: message.id,
        userMessageId,
        observedBusy,
      });
      continue;
    }
    if (canonical && !hasVisibleAssistantContent(canonical) && !hasStreamedProgress) {
      chatLog("idle skipped empty canonical", {
        projectRoot,
        sessionId,
        messageId: message.id,
        canonical: summarizeAssistantContent(canonical),
      });
      continue;
    }

    completeAssistantMessage(
      projectRoot,
      chatSession,
      message,
      hasVisibleAssistantContent(canonical) ? canonical : null
    );
    completedTargetIds.add(message.id);
  }

  if (
    chatSession.pendingAssistantLocalId === pendingAssistantLocalIdAtStart &&
    pendingAssistantLocalIdAtStart &&
    completedTargetIds.has(pendingAssistantLocalIdAtStart)
  ) {
    chatSession.pendingAssistantLocalId = null;
  }
  // Only remove buffered text that existed for this idle turn. A follow-up can
  // buffer text while the canonical fetch is in flight, and that text still
  // needs to be available when its message.updated event arrives.
  if (completedTargetIds.size > 0) {
    for (const messageId of pendingPartMessageIdsAtStart) {
      chatSession.pendingPartTextByMessageId.delete(messageId);
    }
  }
}

/** Session-level error — mark in-flight messages as errored. */
function handleSessionError(
  sessionId: string | undefined,
  error: unknown
): void {
  if (!sessionId) return;
  const projectRoot = sessionToProject.get(sessionId);
  if (!projectRoot) return;

  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;

  const errorMsg =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "name" in error
        ? String((error as { name: string }).name)
        : "Session error";

  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      message.status = "error";
      message.error = errorMsg;
      persistMessageUpdate(chatSession, message);
      emitError(chatSession, message.id, errorMsg);
    }
  }
  chatSession.pendingAssistantLocalId = null;
}
