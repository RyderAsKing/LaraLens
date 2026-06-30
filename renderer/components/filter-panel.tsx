"use client";

import { useMemo } from "react";
import { ACCENT_COLORS, TYPE_LABELS } from "@/lib/graph";
import type { Graph, NodeType } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FilterPanelProps {
  graph: Graph;
  activeTypes: Set<NodeType>;
  onToggleType: (type: NodeType) => void;
  onAll: () => void;
  onNone: () => void;
}

export function FilterPanel({
  graph,
  activeTypes,
  onToggleType,
  onAll,
  onNone,
}: FilterPanelProps) {
  const counts = useMemo(() => {
    const map = new Map<NodeType, number>();
    for (const n of graph.nodes) {
      map.set(n.type, (map.get(n.type) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Filters
        </span>
        <div className="flex gap-1 text-[10px]">
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onAll}
          >
            All
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onNone}
          >
            None
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {counts.map(([type, count]) => {
          const active = activeTypes.has(type);
          const accent = ACCENT_COLORS[type] ?? "#94a3b8";
          return (
            <button
              key={type}
              onClick={() => onToggleType(type)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                !active && "opacity-40"
              )}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: accent }}
              />
              <span className="flex-1 truncate text-foreground">
                {TYPE_LABELS[type]}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
