"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatPart, ChatPermissionResponse, ChatSessionMeta } from "@/lib/opencode-types";

/**
 * React hook for the OpenCode chat subsystem.
 *
 * Manages per-project conversation state in the renderer:
 * - Loads the persisted session list for the project when it changes, and
 *   auto-loads the most recent conversation (if any) so past chats survive
 *   restarts.
 * - Subscribes to `opencode:chat:part` / `done` / `error` push events to
 *   update messages in real time as the assistant streams.
 * - Exposes `send`, `abort`, `startNewSession`, `loadSessionById`,
 *   `deleteSessionById`, `renameSessionById`, and `replyPermission`.
 *
 * Streaming state (`isStreaming`) is derived from the messages array —
 * true when any assistant message is `pending` or `streaming`.
 */
export function useOpencodeChat(projectRoot: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const projectRootRef = useRef<string | null>(projectRoot);
  const messagesRef = useRef<ChatMessage[]>(messages);

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Refresh the persisted session list for the current project. Used after
  // sends, deletes, renames, and loads so the sidebar stays in sync. Returns
  // the fetched list so callers can act on it without a second round-trip.
  const refreshSessions = useCallback(
    async (root: string): Promise<ChatSessionMeta[]> => {
      try {
        const list = await window.opencode.chat.listSessions(root);
        setSessions(list);
        return list;
      } catch {
        setSessions([]);
        return [];
      }
    },
    []
  );

  // Load the session list + most recent conversation when the project root
  // changes. Auto-restores the last active conversation so chats survive
  // restarts; if there are no past sessions, starts with an empty chat.
  useEffect(() => {
    if (!projectRoot) {
      setMessages([]);
      setSessions([]);
      setActiveSessionId(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const list = await window.opencode.chat.listSessions(projectRoot);
        if (cancelled) return;
        setSessions(list);
        if (list.length > 0) {
          const mostRecent = list[0];
          const result = await window.opencode.chat.loadSession(projectRoot, mostRecent.id);
          if (cancelled) return;
          if (result.ok) {
            setMessages(result.messages);
            setActiveSessionId(result.meta.id);
          } else {
            setMessages([]);
            setActiveSessionId(null);
          }
        } else {
          setMessages([]);
          setActiveSessionId(null);
        }
      } catch {
        if (!cancelled) {
          setMessages([]);
          setSessions([]);
          setActiveSessionId(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  // Subscribe to streaming events for the lifetime of the hook.
  useEffect(() => {
    const offPart = window.opencode.chat.onPart(({ projectRoot, messageId, part, delta }) => {
      if (projectRoot !== projectRootRef.current) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          if (m.status === "complete" || m.status === "error") return m;

          // Update the parts array (replace by ID or append).
          const parts = m.parts ? [...m.parts] : [];
          const idx = parts.findIndex((p) => p.id === part.id);
          if (idx >= 0) {
            parts[idx] = part;
          } else {
            parts.push(part);
          }

          // For text parts, append delta to content (for simple display).
          let content = m.content;
          if (part.type === "text") {
            if (delta) {
              content += delta;
            } else if (part.text && part.text.length > content.length) {
              content = part.text;
            }
          }

          return {
            ...m,
            parts,
            content,
            status: m.status === "pending" ? "streaming" : m.status,
          };
        })
      );
    });

    const offDone = window.opencode.chat.onDone(({ projectRoot, messageId, content, parts }) => {
      if (projectRoot !== projectRootRef.current) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: "complete",
                content: content ?? m.content,
                parts: parts ?? m.parts,
              }
            : m
        )
      );
    });

    const offError = window.opencode.chat.onError(({ projectRoot, messageId, error: msg }) => {
      if (projectRoot !== projectRootRef.current) return;
      if (!messagesRef.current.some((m) => m.id === messageId)) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, status: "error", error: msg } : m
        )
      );
      setError(msg);
    });

    const offTokens = window.opencode.chat.onTokens(({ projectRoot, messageId, tokens }) => {
      if (projectRoot !== projectRootRef.current) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          // A turn can produce multiple assistant messages (e.g. tool calls +
          // a final text message) that all map to this one local bubble. Each
          // emits its own tokens event, and intermediate ones can carry zeroed
          // counts. Merge so a non-zero count is never overwritten by a later
          // zero — that's what made the context size flicker to 0.
          const prevTokens = m.tokens;
          if (!prevTokens) return { ...m, tokens };
          return {
            ...m,
            tokens: {
              input: tokens.input || prevTokens.input,
              output: tokens.output || prevTokens.output,
              reasoning: tokens.reasoning || prevTokens.reasoning,
              cache: {
                read: tokens.cache?.read || prevTokens.cache?.read || 0,
                write: tokens.cache?.write || prevTokens.cache?.write || 0,
              },
            },
          };
        })
      );
    });

    return () => {
      offPart();
      offDone();
      offError();
      offTokens();
    };
  }, []);

  const isStreaming = useMemo(
    () =>
      messages.some(
        (m) => m.role === "assistant" && (m.status === "pending" || m.status === "streaming")
      ),
    [messages]
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const prompt = text.trim();
      if (!projectRoot || !prompt) return false;
      setError(null);

      let result: Awaited<ReturnType<typeof window.opencode.chat.send>>;
      try {
        result = await window.opencode.chat.send(projectRoot, prompt);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send message.");
        return false;
      }
      if (!result.ok || !result.assistantMessageId) {
        setError(result.error ?? "Failed to send message.");
        return false;
      }

      // Add user + pending assistant messages locally for immediate UX.
      const now = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          content: prompt,
          createdAt: now,
          status: "complete" as const,
        },
        {
          id: result.assistantMessageId!,
          role: "assistant" as const,
          content: "",
          parts: [],
          createdAt: now,
          status: "pending" as const,
        },
      ]);

      // If this was the first message of a new conversation, the main process
      // created a DB session row — track it and refresh the sidebar so the new
      // conversation (with its auto-generated title) appears at the top.
      if (result.sessionId && result.sessionId !== activeSessionId) {
        setActiveSessionId(result.sessionId);
        void refreshSessions(projectRoot);
      }

      return true;
    },
    [projectRoot, activeSessionId, refreshSessions]
  );

  const abort = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    try {
      const result = await window.opencode.chat.abort(projectRoot);
      if (!result.ok) setError(result.error ?? "Failed to abort message.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to abort message.");
    }
  }, [projectRoot]);

  /**
   * Start a fresh, empty conversation. The current conversation is archived to
   * history (it was persisted incrementally as messages settled) and can be
   * reloaded from the sidebar.
   */
  const startNewSession = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    try {
      await window.opencode.chat.newSession(projectRoot);
      setMessages([]);
      setActiveSessionId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start a new conversation.");
    }
  }, [projectRoot]);

  /** Alias for `startNewSession`, kept for the existing chat-composer usage. */
  const clear = useCallback(async (): Promise<void> => {
    return startNewSession();
  }, [startNewSession]);

  /** Load a specific past conversation by id. No-op if it's already active. */
  const loadSessionById = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!projectRoot) return;
      if (sessionId === activeSessionId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await window.opencode.chat.loadSession(projectRoot, sessionId);
        if (result.ok) {
          setMessages(result.messages);
          setActiveSessionId(result.meta.id);
        } else {
          setError(result.error ?? "Failed to load conversation.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load conversation.");
      } finally {
        setLoading(false);
      }
    },
    [projectRoot, activeSessionId]
  );

  /** Delete a past conversation. If it's the active one, reset to empty. */
  const deleteSessionById = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!sessionId) return;
      try {
        const result = await window.opencode.chat.deleteSession(sessionId);
        if (!result.ok) {
          setError(result.error ?? "Failed to delete conversation.");
          return;
        }
        if (sessionId === activeSessionId) {
          setMessages([]);
          setActiveSessionId(null);
        }
        if (projectRoot) await refreshSessions(projectRoot);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete conversation.");
      }
    },
    [activeSessionId, projectRoot, refreshSessions]
  );

  /** Rename a conversation. Updates the local list on success. */
  const renameSessionById = useCallback(
    async (sessionId: string, title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!trimmed) return false;
      try {
        const result = await window.opencode.chat.renameSession(sessionId, trimmed);
        if (!result.ok) {
          setError(result.error ?? "Failed to rename conversation.");
          return false;
        }
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s))
        );
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename conversation.");
        return false;
      }
    },
    []
  );

  const replyPermission = useCallback(
    async (permissionID: string, response: ChatPermissionResponse): Promise<boolean> => {
      if (!projectRoot) return false;
      const result = await window.opencode.chat.replyPermission(projectRoot, permissionID, response);
      if (!result.ok) {
        setError(result.error ?? "Failed to reply to permission request.");
        return false;
      }
      return true;
    },
    [projectRoot]
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    messages,
    isStreaming,
    error,
    loading,
    sessions,
    activeSessionId,
    activeSession,
    send,
    abort,
    clear,
    startNewSession,
    loadSessionById,
    deleteSessionById,
    renameSessionById,
    replyPermission,
    dismissError,
  };
}
