"use client";

import { FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ScanSummary } from "@/lib/types";

interface ToolbarProps {
  projectPath: string | null;
  projectName: string;
  summary: ScanSummary | null;
  status: "idle" | "scanning" | "success" | "error";
  onPickAndScan: () => void;
  onRescan: () => void;
}

export function Toolbar({
  projectPath,
  projectName,
  summary,
  status,
  onPickAndScan,
  onRescan,
}: ToolbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <span className="text-sm font-semibold tracking-tight">LaraLens</span>

      <div className="mx-1 h-5 w-px bg-border" />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {projectPath ? (
          <>
            <span className="truncate text-sm text-foreground">{projectName}</span>
            <span className="hidden truncate text-xs text-muted-foreground md:inline">
              {projectPath}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">
            No project loaded
          </span>
        )}
      </div>

      {summary && (
        <div className="hidden items-center gap-1.5 lg:flex">
          <StatBadge label="Routes" value={summary.totalRoutes} />
          <StatBadge label="Controllers" value={summary.totalControllers} />
          <StatBadge label="Models" value={summary.totalModels} />
          <StatBadge label="Commands" value={summary.totalCommands} />
          <StatBadge label="Middleware" value={summary.totalMiddleware} />
          <span className="text-[10px] text-muted-foreground">
            {Math.round(summary.durationMs)}ms
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
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
        <Button size="sm" onClick={onPickAndScan} disabled={status === "scanning"}>
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

function StatBadge({ label, value }: { label: string; value: number }) {
  return (
    <Badge variant="muted" className="gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </Badge>
  );
}
