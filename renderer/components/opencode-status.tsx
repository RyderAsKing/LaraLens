"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Loader2,
  Power,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOpencode } from "@/hooks/use-opencode";
import { OpencodeLogo } from "@/components/opencode-logo";
import type { OpencodeState } from "@/lib/opencode-types";

/**
 * OpenCode status indicator for the toolbar.
 *
 * Rendered as a `Button variant="outline" size="sm"` so it visually matches the
 * Rescan / Open Project buttons. The border color reflects the server state:
 *  - connected  → green
 *  - starting   → amber
 *  - error      → red (destructive)
 *  - other      → default (chassis)
 *
 * The opencode logo replaces the status dot. Click opens a dropdown with
 * details (port, pid, project root, version) and Start/Stop/Restart actions.
 * Not-installed state shows a hint with a link to the install docs.
 */
export function OpencodeStatus() {
  const { status, start, stop, restart } = useOpencode();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const state: OpencodeState = status?.state ?? "unknown";
  const borderClass = borderForState(state);
  const isStarting = state === "starting";

  const canStart = state === "stopped" || state === "error";
  const canStop = state === "connected" || state === "starting";
  const canRestart = state === "connected" || state === "error";

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className={cn(borderClass, "gap-2")}
        aria-label="OpenCode status"
        aria-expanded={open}
      >
        {isStarting ? (
          <Loader2 className="animate-spin" />
        ) : (
          <OpencodeLogo />
        )}
        OpenCode
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-lg border border-[var(--chassis)] bg-[var(--optic)] shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--chassis)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--flare)]">
              OpenCode
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-[var(--etch)] transition-colors hover:bg-[var(--accent)]/30 hover:text-[var(--flare)]"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-3 py-2.5">
            {state === "not_installed" ? (
              <NotInstalledBody />
            ) : state === "error" ? (
              <ErrorBody error={status?.error} />
            ) : (
              <DetailsBody status={status} />
            )}
          </div>

          {/* Actions */}
          {(canStart || canStop || canRestart) && (
            <div className="flex items-center gap-2 border-t border-[var(--chassis)] px-3 py-2">
              {canStart && (
                <ActionButton onClick={start} icon={<Power className="h-3.5 w-3.5" />}>
                  Start
                </ActionButton>
              )}
              {canStop && (
                <ActionButton onClick={stop} icon={<Power className="h-3.5 w-3.5" />}>
                  Stop
                </ActionButton>
              )}
              {canRestart && (
                <ActionButton
                  onClick={restart}
                  icon={<RotateCw className="h-3.5 w-3.5" />}
                >
                  Restart
                </ActionButton>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailsBody({
  status,
}: {
  status: import("@/lib/opencode-types").OpencodeStatus | null;
}) {
  return (
    <div className="space-y-1.5">
      <DetailRow label="State" value={prettyState(status?.state ?? "unknown")} />
      {status?.version && (
        <DetailRow label="Version" value={status.version} mono />
      )}
      {status?.port && (
        <DetailRow label="Port" value={String(status.port)} mono />
      )}
      {status?.baseUrl && (
        <DetailRow label="URL" value={status.baseUrl} mono />
      )}
      {status?.projectRoot && (
        <DetailRow
          label="Project"
          value={status.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? status.projectRoot}
          title={status.projectRoot}
        />
      )}
    </div>
  );
}

function NotInstalledBody() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--etch)]">
        OpenCode is not installed on your system.
      </p>
      <a
        href="https://opencode.ai/docs/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--aperture)] hover:underline"
      >
        Install OpenCode →
      </a>
    </div>
  );
}

function ErrorBody({ error }: { error?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--destructive)]" />
        <p className="text-xs text-[var(--etch)]">
          {error ?? "An unexpected error occurred."}
        </p>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
        {label}
      </span>
      <span
        className={cn(
          "truncate text-xs text-[var(--flare)]",
          mono && "font-mono text-[11px]"
        )}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--chassis)] px-2.5 py-1 text-xs font-medium text-[var(--flare)] transition-colors hover:bg-[var(--accent)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aperture)]"
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Border color class for the trigger button, reflecting server state. */
function borderForState(state: OpencodeState): string {
  switch (state) {
    case "connected":
      return "border-green-500";
    case "starting":
      return "border-amber-500";
    case "error":
      return "border-[var(--destructive)]";
    default:
      return ""; // use the outline variant's default border
  }
}

function prettyState(state: OpencodeState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "starting":
      return "Starting…";
    case "error":
      return "Error";
    case "not_installed":
      return "Not installed";
    case "stopped":
      return "Stopped";
    default:
      return "Unknown";
  }
}
