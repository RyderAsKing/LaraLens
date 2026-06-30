"use client";

import { FolderOpen, AlertCircle, Clock3, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface RecentProject {
  name: string;
  path: string;
}

interface EmptyStateProps {
  status: "idle" | "scanning" | "success" | "error";
  error: string | null;
  recentProjects?: RecentProject[];
  onPickAndScan: () => void;
  onOpenRecent?: (path: string) => void;
}

export function EmptyState({
  status,
  error,
  recentProjects = [],
  onPickAndScan,
  onOpenRecent,
}: EmptyStateProps) {
  if (status === "scanning") {
    return (
      <Shell>
        <LensSweep />
        <Title>Analyzing architecture</Title>
        <Subtitle>
          Scanning routes, controllers, models, middleware, commands, and
          providers in the main process…
        </Subtitle>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell>
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--destructive)]/20 bg-[var(--destructive)]/10">
          <AlertCircle className="h-6 w-6 text-[var(--destructive)]" />
        </div>
        <Title>Scan failed</Title>
        <Subtitle>{error ?? "An unexpected error occurred."}</Subtitle>
        <Button onClick={onPickAndScan} className="mt-3">
          <FolderOpen />
          Try Again
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <LensSweep icon="search" />
      <Title>Focus on your architecture</Title>
      <Subtitle>
        LaraLens parses routes, controllers, models, and call chains — then
        renders the full picture as an interactive graph. No PHP runtime
        required.
      </Subtitle>
      <Button onClick={onPickAndScan} size="lg" className="mt-3">
        <FolderOpen />
        Select Project Directory
      </Button>
      {recentProjects.length > 0 && onOpenRecent && (
        <RecentProjects projects={recentProjects} onOpen={onOpenRecent} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="flex max-w-lg flex-col items-center gap-4">{children}</div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-medium tracking-[-0.02em] text-[var(--flare)]">
      {children}
    </h1>
  );
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-sm text-[15px] leading-relaxed text-[var(--etch)]">
      {children}
    </p>
  );
}

function RecentProjects({
  projects,
  onOpen,
}: {
  projects: RecentProject[];
  onOpen: (path: string) => void;
}) {
  return (
    <div className="mt-5 w-full max-w-xl text-left">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
        <Clock3 className="h-3.5 w-3.5" />
        Recently opened
      </div>
      <div className="space-y-1.5">
        {projects.map((project) => (
          <button
            key={project.path}
            onClick={() => onOpen(project.path)}
            className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--chassis)] bg-[var(--optic)] px-3 py-2 text-left transition-colors hover:border-[var(--aperture)]/30 hover:bg-[#1a1c24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aperture)]"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--flare)]">
                {project.name}
              </span>
              <span className="block truncate font-mono text-[11px] text-[var(--etch)]">
                {project.path}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--aperture)]">
              Open
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Signature element: an animated lens-sweep ring, or a subtle search mark. */
function LensSweep({ icon = "lens" }: { icon?: "lens" | "search" }) {
  const isSearch = icon === "search";

  return (
    <div className={`${isSearch ? "search-mark" : "lens-sweep"} h-16 w-16`}>
      <div className="lens-sweep-inner flex h-full w-full items-center justify-center">
        {isSearch ? (
          <Search className="h-7 w-7 text-[var(--aperture)]" />
        ) : (
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--aperture)]"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        )}
      </div>
    </div>
  );
}
