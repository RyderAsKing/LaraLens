"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ACCENT_COLORS, TYPE_LABELS } from "@/lib/graph";
import { nodeLocation } from "@/lib/node-location";
import type { Graph, GraphEdge, GraphNode } from "@/lib/types";

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
    if (!node) return { outgoing: [], incoming: [], referenced: [] };
    const visibleEdges = graph.edges.filter((edge) => !isHiddenInspectorEdge(edge));
    return {
      outgoing: visibleEdges.filter((e) => e.source === node.id),
      incoming: visibleEdges.filter((e) => e.target === node.id),
      referenced: referencedRelationships(node, graph),
    };
  }, [graph, node]);

  const nodesById = useMemo(
    () => new Map(graph.nodes.map((graphNode) => [graphNode.id, graphNode])),
    [graph.nodes]
  );

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="search-mark h-10 w-10">
          <div className="lens-sweep-inner flex h-full w-full items-center justify-center">
            <Search className="h-[18px] w-[18px] text-[var(--aperture)]" />
          </div>
        </div>
        <p className="mt-3 text-sm text-[var(--etch)]">
          Select a node to inspect its details.
        </p>
      </div>
    );
  }

  const accent = ACCENT_COLORS[node.type] ?? "#7A7E85";
  const ownLocation = nodeLocation(node, graph);

  const openOwnCode = async () => {
    if (!ownLocation?.file) return;
    try {
      await window.laralens.openCodeWindow(ownLocation.file, ownLocation.line);
    } catch (error) {
      console.error("Failed to open code window", error);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--chassis)] p-4">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: accent, boxShadow: `0 0 6px ${accent}60` }}
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
            {TYPE_LABELS[node.type]}
          </span>
          {ownLocation?.file && (
            <button
              type="button"
              onClick={openOwnCode}
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--etch)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--flare)]"
              title={`Open ${ownLocation.file}${ownLocation.line ? `:${ownLocation.line}` : ""}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <h2 className="mt-2 font-[family-name:var(--font-display)] text-base font-medium tracking-[-0.01em] text-[var(--flare)]">
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

        {(relatedEdges.outgoing.length > 0 || relatedEdges.incoming.length > 0 || relatedEdges.referenced.length > 0) && (
          <>
            <Separator className="my-4 bg-[var(--chassis)]" />
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
              Relationships
            </p>
            <div className="space-y-2">
              <RelationshipSection
                key={`out-${node.id}`}
                title="Outgoing"
                kind="out"
                edges={relatedEdges.outgoing}
                nodesById={nodesById}
              />
              <RelationshipSection
                key={`in-${node.id}`}
                title="Incoming"
                kind="in"
                edges={relatedEdges.incoming}
                nodesById={nodesById}
              />
              <ReferencedSection references={relatedEdges.referenced} nodesById={nodesById} graph={graph} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReferencedSection({
  references,
  nodesById,
  graph,
}: {
  references: ReferencedRelationship[];
  nodesById: Map<string, GraphNode>;
  graph: Graph;
}) {
  const [open, setOpen] = useState(references.length > 0);
  const contentId = useId();
  if (references.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 py-1.5 text-left"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="text-xs font-semibold text-[var(--flare)]">Referenced</span>
        <span className="h-px flex-1 bg-[var(--chassis)]" />
        <span className="rounded-full border border-[var(--chassis)] px-1.5 py-0.5 text-[10px] text-[var(--etch)]">
          {references.length}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />}
      </button>
      {open && (
        <div id={contentId} className="space-y-1.5 pb-2">
          {references.map((ref) => (
            <ReferencedItem key={`${ref.label}-${ref.targetId ?? ref.value}`} reference={ref} node={ref.targetId ? nodesById.get(ref.targetId) : undefined} graph={graph} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReferencedItem({ reference, node, graph }: { reference: ReferencedRelationship; node?: GraphNode; graph: Graph }) {
  const location = nodeLocation(node, graph);
  const openCode = async () => {
    if (!location?.file) return;
    try {
      await window.laralens.openCodeWindow(location.file, location.line);
    } catch (error) {
      console.error("Failed to open code window", error);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-[var(--chassis)]/70 py-1.5 last:border-b-0">
      <Badge variant="secondary" className="shrink-0">{reference.label}</Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--flare)]" title={reference.value}>{node?.label ?? reference.value}</span>
      {location?.file && (
        <button type="button" onClick={openCode} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--etch)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--flare)]" title={`Open ${location.file}${location.line ? `:${location.line}` : ""}`}>
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function RelationshipSection({
  title,
  kind,
  edges,
  nodesById,
}: {
  title: string;
  kind: "in" | "out";
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
}) {
  const [open, setOpen] = useState(edges.length > 0);
  const contentId = useId();

  if (edges.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 py-1.5 text-left"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className="text-xs font-semibold text-[var(--flare)]">{title}</span>
        <span className="h-px flex-1 bg-[var(--chassis)]" />
        <span className="rounded-full border border-[var(--chassis)] px-1.5 py-0.5 text-[10px] text-[var(--etch)]">
          {edges.length}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--etch)]" />
        )}
      </button>

      {open && (
        <div id={contentId} className="space-y-1.5 pb-2">
          {edges.map((edge) => (
            <RelationshipItem
              key={edge.id}
              kind={kind}
              edge={edge}
              otherNode={nodesById.get(kind === "out" ? edge.target : edge.source)}
              graphNodesById={nodesById}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RelationshipItem({
  kind,
  edge,
  otherNode,
  graphNodesById,
}: {
  kind: "in" | "out";
  edge: GraphEdge;
  otherNode?: GraphNode;
  graphNodesById: Map<string, GraphNode>;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const other = otherNode?.label ?? (kind === "out" ? edge.target : edge.source);
  const graph = graphFromNodeMap(graphNodesById);
  const location = nodeLocation(otherNode, graph);

  const openCode = async () => {
    if (!location?.file) return;
    try {
      await window.laralens.openCodeWindow(location.file, location.line);
    } catch (error) {
      console.error("Failed to open code window", error);
    }
  };

  return (
    <div className="border-b border-[var(--chassis)]/70 pb-1.5 last:border-b-0">
      <div className="flex items-center gap-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          aria-controls={contentId}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--etch)]" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--etch)]" />
          )}
          <Badge variant={kind === "out" ? "default" : "secondary"} className="shrink-0">
            {relationshipLabel(edge, kind)}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--flare)]">
            {other}
          </span>
        </button>
        {location?.file && (
          <button
            type="button"
            onClick={openCode}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--etch)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--flare)]"
            title={`Open ${location.file}${location.line ? `:${location.line}` : ""}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div id={contentId} className="ml-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 pb-1 text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-[var(--etch)]">Direction</span>
          <span className="truncate text-[var(--etch)]">{kind === "out" ? "Outgoing" : "Incoming"}</span>
          <span className="font-semibold uppercase tracking-wider text-[var(--etch)]">Type</span>
          <span className="truncate text-[var(--etch)]">{edge.type}</span>
          <span className="font-semibold uppercase tracking-wider text-[var(--etch)]">ID</span>
          <span className="truncate font-mono text-[var(--etch)]" title={edge.id}>{edge.id}</span>
          {location?.file && (
            <>
              <span className="font-semibold uppercase tracking-wider text-[var(--etch)]">File</span>
              <span className="truncate font-mono text-[var(--etch)]" title={location.file}>
                {location.file}{location.line ? `:${location.line}` : ""}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (!value || value === "[]" || value === "{}") return null;
  return (
    <div className="mb-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
        {label}
      </div>
      <div
        className={`mt-1 break-words text-sm text-[var(--flare)] ${mono ? "font-mono text-[11px]" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function isHiddenInspectorEdge(edge: GraphEdge): boolean {
  return false;
}

function graphFromNodeMap(nodesById: Map<string, GraphNode>): Graph {
  return {
    meta: { project: "", analyzedAt: "", nodeCount: nodesById.size, edgeCount: 0 },
    nodes: [...nodesById.values()],
    edges: [],
  };
}

function relationshipLabel(edge: GraphEdge, kind: "in" | "out"): string {
  if (kind === "out") return edge.label;

  return INCOMING_RELATIONSHIP_LABELS[edge.type] ?? edge.label;
}

const INCOMING_RELATIONSHIP_LABELS: Record<string, string> = {
  "request-middleware": "receives request from",
};

interface ReferencedRelationship {
  label: string;
  value: string;
  targetId?: string;
}

function referencedRelationships(node: GraphNode, graph: Graph): ReferencedRelationship[] {
  const refs: ReferencedRelationship[] = [];
  const extendsValue = node.data.extends;
  if (typeof extendsValue === "string" && extendsValue.length > 0) {
    refs.push({
      label: "extends",
      value: extendsValue,
      targetId: typeof node.data.extendsTargetId === "string" ? node.data.extendsTargetId : undefined,
    });
  }

  const validates = node.data.validates;
  if (Array.isArray(validates)) {
    for (const fqcn of validates) {
      if (typeof fqcn !== "string") continue;
      const targetId = `validation_request::${fqcn}`;
      refs.push({ label: "validates", value: fqcn, targetId: graph.nodes.some((n) => n.id === targetId) ? targetId : undefined });
    }
  }
  return refs;
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
