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
 * - `promptAsync` returns 204 immediately (no message ID), so we generate a
 *   local UUID for the assistant message upfront.
 * - On the first `message.part.updated` / `message.updated` event for the
 *   new assistant message, we map the OpenCode message ID → local UUID.
 */

import { randomUUID } from "node:crypto";
import type { OpencodeClient, Event, Part, Message } from "@opencode-ai/sdk";
import type { ChatMessage, ChatPart, ChatToolState } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatSession {
  /** OpenCode session ID (empty string = not yet created / invalidated). */
  opencodeSessionId: string;
  /** Local conversation history (user + assistant messages interleaved). */
  messages: ChatMessage[];
  /** Local UUID of the assistant message we're waiting to stream (pre-mapping). */
  pendingAssistantLocalId: string | null;
  /** OpenCode message ID → local ChatMessage.id mapping. */
  opencodeToLocal: Map<string, string>;
  /** OpenCode message IDs known not to be assistant responses (usually user messages). */
  ignoredOpencodeMessageIds: Set<string>;
  /** Full text for text parts that arrived before message.updated confirmed role. */
  pendingPartTextByMessageId: Map<string, string>;
  /** Resolved default model (cached after first successful provider lookup). */
  resolvedModel?: { providerID: string; modelID: string };
}

type Broadcaster = (channel: string, payload: unknown) => void;

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
      session.opencodeToLocal.clear();
      session.ignoredOpencodeMessageIds.clear();
      session.pendingPartTextByMessageId.clear();
      session.pendingAssistantLocalId = null;
      delete session.resolvedModel;
    }
    sessionToProject.clear();
    projectsWithSendInProgress.clear();
  } else {
    startStream();
  }
}

/** Clear all state — called on app quit. */
export function dispose(): void {
  stopStream();
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
): Promise<{ ok: boolean; assistantMessageId?: string; error?: string }> {
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

  // Ensure we have an OpenCode session.
  if (!chatSession.opencodeSessionId) {
    const created = await createOpencodeSession(projectRoot);
    if (!created.ok) {
      projectsWithSendInProgress.delete(projectRoot);
      return { ok: false, error: created.error };
    }
    chatSession.opencodeSessionId = created.id;
    sessionToProject.set(created.id, projectRoot);
  }

  const sessionId = chatSession.opencodeSessionId;
  const now = Date.now();

  // User message.
  // The OpenCode server requires messageID to start with "msg" (its internal ID
  // convention); a bare UUID is rejected with BadRequest kind:Payload.
  const opencodeUserMessageId = `msg_${randomUUID()}`;
  rememberIgnoredMessageId(chatSession, opencodeUserMessageId);
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

  // Fire the async prompt in the background. Returning immediately lets the
  // renderer append the user + pending assistant messages right away, so
  // follow-up prompts visibly start processing even if promptAsync dispatch is
  // slow or the server performs initial work before returning 204.
  startStream();
  void dispatchPromptAsync(
    projectRoot,
    sessionId,
    chatSession,
    assistantLocalId,
    opencodeUserMessageId,
    promptText
  );

  return { ok: true, assistantMessageId: assistantLocalId };
}

async function dispatchPromptAsync(
  projectRoot: string,
  sessionId: string,
  chatSession: ChatSession,
  assistantLocalId: string,
  opencodeUserMessageId: string,
  promptText: string
): Promise<void> {
  try {
    if (!client) {
      markAssistantError(chatSession, assistantLocalId, "OpenCode server is not connected.");
      return;
    }

    // Resolve a model if we haven't cached one yet. The OpenCode server
    // returns BadRequest when no model is configured AND none is passed.
    if (!chatSession.resolvedModel) {
      const model = await resolveDefaultModel(projectRoot);
      if (model) {
        chatSession.resolvedModel = model;
      }
    }

    const result = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        messageID: opencodeUserMessageId,
        parts: [{ type: "text", text: promptText }],
        ...(chatSession.resolvedModel
          ? { model: chatSession.resolvedModel }
          : {}),
      },
      query: { directory: projectRoot },
    });
    if (result.error) {
      const msg = `Prompt failed: ${describeSdkError(result.error)}`;
      console.error("[opencode:chat] promptAsync rejected:", result.error);
      markAssistantError(chatSession, assistantLocalId, msg);
    }
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
      emitDone(projectRoot, message.id);
    }
  }
  chatSession.pendingAssistantLocalId = null;
  return { ok: true };
}

/** Return the conversation history for a project (may be empty). */
export function history(projectRoot: string): ChatMessage[] {
  return sessions.get(projectRoot)?.messages ?? [];
}

