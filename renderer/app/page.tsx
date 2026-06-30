"use client";

import { useCallback, useState } from "react";
import { Toolbar } from "@/components/toolbar";
import { Inspector } from "@/components/inspector";
import { RouteBrowser } from "@/components/route-browser";
import { RouteDetail } from "@/components/route-detail";
import { EmptyState } from "@/components/empty-state";
import { useScan } from "@/hooks/use-scan";

export default function Page() {
  const {
    status,
    result,
    projectPath,
    error,
    scan,
    pickDirectory,
  } = useScan();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string>("/");

  const graph = result?.graph ?? null;
  const summary = result?.summary ?? null;

  const handlePickAndScan = useCallback(async () => {
    const picked = await pickDirectory();
    if (!picked) return;
    setSelectedId(null);
    setSelectedRouteId(null);
    setBrowsePath("/");
    await scan(picked);
  }, [pickDirectory, scan]);

  const handleRescan = useCallback(async () => {
    if (!projectPath) return;
    setSelectedId(null);
    setSelectedRouteId(null);
    await scan(projectPath);
  }, [projectPath, scan]);

  const handleBrowse = useCallback((path: string) => {
    setBrowsePath(path);
    setSelectedRouteId(null);
    setSelectedId(null);
  }, []);

  const handleOpenRoute = useCallback((routeId: string) => {
    setSelectedRouteId(routeId);
    setSelectedId(null);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedRouteId(null);
    setSelectedId(null);
  }, []);

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
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            status={status}
            error={error}
            onPickAndScan={handlePickAndScan}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main className="relative min-h-0 flex-1 overflow-hidden">
            {selectedRouteId ? (
              <RouteDetail
                graph={graph!}
                routeId={selectedRouteId}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onBack={handleBack}
                onRouteChange={setSelectedRouteId}
              />
            ) : (
              <RouteBrowser
                graph={graph!}
                browsePath={browsePath}
                onBrowse={handleBrowse}
                onOpenRoute={handleOpenRoute}
              />
            )}
          </main>

          <aside className="hidden w-80 shrink-0 border-l lg:block">
            <Inspector graph={graph!} selectedId={selectedId} />
          </aside>
        </div>
      )}

      <footer className="shrink-0 border-t px-4 py-1.5 text-center text-[11px] text-muted-foreground">
        Lara Lens
      </footer>
    </div>
  );
}
