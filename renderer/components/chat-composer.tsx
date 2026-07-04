"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  MessageCircle,
  Square,
  X,
  AlertCircle,
  Trash2,
  Terminal,
  Eye,
  FilePlus,
  Pencil,
  Search,
  Globe,
  GitBranch,
  ListChecks,
  List,
  HelpCircle,
  Wrench,
  Check,
  Loader2,
  ChevronDown,
  FileText,
  Brain,
  Info,
} from "lucide-react";
import { useOpencode } from "@/hooks/use-opencode";
import { useOpencodeChat } from "@/hooks/use-opencode-chat";
import { CHAT_PRESETS } from "@/lib/chat-presets";
import type { ChatMessage, ChatPart, ChatPermissionResponse } from "@/lib/opencode-types";
import type { LaraLensSettings } from "@/lib/settings-types";
import { cn } from "@/lib/utils";

// prompt-kit components
import {
  ChatContainerRoot,
  ChatContainerContent,
} from "@/components/ui/chat-container";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
} from "@/components/ui/prompt-input";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Markdown } from "@/components/ui/markdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ChatComposerProps {
  projectRoot: string | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Floating chat composer — a maximized bottom-center panel with live streaming
 * of tool calls, sub-agents, reasoning, and markdown text.
 *
 * Design follows the opencode chat UI: no avatars, user messages as
 * right-aligned bubbles, assistant messages as full-width stacked parts.
 */
