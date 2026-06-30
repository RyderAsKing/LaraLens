"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ListTree,
  Network,
  Activity,
  ChevronDown,
  ChevronRight,
  MousePointerClick,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RouteSubgraphView } from "./route-subgraph-view";
import { buildDisplayTree, routesAtUri } from "@/lib/route-tree";
import type { DescendantTreeNode } from "@/lib/route-tree";
import { ACCENT_COLORS, TYPE_LABELS, methodBadgeClass, nodeSubtitle } from "@/lib/graph";
import type { Graph } from "@/lib/types";
import { cn } from "@/lib/utils";

type ViewMode = "tree" | "graph";

interface RouteDetailProps {
  graph: Graph;
  routeId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
  onRouteChange: (routeId: string) => void;
}

export function RouteDetail({
  graph,
  routeId,
  selectedId,
  onSelect,
  onBack,
  onRouteChange,
}: RouteDetailProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [lifecycle, setLifecycle] = useState(false);

  const route = useMemo(
    () => graph.nodes.find((n) => n.id === routeId) ?? null,
    [graph, routeId]
  );

  const siblings = useMemo(
    () => (route ? routesAtUri(graph, String(route.data.uri ?? "")) : []),
    [graph, route]
  );

  const displayTree = useMemo(
    () => (route ? buildDisplayTree(graph, routeId, lifecycle) : null),
    [graph, route, routeId, lifecycle]
  );

  if (!route || !displayTree) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <MousePointerClick className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Select a route to explore everything reachable from it.
        </p>
      </div>
    );
  }

  const method = String(route.data.method ?? "").toUpperCase();
  const uri = String(route.data.uri ?? "");
  const name = String(route.data.name ?? "");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Routes
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex min-w-16 justify-center rounded-md border px-2 py-0.5 font-mono text-xs font-bold",
                methodBadgeClass(method)
              )}
            >
              {method}
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">
              {uri}
            </span>
            {name && (
              <span className="text-xs text-muted-foreground">named {name}</span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Lifecycle toggle */}
            <button
              onClick={() => setLifecycle((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                lifecycle
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
              title="Toggle Laravel request lifecycle (entry → bootstrap → kernel → router → route)"
            >
              <Activity className="h-3.5 w-3.5" />
              Lifecycle
            </button>

            {/* Tree / Graph segmented toggle */}
            <div className="flex rounded-md border border-border p-0.5">
              <button
                onClick={() => setViewMode("tree")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                  viewMode === "tree"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <ListTree className="h-3.5 w-3.5" />
                Tree
              </button>
              <button
                onClick={() => setViewMode("graph")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                  viewMode === "graph"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Network className="h-3.5 w-3.5" />
                Graph
              </button>
            </div>
          </div>
        </div>

        {/* Method tabs when multiple methods share this URI */}
        {siblings.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {siblings.map((s) => {
              const m = String(s.data.method ?? "").toUpperCase();
              const active = s.id === routeId;
              return (
                <button
                  key={s.id}
                  onClick={() => onRouteChange(s.id)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold transition-colors",
                    active
                      ? methodBadgeClass(m)
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {m}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === "tree" ? (
          <TreeView
            displayTree={displayTree}
            lifecycle={lifecycle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          <RouteSubgraphView
            graph={graph}
            routeId={routeId}
            withLifecycle={lifecycle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
      </div>
    </div>
  );
}

function TreeView({
  displayTree,
  lifecycle,
  selectedId,
  onSelect,
}: {
  displayTree: DescendantTreeNode;
  lifecycle: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  // Without lifecycle the root is the route itself (already shown in the
  // header), so render its children. With lifecycle the root is the entry
  // node and the route is nested inside the chain — render the whole tree.
  const roots = lifecycle ? [displayTree] : displayTree.children;

  if (roots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No outgoing relationships from this route.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {roots.map((child) => (
        <DescendantBranch
          key={child.node.id}
          node={child}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function DescendantBranch({
  node,
  selectedId,
  onSelect,
}: {
  node: DescendantTreeNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const accent = ACCENT_COLORS[node.node.type] ?? "#94a3b8";
  const subtitle = nodeSubtitle(node.node);
  const edgeLabel = node.edge?.label;
  const selected = selectedId === node.node.id;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md py-1 pr-2 transition-colors hover:bg-accent",
          selected && "bg-accent"
        )}
      >
        {hasChildren ? (
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <button
          onClick={() => onSelect(node.node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {TYPE_LABELS[node.node.type]}
          </span>
          <span className="truncate text-sm text-foreground">
            {node.node.label}
          </span>
          {subtitle && subtitle !== node.node.label && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {subtitle}
            </span>
          )}
        </button>
        {edgeLabel && (
          <Badge
            variant="outline"
            className="shrink-0 text-[10px] font-normal text-muted-foreground"
          >
            {edgeLabel}
          </Badge>
        )}
      </div>

      {hasChildren && open && (
        <div className="ml-3 border-l border-border pl-2">
          {node.children.map((child) => (
            <DescendantBranch
              key={child.node.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
