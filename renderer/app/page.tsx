"use client";

import { useCallback, useEffect, useState } from "react";
import { Toolbar, type FeatureMode } from "@/components/toolbar";
import { Inspector } from "@/components/inspector";
import { RouteBrowser, type RouteViewMode } from "@/components/route-browser";
import { RouteDetail } from "@/components/route-detail";
import { ModelRelationshipView } from "@/components/model-relationship-view";
import { EmptyState, type RecentProject } from "@/components/empty-state";
import { ChatComposer } from "@/components/chat-composer";
import { useScan } from "@/hooks/use-scan";

const RECENT_PROJECTS_KEY = "laralens:recent-projects";

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
  const [routeViewMode, setRouteViewMode] = useState<RouteViewMode>("cards");
  const [featureMode, setFeatureMode] = useState<FeatureMode>("routes");
  const [showHome, setShowHome] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

  const graph = result?.graph ?? null;
  const summary = result?.summary ?? null;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_PROJECTS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as RecentProject[];
      if (Array.isArray(parsed)) {
        setRecentProjects(
          parsed.filter((p) => typeof p?.path === "string" && typeof p?.name === "string")
        );
      }
    } catch {
      setRecentProjects([]);
    }
  }, []);

  const rememberProject = useCallback((path: string) => {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    setRecentProjects((current) => {
      const next = [{ name, path }, ...current.filter((p) => p.path !== path)].slice(0, 6);
      window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handlePickAndScan = useCallback(async () => {
    const picked = await pickDirectory();
    if (!picked) return;
    setSelectedId(null);
    setSelectedRouteId(null);
    setBrowsePath("/");
    setShowHome(false);
    rememberProject(picked);
    await scan(picked);
  }, [pickDirectory, rememberProject, scan]);

  const handleOpenRecent = useCallback(async (path: string) => {
    setSelectedId(null);
    setSelectedRouteId(null);
    setBrowsePath("/");
    setShowHome(false);
    rememberProject(path);
    await scan(path);
  }, [rememberProject, scan]);

  const handleRescan = useCallback(async () => {
    if (!projectPath) return;
    setSelectedId(null);
    setSelectedRouteId(null);
    setShowHome(false);
    await scan(projectPath);
  }, [projectPath, scan]);

  const handleBrowse = useCallback((path: string) => {
    setBrowsePath(path);
    setSelectedRouteId(null);
    setSelectedId(null);
    setShowHome(false);
  }, []);

  const handleOpenRoute = useCallback((routeId: string) => {
    setSelectedRouteId(routeId);
    setSelectedId(null);
    setShowHome(false);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedRouteId(null);
    setSelectedId(null);
  }, []);

  const handleHome = useCallback(() => {
    setSelectedRouteId(null);
    setSelectedId(null);
    setBrowsePath("/");
    setShowHome(true);
  }, []);

  const handleFeatureModeChange = useCallback((mode: FeatureMode) => {
    setFeatureMode(mode);
    setSelectedId(null);
    setSelectedRouteId(null);
    setBrowsePath("/");
    setShowHome(false);
  }, []);

  const showEmpty = showHome || status !== "success" || !graph || graph.nodes.length === 0;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--void)] text-[var(--flare)]">
      <Toolbar
        projectPath={projectPath}
        projectName={graph?.meta.project ?? "Laravel Project"}
        status={status}
        featureMode={featureMode}
        onFeatureModeChange={handleFeatureModeChange}
        onHome={handleHome}
        onPickAndScan={handlePickAndScan}
        onRescan={handleRescan}
      />

      {showEmpty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            status={status}
            error={error}
            recentProjects={recentProjects}
            onPickAndScan={handlePickAndScan}
            onOpenRecent={handleOpenRecent}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main className="relative min-h-0 flex-1 overflow-hidden">
            {featureMode === "models" ? (
              <ModelRelationshipView
                graph={graph!}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : selectedRouteId ? (
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
                viewMode={routeViewMode}
                onViewModeChange={setRouteViewMode}
              />
            )}
          </main>

          <aside className="hidden w-80 shrink-0 border-l border-[var(--chassis)] lg:block">
            <Inspector graph={graph!} selectedId={selectedId} summary={summary} />
          </aside>
        </div>
      )}

      <ChatComposer projectRoot={projectPath} />
    </div>
  );
}