export function ChatComposer({ projectRoot }: ChatComposerProps) {
  const { status } = useOpencode();
  const {
    messages,
    isStreaming,
    error,
    loading,
    send,
    abort,
    clear,
    replyPermission,
    dismissError,
  } = useOpencodeChat(projectRoot);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [settings, setSettings] = useState<LaraLensSettings | null>(null);

  const connected = status?.state === "connected";
  const enabled = connected && !!projectRoot;
  const hasStartedConversation = messages.length > 0 || isStreaming || submitting;

  // Load saved settings (default agent + model) for the header tooltip.
  useEffect(() => {
    if (!open) return;
    window.laralens.settings
      .get()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [open]);

  // Context size from the most recent assistant message that has token usage.
  const contextSize = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.tokens) {
        return m.tokens.input + (m.tokens.cache?.read ?? 0);
      }
    }
    return null;
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || submitting || !enabled) return;
    const text = input;
    setSubmitting(true);
    const sent = await send(text);
    setSubmitting(false);
    if (!sent) return;
    setInput("");
  }, [input, isStreaming, submitting, enabled, send]);

  const handlePreset = useCallback(
    (prompt: string) => {
      if (isStreaming || submitting) return;
      setInput(prompt);
    },
    [isStreaming, submitting]
  );

  // Disabled pill — render but greyed out.
  if (!enabled && !open) {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
        <button
          disabled
          title={
            !projectRoot
              ? "Scan a project to start chatting"
              : "Server is not connected"
          }
          className="flex h-11 items-center gap-2 rounded-full border border-[var(--chassis)] bg-[var(--optic)] px-5 text-sm text-[var(--etch)] opacity-50 cursor-not-allowed shadow-lg"
        >
          <MessageCircle className="h-4 w-4" />
          <span>Ask anything...</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "fixed z-50 left-1/2 -translate-x-1/2 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        open
          ? hasStartedConversation
            ? "bottom-4 h-[calc(100dvh-2rem)] w-[min(1100px,calc(100vw-2rem))]"
            : "bottom-4 h-[min(520px,calc(100dvh-2rem))] w-[min(820px,calc(100vw-2rem))]"
          : "bottom-4 h-11 w-auto"
      )}
    >
      {open ? (
        <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--chassis)] bg-[var(--optic)] shadow-2xl">
          {/* Minimal header — context + info (left), actions (right) */}
          <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
              {contextSize !== null && (
                <span className="text-[11px] tabular-nums text-[var(--etch)]">
                  {formatTokens(contextSize)} context
                </span>
              )}
              {settings && (settings.defaultAgent || settings.defaultModel) && (
                <span
                  title={[
                    settings.defaultModel
                      ? `Model: ${settings.defaultModel.providerID}/${settings.defaultModel.modelID}`
                      : "Model: OpenCode default",
                    settings.defaultAgent
                      ? `Agent: ${settings.defaultAgent}`
                      : "Agent: OpenCode default",
                  ].join("\n")}
                  className="inline-flex items-center text-[var(--etch)] opacity-70 transition-opacity hover:opacity-100"
                >
                  <Info className="h-3 w-3" />
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={clear}
                disabled={messages.length === 0 || isStreaming}
                title="Clear conversation"
                className="rounded p-1.5 text-[var(--etch)] transition-colors hover:bg-[var(--void)] hover:text-[var(--flare)] disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                className="rounded p-1.5 text-[var(--etch)] transition-colors hover:bg-[var(--void)] hover:text-[var(--flare)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Messages — ChatContainer with intelligent auto-scroll */}
          <ChatContainerRoot className="min-h-0 flex-1">
            <ChatContainerContent
              className={cn(
                "p-4 transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                hasStartedConversation ? "pb-80" : "pb-36"
              )}
            >
              {loading && messages.length === 0 ? (
                <div className="flex min-h-full flex-1 items-center justify-center py-8 text-[var(--etch)]">
                  <TextShimmer>Loading...</TextShimmer>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex min-h-full flex-1 items-center justify-center">
                  <EmptyState onPreset={handlePreset} />
                </div>
              ) : (
                <div key="messages" className="animate-chatfade-in flex flex-col gap-3">
                  {messages.map((msg) => (
                    <ChatMessageRow key={msg.id} message={msg} onReplyPermission={replyPermission} />
                  ))}
                </div>
              )}
            </ChatContainerContent>
          </ChatContainerRoot>

          {/* Floating input area */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4 pt-16 bg-gradient-to-t from-[var(--optic)] via-[var(--optic)]/95 to-transparent">
            {error && (
              <div className="pointer-events-auto mx-auto mb-3 flex max-w-3xl items-center gap-2 rounded-xl border border-[var(--destructive)]/25 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)] shadow-lg backdrop-blur">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate">{error}</span>
                <button
                  onClick={dismissError}
                  className="shrink-0 rounded p-0.5 hover:bg-[var(--destructive)]/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <PromptInput
              value={input}
              onValueChange={setInput}
              onSubmit={handleSend}
              isLoading={isStreaming}
              maxHeight={160}
              disabled={!enabled}
              className="pointer-events-auto mx-auto flex min-h-14 max-w-3xl items-end gap-3 rounded-[1.75rem] border-[var(--chassis)] bg-[var(--void)]/95 py-2 pl-5 pr-2 shadow-xl shadow-black/20 backdrop-blur supports-[backdrop-filter]:bg-[var(--void)]/80"
            >
              <PromptInputTextarea
                placeholder="Ask anything..."
                className="min-h-10 flex-1 overflow-y-auto px-0 py-2 leading-6 text-[var(--flare)] placeholder:text-[var(--etch)]"
              />
              <PromptInputActions className="ml-auto shrink-0">
                {isStreaming ? (
                  <PromptInputAction tooltip="Stop">
                    <button
                      onClick={abort}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--destructive)] text-white transition-colors hover:brightness-110"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                    </button>
                  </PromptInputAction>
                ) : (
                  <PromptInputAction tooltip="Send">
                    <button
                      onClick={handleSend}
                      disabled={!input.trim() || !enabled || submitting}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--aperture)] text-white transition-colors hover:brightness-110 disabled:opacity-30"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                  </PromptInputAction>
                )}
              </PromptInputActions>
            </PromptInput>
          </div>
        </div>
      ) : (
        /* Collapsed: pill button */
        <button
          onClick={() => setOpen(true)}
          title="Open chat"
          className="flex h-11 items-center gap-2 rounded-full bg-[var(--aperture)] px-5 text-sm text-white shadow-lg transition-all hover:brightness-110 hover:shadow-xl"
        >
          <MessageCircle className="h-4 w-4" />
          <span>Ask anything...</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onPreset }: { onPreset: (prompt: string) => void }) {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-6 py-8 text-center animate-chatfade-in">
      <h2 className="text-2xl font-semibold tracking-tight text-[var(--flare)]">
        Ask anything about this project.
      </h2>
      <div className="flex flex-wrap justify-center gap-2 max-w-lg">
        {CHAT_PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => onPreset(preset.prompt)}
            className="rounded-lg border border-[var(--chassis)] bg-[var(--void)] px-3 py-1.5 text-xs text-[var(--etch)] transition-colors hover:border-[var(--aperture)]/50 hover:text-[var(--flare)]"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message row — user bubble vs assistant full-width parts
// ---------------------------------------------------------------------------

function ChatMessageRow({
  message,
  onReplyPermission,
}: {
  message: ChatMessage;
  onReplyPermission: (permissionID: string, response: ChatPermissionResponse) => Promise<boolean>;
}) {
  if (message.role === "user") {
    return (
      <div className="mb-5 flex w-full flex-col items-end">
        <div className="max-w-[min(82%,64ch)]">
          <div className="rounded-[10px] bg-[var(--void)] px-3 py-2 text-sm text-[var(--flare)] whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  const visibleParts = (message.parts ?? []).filter(isRenderableChatPart);
  const showThinking =
    (message.status === "pending" || message.status === "streaming") &&
    !message.content &&
    visibleParts.length === 0;

  const hasVisibleParts = visibleParts.length > 0;

  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      {showThinking ? (
        <div className="flex min-h-[20px] items-center gap-2 rounded-md px-1 py-1 text-sm font-medium text-[var(--flare)]">
          <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
          <TextShimmer className="text-sm font-medium">Thinking...</TextShimmer>
        </div>
      ) : (
        <>
          {hasVisibleParts
            ? visibleParts.map((part, i) => (
                <AssistantPart
                  key={part.id}
                  part={part}
                  isStreaming={message.status === "streaming"}
                  isFirst={i === 0}
                  isLast={i === visibleParts.length - 1}
                  onReplyPermission={onReplyPermission}
                />
              ))
            : message.content && (
                <div className="mt-3 w-full">
                  <Markdown className="text-sm leading-relaxed text-[var(--flare)]">
                    {message.content}
                  </Markdown>
                </div>
              )}

          {/* Error display */}
          {message.status === "error" && message.error && (
            <div className="max-h-[240px] w-full overflow-y-auto break-words whitespace-pre-wrap rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
              {message.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function isRenderableChatPart(part: ChatPart): boolean {
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

// ---------------------------------------------------------------------------
// Assistant part rendering
// ---------------------------------------------------------------------------

function AssistantPart({
  part,
  isStreaming,
  isFirst,
  isLast,
  onReplyPermission,
}: {
  part: ChatPart;
  isStreaming: boolean;
  isFirst: boolean;
  isLast: boolean;
  onReplyPermission: (permissionID: string, response: ChatPermissionResponse) => Promise<boolean>;
}) {
  switch (part.type) {
    case "text":
      if (!part.text.trim()) return null;
      return (
        <div className={cn("w-full pl-1", !isFirst && "mt-3")}>
          <Markdown className="text-sm leading-relaxed text-[var(--flare)]">
            {part.text}
          </Markdown>
        </div>
      );

    case "reasoning":
      if (!part.text.trim()) return null;
      return <ReasoningPart part={part} isStreaming={isStreaming} isLast={isLast} />;

    case "tool":
      if (part.tool === "task") return <SubagentToolPart part={part} />;
      return <ToolCallPart part={part} />;

    case "permission":
      return <PermissionPart part={part} onReply={onReplyPermission} />;

    case "subtask":
      return (
        <div className="flex items-center gap-2 py-1 text-xs">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
          <span className="text-[var(--etch)]">subagent</span>
          <span className="font-medium text-[var(--flare)]">
            {part.agent}
          </span>
          {part.description && (
            <span className="truncate text-[var(--etch)]">
              {part.description}
            </span>
          )}
        </div>
      );

    case "step-start":
      return null;

    case "step-finish":
      return null;

    case "file":
      return (
        <a
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-[var(--chassis)] bg-[var(--void)] px-3 py-1.5 text-xs text-[var(--aperture)] transition-colors hover:border-[var(--aperture)]/50"
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{part.filename ?? part.url}</span>
        </a>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Reasoning part — collapsible, auto-open while streaming
// ---------------------------------------------------------------------------

function ReasoningPart({
  part,
  isStreaming,
  isLast,
}: {
  part: Extract<ChatPart, { type: "reasoning" }>;
  isStreaming: boolean;
  isLast: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  // A reasoning block is "still thinking" only while it's the last visible
  // part AND the overall message is still streaming. Once a text/tool part
  // arrives after it (or the message completes), the reasoning block is done
  // and we show "Thought for X seconds".
  const isReasoningStreaming = isStreaming && isLast;

  const startTimeRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  // Start the timer when reasoning streaming begins.
  useEffect(() => {
    if (isReasoningStreaming && startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }
  }, [isReasoningStreaming]);

  // Stop the timer and compute elapsed seconds when reasoning finishes.
  useEffect(() => {
    if (!isReasoningStreaming && startTimeRef.current !== null && elapsedSeconds === null) {
      const seconds = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000));
      setElapsedSeconds(seconds);
    }
  }, [isReasoningStreaming, elapsedSeconds]);

  const thoughtLabel =
    elapsedSeconds !== null
      ? `Thought for ${elapsedSeconds}s`
      : "Thought";

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="inline-flex items-center gap-2 rounded-md px-1 py-1 text-sm font-medium text-[var(--flare)] transition-colors hover:bg-[var(--void)]">
        <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
        {isReasoningStreaming ? (
          <TextShimmer className="text-sm font-medium">Thinking...</TextShimmer>
        ) : (
          <>
            <span>{thoughtLabel}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-[var(--etch)] transition-transform",
                !isOpen && "-rotate-90"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="mt-1.5 pl-1 text-[13px] leading-normal text-[var(--etch)]">
          <Markdown className="text-[var(--etch)]">{part.text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Tool call part — custom design matching opencode's BasicTool
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, typeof Wrench> = {
  bash: Terminal,
  read: Eye,
  write: FilePlus,
  edit: Pencil,
  glob: Search,
  grep: Search,
  list: List,
  webfetch: Globe,
  websearch: Globe,
  task: GitBranch,
  apply_patch: FileText,
  todowrite: ListChecks,
  question: HelpCircle,
};

function getToolIcon(tool: string): typeof Wrench {
  return TOOL_ICONS[tool] ?? Wrench;
}

function getToolSubtitle(part: Extract<ChatPart, { type: "tool" }>): string {
  const input = part.state.input ?? {};
  switch (part.tool) {
    case "bash": {
      const cmd =
        (input.command as string) || (input.description as string) || "";
      return truncateString(cmd, 80);
    }
    case "write": {
      const fp = (input.filePath as string) || "";
      const content = (input.content as string) ?? "";
      const lines = content.split("\n").length;
      const name = getFileName(fp);
      return name ? `${name} (${lines} lines)` : "";
    }
    case "edit": {
      const fp = (input.filePath as string) || "";
      const oldS = (input.oldString as string) ?? "";
      const newS = (input.newString as string) ?? "";
      const add = newS.split("\n").length;
      const del = oldS.split("\n").length;
      const name = getFileName(fp);
      return name ? `${name} (+${add}/-${del})` : "";
    }
    case "read": {
      const fp = (input.filePath as string) || (input.path as string) || "";
      return getFileName(fp) || fp;
    }
    case "glob": {
      return (input.pattern as string) || "";
    }
    case "grep": {
      return (input.pattern as string) || "";
    }
    case "webfetch": {
      return shortenUrl((input.url as string) || "");
    }
    case "websearch": {
      return (input.query as string) || "";
    }
    case "task": {
      const desc =
        (input.description as string) || (input.prompt as string) || "";
      const agent = (input.subagent_type as string) || "";
      return agent
        ? `[${agent}] ${truncateString(desc, 60)}`
        : truncateString(desc, 80);
    }
    case "apply_patch": {
      const patch = (input.patchText as string) ?? "";
      const files = patch.match(/^\*\*\* (?:Add|Update|Delete) File:/gm);
      return files ? `${files.length} files` : "";
    }
    case "list": {
      const fp = (input.filePath as string) || (input.path as string) || "";
      return getFileName(fp) || fp;
    }
    default: {
      const fp = (input.filePath as string) || (input.path as string) || "";
      return getFileName(fp) || fp;
    }
  }
}

function truncateString(s: string, max: number): string {
  const normalized = s.replace(/\n/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max) + "..." : normalized;
}

function getFileName(path: string): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

function PermissionPart({
  part,
  onReply,
}: {
  part: Extract<ChatPart, { type: "permission" }>;
  onReply: (permissionID: string, response: ChatPermissionResponse) => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState<ChatPermissionResponse | null>(null);
  const pending = part.status === "pending";
  const pattern = Array.isArray(part.pattern) ? part.pattern.join(", ") : part.pattern;

  const reply = async (response: ChatPermissionResponse) => {
    if (!pending || submitting) return;
    setSubmitting(response);
    try {
      await onReply(part.permissionID, response);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="w-full rounded-lg border border-[var(--aperture)]/40 bg-[var(--aperture)]/10 p-3 text-sm">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--aperture)]" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--flare)]">Permission required</div>
          <div className="mt-1 break-words text-xs text-[var(--etch)]">
            {part.title || part.permissionType}
            {pattern ? <span> · {pattern}</span> : null}
          </div>
        </div>
        {!pending && (
          <span className="text-xs text-[var(--etch)]">
            {part.status === "approved" ? "Approved" : "Rejected"}
          </span>
        )}
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          <button className="rounded-md bg-[var(--aperture)] px-2.5 py-1 text-xs text-white disabled:opacity-60" disabled={!!submitting} onClick={() => reply("once")}>Allow once</button>
          <button className="rounded-md border border-[var(--chassis)] px-2.5 py-1 text-xs text-[var(--flare)] disabled:opacity-60" disabled={!!submitting} onClick={() => reply("always")}>Always allow</button>
          <button className="rounded-md border border-[var(--destructive)]/40 px-2.5 py-1 text-xs text-[var(--destructive)] disabled:opacity-60" disabled={!!submitting} onClick={() => reply("reject")}>Deny</button>
        </div>
      )}
    </div>
  );
}

function SubagentToolPart({ part }: { part: Extract<ChatPart, { type: "tool" }> }) {
  const input = part.state.input ?? {};
  const agent = (input.subagent_type as string) || "subagent";
  const desc = ((input.description as string) || "Subagent task").trim();
  const prompt = (input.prompt as string) || "";
  const isActive = part.state.status === "pending" || part.state.status === "running";
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-sm transition-colors hover:bg-[var(--void)]">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
        {isActive ? <TextShimmer className="text-sm font-medium">Subagent</TextShimmer> : <span className="font-medium text-[var(--flare)]">Subagent</span>}
        <span className="text-sm text-[var(--etch)]">[{agent}] {truncateString(desc, 70)}</span>
        <ChevronDown className={cn("ml-auto h-3.5 w-3.5 shrink-0 text-[var(--etch)] transition-transform", !isOpen && "-rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="mt-1 space-y-2 rounded-md border border-[var(--chassis)] bg-[var(--void)] p-2 text-xs">
          {prompt && <div className="whitespace-pre-wrap text-[var(--etch)]"><span className="text-[var(--flare)]">Prompt:</span> {prompt}</div>}
          {part.state.status === "completed" && part.state.output && <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words text-[var(--flare)]">{part.state.output}</pre>}
          {part.state.status === "error" && <pre className="whitespace-pre-wrap break-words text-[var(--destructive)]">{part.state.error}</pre>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallPart({ part }: { part: Extract<ChatPart, { type: "tool" }> }) {
  const state = part.state;
  const Icon = getToolIcon(part.tool);
  const subtitle = getToolSubtitle(part);
  const isActive = state.status === "pending" || state.status === "running";
  const isError = state.status === "error";
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-sm transition-colors hover:bg-[var(--void)]">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {isActive ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--etch)]" />
          ) : state.status === "completed" ? (
            <Check className="h-3.5 w-3.5 text-[var(--etch)]" />
          ) : isError ? (
            <X className="h-3.5 w-3.5 text-[var(--destructive)]" />
          ) : (
            <Icon className="h-3.5 w-3.5 text-[var(--etch)]" />
          )}
        </span>
        {isActive ? (
          <TextShimmer className="text-sm font-medium capitalize">
            {part.tool}
          </TextShimmer>
        ) : (
          <span
            className={cn(
              "text-sm font-medium capitalize",
              isError
                ? "text-[var(--destructive)]"
                : "text-[var(--flare)]"
            )}
          >
            {part.tool}
          </span>
        )}
        {subtitle && (
          <span className="truncate text-sm text-[var(--etch)]">
            {subtitle}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-[var(--etch)] transition-transform",
            !isOpen && "-rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="mt-1 max-h-[240px] overflow-y-auto rounded-md border border-[var(--chassis)] bg-[var(--void)] p-2">
          {state.status === "completed" && state.output && (
            <pre className="break-words whitespace-pre-wrap font-mono text-xs text-[var(--flare)]">
              {state.output}
            </pre>
          )}
          {isError && state.error && (
            <pre className="break-words whitespace-pre-wrap font-mono text-xs text-[var(--destructive)]">
              {state.error}
            </pre>
          )}
          {isActive && state.input && Object.keys(state.input).length > 0 && (
            <pre className="break-words whitespace-pre-wrap font-mono text-xs text-[var(--etch)]">
              {JSON.stringify(state.input, null, 2)}
            </pre>
          )}
          {isActive && !state.input && (
            <div className="text-xs text-[var(--etch)]">
              {state.status === "running" ? "Running..." : "Pending..."}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
