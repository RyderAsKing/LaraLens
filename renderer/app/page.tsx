"use client";

import { useCallback, useMemo, useState } from "react";
import { Toolbar } from "@/components/toolbar";
import { FilterPanel } from "@/components/filter-panel";
import { GraphView } from "@/components/graph-view";
import { Inspector } from "@/components/inspector";
import { EmptyState } from "@/components/empty-state";
import { useScan } from "@/hooks/use-scan";
import type { NodeType } from "@/lib/types";

export default function Page() {
  const {
    status,
    result,
    projectPath,
    error,
    scan,
    pickDirectory,
    reset,
  } = useScan();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<NodeType> | null>(null);

  const graph = result?.graph ?? null;
  const summary = result?.summary ?? null;

  // Default: all types present in the graph are active.
  const effectiveActive = useMemo(() => {
    if (!graph) return new Set<NodeType>();
    if (activeTypes) return activeTypes;
    return new Set(graph.nodes.map((n) => n.type));
  }, [graph, activeTypes]);

  const handlePickAndScan = useCallback(async () => {
    const picked = await pickDirectory();
    if (!picked) return;
    setSelectedId(null);
    setActiveTypes(null);
    await scan(picked);
  }, [pickDirectory, scan]);

  const handleRescan = useCallback(async () => {
    if (!projectPath) return;
    setSelectedId(null);
    await scan(projectPath);
  }, [projectPath, scan]);

  const toggleType = useCallback((type: NodeType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev ?? effectiveActive);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, [effectiveActive]);

  const allTypes = useCallback(() => {
    if (!graph) return;
    setActiveTypes(new Set(graph.nodes.map((n) => n.type)));
  }, [graph]);

  const noneTypes = useCallback(() => setActiveTypes(new Set()), []);

  const showEmpty = status !== "success" || !graph || graph.nodes.length === 0;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toolbar
        projectPath={projectPath}
        projectName={graph?.meta.project ?? "Laravel Project"}
        summary={summary}
        status={status}
        onPickAndScan={handlePickAndScan}
        onRescan={handleRescan}
      />

      {showEmpty ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            status={status}
            error={error}
            onPickAndScan={handlePickAndScan}
          />
        </div>
      ) : (
        <div
          className="flex min-h-0 overflow-hidden"
          style={{ height: "calc(100vh - 3.5rem)" }}
        >
          <aside className="hidden w-56 shrink-0 border-r md:block">
            <FilterPanel
              graph={graph!}
              activeTypes={effectiveActive}
              onToggleType={toggleType}
              onAll={allTypes}
              onNone={noneTypes}
            />
          </aside>

          <main className="relative min-h-0 flex-1 overflow-hidden">
            <GraphView
              graph={graph!}
              activeTypes={effectiveActive}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </main>

          <aside className="hidden w-80 shrink-0 border-l lg:block">
            <Inspector graph={graph!} selectedId={selectedId} />
          </aside>
        </div>
      )}

      <footer className="hidden shrink-0 items-center justify-between border-t px-4 py-1.5 text-[10px] text-muted-foreground sm:flex">
        <span>
          {graph
            ? `${graph.nodes.length} nodes · ${graph.edges.length} edges · analyzed ${new Date(graph.meta.analyzedAt).toLocaleString()}`
            : "Ready"}
        </span>
        <span>LaraLens · Node + Electron + React Flow</span>
        {result && (
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={reset}
          >
            reset
          </button>
        )}
      </footer>
    </div>
  );
}
