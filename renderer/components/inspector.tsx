"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ACCENT_COLORS, TYPE_LABELS } from "@/lib/graph";
import type { Graph, GraphNode } from "@/lib/types";

interface InspectorProps {
  graph: Graph;
  selectedId: string | null;
}

export function Inspector({ graph, selectedId }: InspectorProps) {
  const node = useMemo<GraphNode | null>(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId]
  );

  const relatedEdges = useMemo(() => {
    if (!node) return { outgoing: [], incoming: [] };
    return {
      outgoing: graph.edges.filter((e) => e.source === node.id),
      incoming: graph.edges.filter((e) => e.target === node.id),
    };
  }, [graph, node]);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Select a node to inspect its details.
        </p>
      </div>
    );
  }

  const accent = ACCENT_COLORS[node.type] ?? "#94a3b8";

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: accent }}
          />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {TYPE_LABELS[node.type]}
          </span>
        </div>
        <h2 className="mt-2 text-base font-semibold text-foreground">
          {node.label}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <DataRow label="ID" value={node.id} mono />
        {Object.entries(node.data)
          .filter(([k]) => k !== "accent")
          .map(([key, value]) => (
            <DataRow key={key} label={key} value={formatValue(value)} />
          ))}

        {(relatedEdges.outgoing.length > 0 || relatedEdges.incoming.length > 0) && (
          <>
            <Separator className="my-4" />
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Relationships
            </p>
            {relatedEdges.outgoing.map((e) => (
              <EdgeRow
                key={e.id}
                kind="out"
                label={e.label}
                type={e.type}
                other={e.target}
              />
            ))}
            {relatedEdges.incoming.map((e) => (
              <EdgeRow
                key={e.id}
                kind="in"
                label={e.label}
                type={e.type}
                other={e.source}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function DataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (!value || value === "[]" || value === "{}") return null;
  return (
    <div className="mb-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 break-words text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function EdgeRow({
  kind,
  label,
  type,
  other,
}: {
  kind: "in" | "out";
  label: string;
  type: string;
  other: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs">
      <Badge variant={kind === "out" ? "default" : "secondary"}>{label}</Badge>
      <span className="truncate font-mono text-muted-foreground">{other}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{type}</span>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return value.map(formatValue).join(", ");
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value, null, 2);
      return json.length > 400 ? json.slice(0, 400) + "…" : json;
    } catch {
      return String(value);
    }
  }
  return String(value);
}
