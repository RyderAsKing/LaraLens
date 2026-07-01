"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { UriTreeNode } from "@/lib/route-tree";
import type { GraphNode } from "@/lib/types";
import { ACCENT_COLORS, displayHttpMethod, methodBadgeClass } from "@/lib/graph";
import { cn } from "@/lib/utils";

interface RouteTreeViewProps {
  /** Root of the URI prefix tree (from `buildRouteUriTree`). */
  root: UriTreeNode;
  /** Path to auto-expand and highlight, synced with the breadcrumb. "/" for root. */
  focusPath: string;
  onOpenRoute: (routeId: string) => void;
}

/** All ancestor paths of `path` excluding root, e.g. "/api/users" -> ["/api", "/api/users"]. */
function ancestorPaths(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const s of segs) {
    cur += "/" + s;
    out.push(cur);
  }
  return out;
}

export function RouteTreeView({ root, focusPath, onOpenRoute }: RouteTreeViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ancestorPaths(focusPath))
  );

  // When the focus path changes (breadcrumb navigation / back from detail),
  // make sure the branch chain leading to it is expanded. Skip the first run:
  // the lazy initializer above already seeds the mount-time focus chain, so
  // running here would only produce a same-content Set and a wasted render.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestorPaths(focusPath)) next.add(p);
      return next;
    });
  }, [focusPath]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const isEmpty = root.routes.length === 0 && root.children.length === 0;

  if (isEmpty) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-[var(--etch)]">
        No routes found.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto p-3">
      {/* Routes whose URI is exactly "/" live at the root (no parent segment). */}
      {root.routes.length > 0 && (
        <RouteRow
          segment="/"
          path="/"
          routes={root.routes}
          hasChildren={false}
          isOpen={false}
          focused={focusPath === "/"}
          onToggle={toggle}
          onOpenRoute={onOpenRoute}
        />
      )}
      {root.children.map((child) => (
        <RouteTreeBranch
          key={child.path}
          node={child}
          expanded={expanded}
          focusPath={focusPath}
          onToggle={toggle}
          onOpenRoute={onOpenRoute}
        />
      ))}
    </div>
  );
}

function RouteTreeBranch({
  node,
  expanded,
  focusPath,
  onToggle,
  onOpenRoute,
}: {
  node: UriTreeNode;
  expanded: Set<string>;
  focusPath: string;
  onToggle: (path: string) => void;
  onOpenRoute: (routeId: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <RouteRow
        segment={node.segment}
        path={node.path}
        routes={node.routes}
        hasChildren={hasChildren}
        isOpen={isOpen}
        focused={focusPath === node.path}
        onToggle={onToggle}
        onOpenRoute={onOpenRoute}
      />
      {hasChildren && isOpen && (
        <div className="ml-3 border-l border-[var(--chassis)] pl-2">
          {node.children.map((child) => (
            <RouteTreeBranch
              key={child.path}
              node={child}
              expanded={expanded}
              focusPath={focusPath}
              onToggle={onToggle}
              onOpenRoute={onOpenRoute}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Distinct HTTP methods at a URI, each paired with the route node to open. */
function methodEntries(routes: GraphNode[]): { method: string; route: GraphNode }[] {
  const seen = new Set<string>();
  const out: { method: string; route: GraphNode }[] = [];
  for (const r of routes) {
    const m = displayHttpMethod(r.data.method);
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push({ method: m, route: r });
  }
  return out;
}

function RouteRow({
  segment,
  path,
  routes,
  hasChildren,
  isOpen,
  focused,
  onToggle,
  onOpenRoute,
}: {
  segment: string;
  path: string;
  routes: GraphNode[];
  hasChildren: boolean;
  isOpen: boolean;
  focused: boolean;
  onToggle: (path: string) => void;
  onOpenRoute: (routeId: string) => void;
}) {
  const entries = methodEntries(routes);
  const hasRoutes = entries.length > 0;

  const handleRowClick = () => {
    if (hasRoutes) onOpenRoute(routes[0].id);
    else if (hasChildren) onToggle(path);
  };

  const rowTitle = hasRoutes
    ? `Open ${entries.map((e) => e.method).join("|")} ${path}`
    : hasChildren
      ? `${isOpen ? "Collapse" : "Expand"} ${path}`
      : path;

  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md py-1 pr-2 transition-colors hover:bg-[var(--accent)]",
        focused && "bg-[var(--accent)]"
      )}
    >
      {hasChildren ? (
        <button
          onClick={() => onToggle(path)}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--etch)] hover:text-[var(--flare)]"
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${path}`}
          title={`${isOpen ? "Collapse" : "Expand"} ${path}`}
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}

      <button
        onClick={handleRowClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={rowTitle}
      >
        {hasChildren ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--aperture)]" />
        ) : (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: ACCENT_COLORS.route }}
          />
        )}
        <span className="truncate font-mono text-sm text-[var(--flare)]">
          {segment}
        </span>
      </button>

      {entries.length > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          {entries.slice(0, 3).map(({ method, route }) => (
            <button
              key={`${method}-${route.id}`}
              onClick={() => onOpenRoute(route.id)}
              className={cn(
                "inline-flex min-w-9 justify-center rounded border px-1 py-0.5 font-mono text-[9px] font-semibold transition-transform hover:scale-110",
                methodBadgeClass(method)
              )}
              title={`Open ${method} ${path}`}
            >
              {method}
            </button>
          ))}
          {entries.length > 3 && (
            <span
              className="inline-flex min-w-7 justify-center rounded border border-[var(--chassis)] bg-[var(--void)] px-1 py-0.5 text-[9px] text-[var(--etch)]"
              title={entries.slice(3).map((e) => e.method).join(", ")}
            >
              +{entries.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
