"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatPart, ChatPermissionResponse } from "@/lib/opencode-types";

/**
 * React hook for the OpenCode chat subsystem.
 *
 * Manages per-project conversation state in the renderer:
 * - Loads history from the main process when the project root changes.
 * - Subscribes to `opencode:chat:part` / `done` / `error` push events
 *   to update messages in real time as the assistant streams.
 * - Exposes `send`, `abort`, and `clear` actions.
 *
 * Streaming state (`isStreaming`) is derived from the messages array —
 * true when any assistant message is `pending` or `streaming`.
 */
export function useOpencodeChat(projectRoot: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const projectRootRef = useRef<string | null>(projectRoot);
  const messagesRef = useRef<ChatMessage[]>(messages);

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Load history when the project root changes.
  useEffect(() => {
    if (!projectRoot) {
      setMessages([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    window.opencode.chat
      .history(projectRoot)
      .then((history) => {
        if (!cancelled) {
          setMessages(history);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

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
        prev.map((m) => (m.id === messageId ? { ...m, tokens } : m))
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
      return true;
    },
    [projectRoot]
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

  const clear = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    await window.opencode.chat.clear(projectRoot);
    setMessages([]);
    setError(null);
  }, [projectRoot]);

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

  return { messages, isStreaming, error, loading, send, abort, clear, replyPermission, dismissError };
}
