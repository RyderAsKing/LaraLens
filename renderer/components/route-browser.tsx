"use client";

import { useMemo } from "react";
import { Folder, FileCode, ChevronRight, Home } from "lucide-react";
import { buildRouteUriTree } from "@/lib/route-tree";
import type { UriTreeNode } from "@/lib/route-tree";
import { methodBadgeClass } from "@/lib/graph";
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
      <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--etch)]">
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
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--chassis)] px-5 py-2.5 text-sm">
        {crumbs.map((c, i) => (
          <div key={c.path} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-[var(--etch)]" />
            )}
            <button
              onClick={() => onBrowse(c.path)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--accent)]",
                i === crumbs.length - 1
                  ? "font-medium text-[var(--flare)]"
                  : "text-[var(--etch)] hover:text-[var(--flare)]"
              )}
            >
              {i === 0 && <Home className="h-3.5 w-3.5" />}
              {i === 0 ? "" : c.label}
            </button>
          </div>
        ))}
        <span className="ml-auto text-xs text-[var(--etch)]">
          {node.routeCount} route{node.routeCount === 1 ? "" : "s"} in this folder
        </span>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--etch)]">
            No routes in this folder.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
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
      className="group flex min-h-34 flex-col gap-3 rounded-xl border border-[var(--chassis)] bg-[var(--optic)] p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[var(--aperture)]/30 hover:bg-[var(--accent)]/20 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <Folder className="h-6 w-6 text-[var(--aperture)]" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--etch)]">
          folder
        </span>
      </div>

      <div className="min-w-0">
        <div className="truncate font-[family-name:var(--font-display)] text-base font-medium tracking-[-0.01em] text-[var(--flare)]">
          {node.segment}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--etch)]">
          {node.path}
        </div>
      </div>

      <div className="mt-auto flex items-end gap-5 border-t border-[var(--chassis)] pt-2 text-xs">
        <Stat label="Routes" value={node.routeCount} />
        <Stat label="Items" value={node.children.length} />
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
  const displayName = name || group.name;

  return (
    <button
      onClick={() => onOpen(first.id)}
      className={cn(
        "group flex min-h-34 flex-col gap-3 rounded-xl border bg-[var(--optic)] p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[var(--aperture)]/25 hover:bg-[var(--accent)]/20 hover:shadow-md",
        selected ? "border-[var(--aperture)]/40" : "border-[var(--chassis)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <FileCode className="h-6 w-6 text-[#7AB8AA]" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--etch)]">
          route
        </span>
      </div>

      <div className="min-w-0">
        <div className="truncate font-[family-name:var(--font-display)] text-base font-medium tracking-[-0.01em] text-[var(--flare)]">
          {displayName}
        </div>
        {controller && (
          <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--etch)]">
            {controller}
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-1 border-t border-[var(--chassis)] pt-2 text-xs">
        {methods.slice(0, 3).map((m) => (
          <span
            key={m}
            className={cn(
              "inline-flex min-w-9 justify-center rounded border px-1 py-0.5 font-mono text-[9px] font-semibold",
              methodBadgeClass(m)
            )}
          >
            {m}
          </span>
        ))}
        {methods.length > 3 && (
          <span className="inline-flex min-w-7 justify-center rounded border border-[var(--chassis)] bg-[var(--void)] px-1 py-0.5 text-[9px] text-[var(--etch)]">
            +{methods.length - 3}
          </span>
        )}
        {controller && (
          <span className="sr-only">{controller}</span>
        )}
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="leading-none">
      <div className="font-[family-name:var(--font-display)] text-sm font-semibold tabular-nums text-[var(--flare)]">
        {value}
      </div>
      <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--etch)]">
        {label}
      </div>
    </div>
  );
}
