"use client";

import { useMemo } from "react";
import { Folder, FileCode, ChevronRight, Home } from "lucide-react";
import { buildRouteUriTree } from "@/lib/route-tree";
import type { UriTreeNode } from "@/lib/route-tree";
import { ACCENT_COLORS, methodBadgeClass } from "@/lib/graph";
import type { Graph, GraphNode } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RouteBrowserProps {
  graph: Graph;
  browsePath: string;
  onBrowse: (path: string) => void;
  onOpenRoute: (routeId: string) => void;
}

/** Find the URI tree node at `path` (`/` for root). */
function findUriNode(root: UriTreeNode, path: string): UriTreeNode | null {
  if (path === "/") return root;
  const segs = path.split("/").filter(Boolean);
  let node = root;
  for (const seg of segs) {
    const next = node.children.find((c) => c.segment === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

interface FileGroup {
  uri: string;
  name: string;
  routes: GraphNode[];
}

export function RouteBrowser({
  graph,
  browsePath,
  onBrowse,
  onOpenRoute,
}: RouteBrowserProps) {
  const tree = useMemo(() => buildRouteUriTree(graph), [graph]);
  const node = useMemo(() => findUriNode(tree, browsePath), [tree, browsePath]);

  const crumbs = useMemo(() => {
    const segs = browsePath.split("/").filter(Boolean);
    const items = [{ label: "Home", path: "/" }];
    let acc = "";
    for (const s of segs) {
      acc += "/" + s;
      items.push({ label: s, path: acc });
    }
    return items;
  }, [browsePath]);

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No routes here.
      </div>
    );
  }

  // Folders = child segments that themselves have sub-segments.
  const folders = node.children.filter((c) => c.children.length > 0);

  // Files = (a) routes terminating at the current path, plus
  //         (b) leaf children (no sub-segments) grouped by their URI.
  const fileGroups: FileGroup[] = [];

  if (node.routes.length > 0) {
    const uri = browsePath;
    const name = browsePath === "/" ? "/" : seg(browsePath);
    fileGroups.push({ uri, name, routes: [...node.routes] });
  }
  for (const child of node.children) {
    if (child.children.length > 0) continue; // it's a folder
    fileGroups.push({
      uri: child.path,
      name: child.segment,
      routes: [...child.routes],
    });
  }

  const isEmpty = folders.length === 0 && fileGroups.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb */}
      <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2.5 text-sm">
        {crumbs.map((c, i) => (
          <div key={c.path} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <button
              onClick={() => onBrowse(c.path)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent",
                i === crumbs.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {i === 0 && <Home className="h-3.5 w-3.5" />}
              {i === 0 ? "" : c.label}
            </button>
          </div>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {node.routeCount} route{node.routeCount === 1 ? "" : "s"} in this folder
        </span>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No routes in this folder.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
            {folders.map((f) => (
              <FolderCard key={f.path} node={f} onBrowse={onBrowse} />
            ))}
            {fileGroups.map((g) => (
              <FileCard
                key={g.uri}
                group={g}
                selected={false}
                onOpen={onOpenRoute}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function seg(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

function FolderCard({
  node,
  onBrowse,
}: {
  node: UriTreeNode;
  onBrowse: (path: string) => void;
}) {
  return (
    <button
      onClick={() => onBrowse(node.path)}
      className="group flex aspect-square flex-col justify-between rounded-2xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-amber-300">
          <Folder className="h-7 w-7" />
        </div>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground">
          folder
        </span>
      </div>

      <div className="min-w-0">
        <div className="truncate text-lg font-semibold text-foreground">
          {node.segment}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {node.path}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Routes</div>
          <div className="mt-0.5 text-base font-semibold text-foreground">
            {node.routeCount}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Items</div>
          <div className="mt-0.5 text-base font-semibold text-foreground">
            {node.children.length}
          </div>
        </div>
      </div>
    </button>
  );
}

function FileCard({
  group,
  selected,
  onOpen,
}: {
  group: FileGroup;
  selected: boolean;
  onOpen: (routeId: string) => void;
}) {
  const first = group.routes[0];
  if (!first) return null;
  const methods = group.routes
    .map((r) => String(r.data.method ?? "").toUpperCase())
    .filter(Boolean);
  const name = String(first.data.name ?? "");
  const controller = String(first.data.controller ?? first.data.action ?? "");

  return (
    <button
      onClick={() => onOpen(first.id)}
      className={cn(
        "group flex aspect-square flex-col justify-between rounded-2xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:shadow-md",
        selected && "border-primary"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="rounded-xl border p-3"
          style={{
            color: ACCENT_COLORS.route,
            borderColor: "rgba(76, 175, 80, 0.18)",
            background: "rgba(76, 175, 80, 0.08)",
          }}
        >
          <FileCode className="h-7 w-7" />
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {methods.slice(0, 4).map((m) => (
            <span
              key={m}
              className={cn(
                "inline-flex min-w-14 justify-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold",
                methodBadgeClass(m)
              )}
            >
              {m}
            </span>
          ))}
          {methods.length > 4 && (
            <span className="inline-flex min-w-10 justify-center rounded-md border border-border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              +{methods.length - 4}
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="truncate text-lg font-semibold text-foreground">
          {group.name}
        </div>
        <div className="mt-1 truncate font-mono text-sm text-muted-foreground">
          {group.uri}
        </div>
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {name && (
          <div className="truncate rounded-lg border border-border bg-background/50 px-2 py-1">
            <span className="text-foreground">Name:</span> {name}
          </div>
        )}
        {controller && (
          <div className="truncate rounded-lg border border-border bg-background/50 px-2 py-1 font-mono">
            {controller}
          </div>
        )}
      </div>
    </button>
  );
}
