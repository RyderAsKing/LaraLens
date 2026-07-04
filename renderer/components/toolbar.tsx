"use client";

import { Boxes, FolderOpen, Loader2, RefreshCw, Route, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OpencodeStatus } from "@/components/opencode-status";

export type FeatureMode = "routes" | "models";

interface ToolbarProps {
  projectPath: string | null;
  projectName: string;
  status: "idle" | "scanning" | "success" | "error";
  featureMode: FeatureMode;
  onFeatureModeChange: (mode: FeatureMode) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onPickAndScan: () => void;
  onRescan: () => void;
}

export function Toolbar({
  projectPath,
  projectName,
  status,
  featureMode,
  onFeatureModeChange,
  onHome,
  onOpenSettings,
  onPickAndScan,
  onRescan,
}: ToolbarProps) {
  const featureDisabled = !projectPath;

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--chassis)] bg-[var(--void)] px-5">
      {/* Brand */}
      <button
        type="button"
        onClick={onHome}
        className="rounded px-1.5 py-1 font-[family-name:var(--font-display)] text-sm font-semibold tracking-[-0.03em] text-[var(--flare)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aperture)]"
        aria-label="Go to home"
      >
        <span>
          LaraLens
        </span>
      </button>

      <div className="h-5 w-px bg-[var(--chassis)]" />

      {/* Feature switch — Routes / Models */}
      <div
        className="flex rounded-md border border-[var(--chassis)] p-0.5"
        role="group"
        aria-label="Feature view"
      >
        <button
          type="button"
          onClick={() => onFeatureModeChange("routes")}
          disabled={featureDisabled}
          aria-pressed={featureMode === "routes"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
            featureMode === "routes"
              ? "bg-[var(--chassis)] text-[var(--flare)]"
              : "text-[var(--etch)] hover:text-[var(--flare)]",
            featureDisabled && "cursor-not-allowed opacity-50 hover:text-[var(--etch)]"
          )}
        >
          <Route className="h-3.5 w-3.5" />
          Routes
        </button>
        <button
          type="button"
          onClick={() => onFeatureModeChange("models")}
          disabled={featureDisabled}
          aria-pressed={featureMode === "models"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
            featureMode === "models"
              ? "bg-[var(--chassis)] text-[var(--flare)]"
              : "text-[var(--etch)] hover:text-[var(--flare)]",
            featureDisabled && "cursor-not-allowed opacity-50 hover:text-[var(--etch)]"
          )}
        >
          <Boxes className="h-3.5 w-3.5" />
          Models
        </button>
      </div>

      <div className="h-5 w-px bg-[var(--chassis)]" />

      {/* Project */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {projectPath ? (
          <>
            <span className="truncate text-sm font-medium text-[var(--flare)]">
              {projectName}
            </span>
            <span className="hidden truncate font-mono text-xs text-[var(--etch)] md:inline">
              {projectPath}
            </span>
          </>
        ) : (
          <span className="text-sm text-[var(--etch)]">
            No project loaded
          </span>
        )}
      </div>


      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenSettings}
          aria-label="Open LaraLens settings"
        >
          <Settings />
          Settings
        </Button>
        <OpencodeStatus />
        {projectPath && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRescan}
            disabled={status === "scanning"}
          >
            <RefreshCw className={status === "scanning" ? "animate-spin" : ""} />
            Rescan
          </Button>
        )}
        <Button
          size="sm"
          onClick={onPickAndScan}
          disabled={status === "scanning"}
        >
          {status === "scanning" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <FolderOpen />
          )}
          {projectPath ? "Scan Project" : "Open Project"}
        </Button>
      </div>
    </header>
  );
}
