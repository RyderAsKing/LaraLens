"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, MessageSquare, Plus, X } from "lucide-react";
import type { ChatSessionMeta } from "@/lib/opencode-types";
import { cn } from "@/lib/utils";

interface ThreadManagerProps {
  sessions: ChatSessionMeta[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onClose: () => void;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDayLabel(ts: number): string {
  const todayStart = startOfDay(Date.now());
  const dayStart = startOfDay(ts);
  const diffDays = Math.round((todayStart - dayStart) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const d = new Date(ts);
  const now = new Date();
  const monthName = d.toLocaleDateString(undefined, { month: "long" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${monthName} ${ordinal(d.getDate())}`
    : `${monthName} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
}

interface ThreadCardProps {
  session: ChatSessionMeta;
  index: number;
  isActive: boolean;
  onSelect: (sessionId: string) => void;
}

function ThreadCard({
  session,
  index,
  isActive,
  onSelect,
}: ThreadCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open conversation: ${session.title || "Untitled conversation"}`}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
      style={{
        animationDelay: `${Math.min(index, 12) * 45}ms`,
      }}
      className={cn(
        "animate-thread-card-in relative flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aperture)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--optic)]",
        isActive
          ? "border-[var(--aperture)]/60"
          : "border-[var(--chassis)]",
      )}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-[var(--etch)]" />
      <h3
        className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--flare)]"
        title={session.title || "Untitled conversation"}
      >
        {(session.title || "Untitled conversation").slice(0, 32)}
      </h3>
      <span className="inline-flex shrink-0 items-center text-[11px] tabular-nums text-[var(--etch)]">
        <Clock className="mr-1.5 h-3 w-3" />
        {formatRelativeTime(session.lastActiveAt)}
      </span>
    </div>
  );
}

interface DayGroup {
  key: string;
  label: string;
  sessions: { session: ChatSessionMeta; index: number }[];
}

export function ThreadManager({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onClose,
}: ThreadManagerProps) {
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Play a fade-out, then hand off to the real exit callback. Used for
  // every exit path (select, new, close, Escape) so the manager always
  // animates out instead of vanishing instantly.
  const closeWithFade = useCallback(
    (onDone: () => void) => {
      if (closing) return;
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      setClosing(true);
      closeTimerRef.current = setTimeout(onDone, 170);
    },
    [closing],
  );

  // Clear any pending close timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Escape closes the manager (with fade).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeWithFade(onClose);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeWithFade]);

  // Sort newest-first, then group by calendar day. Each card carries a
  // global index so the entrance-stagger stays continuous across groups.
  const grouped = useMemo<DayGroup[]>(() => {
    const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const groups: DayGroup[] = [];
    let idx = 0;
    for (const session of sorted) {
      const key = dayKey(session.lastActiveAt);
      const last = groups[groups.length - 1];
      if (!last || last.key !== key) {
        groups.push({
          key,
          label: formatDayLabel(session.lastActiveAt),
          sessions: [],
        });
      }
      groups[groups.length - 1].sessions.push({ session, index: idx++ });
    }
    return groups;
  }, [sessions]);

  return (
    <div
      className={cn(
        "absolute inset-0 z-30 flex flex-col bg-[var(--optic)]",
        closing
          ? "animate-thread-manager-fade-out"
          : "animate-thread-manager-backdrop-in",
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Conversation history"
    >
      {/* Panel — fills the card, content scales in from within. */}
      <div className="animate-thread-manager-panel-in relative z-10 flex h-full w-full flex-col px-5 py-6 sm:px-8 sm:py-7">
        {/* Header */}
        <div className="flex shrink-0 items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-[family-name:var(--font-display)] text-2xl font-medium tracking-[-0.02em] text-[var(--flare)]">
              Conversations
            </h2>
            <p className="mt-1 text-xs text-[var(--etch)]">
              {sessions.length === 0
                ? "Threads from this project will appear here."
                : `${sessions.length} ${sessions.length === 1 ? "thread" : "threads"}${activeSessionId ? " · click a card to resume" : ""}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => closeWithFade(onNew)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--chassis)] bg-[var(--void)] px-3 py-1.5 text-xs font-medium text-[var(--flare)] transition-all hover:-translate-y-0.5 hover:border-[var(--aperture)]/50 hover:bg-[var(--accent)]/30 active:translate-y-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New conversation</span>
              <span className="sm:hidden">New</span>
            </button>
            <button
              onClick={() => closeWithFade(onClose)}
              title="Close (Esc)"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--chassis)] bg-[var(--void)] text-[var(--etch)] transition-colors hover:text-[var(--flare)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body — scrollable card grid grouped by day */}
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          {sessions.length === 0 ? (
            <EmptyThreads onNew={() => closeWithFade(onNew)} />
          ) : (
            <div className="grid grid-cols-1 gap-2 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {grouped.map((group) => (
                <Fragment key={group.key}>
                  <h4 className="col-span-full mt-3 text-[11px] font-medium uppercase tracking-wider text-[var(--etch)] first:mt-0">
                    {group.label}
                  </h4>
                  {group.sessions.map(({ session, index }) => (
                    <ThreadCard
                      key={session.id}
                      session={session}
                      index={index}
                      isActive={session.id === activeSessionId}
                      onSelect={(id) => closeWithFade(() => onSelect(id))}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyThreads({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--chassis)] bg-[var(--void)]">
        <MessageSquare className="h-6 w-6 text-[var(--etch)]" />
      </div>
      <h3 className="mt-4 font-[family-name:var(--font-display)] text-lg font-medium text-[var(--flare)]">
        No conversations yet
      </h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--etch)]">
        Send a message in the composer to start your first thread. It will be
        saved here automatically.
      </p>
      <button
        onClick={onNew}
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--aperture)] px-3.5 py-2 text-sm font-medium text-white transition-transform hover:-translate-y-0.5 active:translate-y-0"
      >
        <Plus className="h-4 w-4" />
        Start a conversation
      </button>
    </div>
  );
}