/** Clear the conversation history for a project (keeps the OpenCode session). */
export function clear(projectRoot: string): void {
  const chatSession = sessions.get(projectRoot);
  if (!chatSession) return;
  chatSession.messages = [];
  chatSession.pendingAssistantLocalId = null;
  chatSession.opencodeToLocal.clear();
  chatSession.ignoredOpencodeMessageIds.clear();
  chatSession.pendingPartTextByMessageId.clear();
  delete chatSession.resolvedModel;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(projectRoot: string): ChatSession {
  let s = sessions.get(projectRoot);
  if (!s) {
    s = {
      opencodeSessionId: "",
      messages: [],
      pendingAssistantLocalId: null,
      opencodeToLocal: new Map(),
      ignoredOpencodeMessageIds: new Set(),
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

function markAssistantError(
  chatSession: ChatSession,
  localId: string,
  error: string
): void {
  const message = chatSession.messages.find((m) => m.id === localId);
  if (!message) return;
  message.status = "error";
  message.error = error;
  chatSession.pendingAssistantLocalId = null;
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
      emitError(chatSession, message.id, error);
    }
  }
  chatSession.pendingAssistantLocalId = null;
  chatSession.pendingPartTextByMessageId.clear();
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

function projectRootFor(chatSession: ChatSession): string | undefined {
  for (const [projectRoot, session] of sessions) {
    if (session === chatSession) return projectRoot;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

function startStream(): void {
  if (streamShouldRun) return;
  streamShouldRun = true;
  void consumeStream();
}

function stopStream(): void {
  streamShouldRun = false;
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  if (activeStream) {
    activeStream.return(undefined).catch(() => {});
    activeStream = null;
  }
}

async function consumeStream(): Promise<void> {
  while (streamShouldRun && client) {
    try {
      activeStreamAbort = new AbortController();
      const result = await client.event.subscribe({
        signal: activeStreamAbort.signal,
      });
      if (!streamShouldRun) break;
      activeStream = result.stream;

      for await (const event of result.stream) {
        if (!streamShouldRun) break;
        handleEvent(event);
      }
    } catch {
      // Network error or stream closed — loop will retry if still active.
    } finally {
      activeStream = null;
      activeStreamAbort = null;
    }

    // Brief pause before reconnecting (avoids hot-looping on a dead server).
    if (streamShouldRun && client) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function handleEvent(event: Event): void {
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
    case "session.error":
      handleSessionError(
        event.properties.sessionID,
        event.properties.error
      );
      break;
    // Other event types are not relevant to chat.
  }
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
      emitDone(projectRoot, localId);
      return;
    }

    const errorMsg = `Assistant error: ${info.error.name}`;
    message.status = "error";
    message.error = errorMsg;
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
async function fetchLatestAssistantContent(
  sessionId: string,
  projectRoot: string
): Promise<{ content: string; parts: ChatPart[] } | null> {
  if (!client) return null;
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
      query: { directory: projectRoot },
    });
    if (!result.data) return null;

    // Find the index of the last user message — everything after it is the
    // current turn's assistant response(s).
    const messages = result.data;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    // Keep rich progress parts from the whole turn, but use only the latest
    // assistant text message as the final answer. Concatenating every assistant
    // text message after the user turn can leak intermediate/internal protocol
    // text from tool/agent orchestration into the visible reply.
    const nonTextParts: ChatPart[] = [];
    let latestTextParts: ChatPart[] = [];
    let latestText = "";
    const seenIds = new Set<string>();
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      if (messages[i].info.role !== "assistant") continue;

      const messageTextParts: ChatPart[] = [];
      let messageText = "";
      for (const part of messages[i].parts) {
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

    return { content: latestText, parts: [...nonTextParts, ...latestTextParts] };
  } catch {
    return null;
  }
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

  // Fetch the canonical content + parts. This is the source of truth — even
  // if we missed every streaming event, this gives us the complete response.
  const canonical = await fetchLatestAssistantContent(sessionId, projectRoot);

  for (const message of chatSession.messages) {
    if (
      message.role === "assistant" &&
      (message.status === "pending" || message.status === "streaming")
    ) {
      if (canonical) {
        // Apply the canonical content if it's more complete than what we streamed.
        if (canonical.content && canonical.content.length > message.content.length) {
          message.content = canonical.content;
        }
        // Replace parts with the canonical set (handles missed streaming events).
        message.parts = canonical.parts;
      }
      message.status = "complete";
      emitDone(projectRoot, message.id, message.content, message.parts);
    }
  }
  chatSession.pendingAssistantLocalId = null;
  chatSession.pendingPartTextByMessageId.clear();
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
      emitError(chatSession, message.id, errorMsg);
    }
  }
  chatSession.pendingAssistantLocalId = null;
}
