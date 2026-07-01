"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Boxes, Tags } from "lucide-react";
import { ModelNodeCard, modelNodeHeight } from "./model-node-card";
import { type LaraLensNodeData } from "./node-card";
import { layoutHierarchyGraph } from "@/lib/layout";
import { ACCENT_COLORS, displayNodeType, nodeSubtitle } from "@/lib/graph";
import {
  buildModelRelationshipGraph,
  modelRelationshipSeedIds,
  modelRelationshipStats,
} from "@/lib/model-relationships";
import { logMissingNodeLocation, nodeLocation } from "@/lib/node-location";
import type { Graph, GraphNode } from "@/lib/types";
import { cn } from "@/lib/utils";

const nodeTypes: NodeTypes = { laraNode: ModelNodeCard };

interface ModelRelationshipViewProps {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ModelRelationshipView({
  graph,
  selectedId,
  onSelect,
}: ModelRelationshipViewProps) {
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const stats = useMemo(() => modelRelationshipStats(graph), [graph]);

  if (stats.modelCount === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <Boxes className="mb-3 h-8 w-8 text-[var(--etch)]" />
        <p className="text-sm text-[var(--etch)]">
          No Eloquent models were found in this project.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--chassis)] px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4" style={{ color: ACCENT_COLORS.model }} />
            <span className="text-sm font-semibold text-[var(--flare)]">
              Models
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs text-[var(--etch)]">
            <span className="tabular-nums">
              {stats.modelCount} {stats.modelCount === 1 ? "model" : "models"}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {stats.relationshipCount}{" "}
              {stats.relationshipCount === 1 ? "relationship" : "relationships"}
            </span>
            {stats.relationshipCount === 0 ? (
              <span className="text-[var(--etch)]">
                · No Eloquent relationships detected
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEdgeLabels((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                showEdgeLabels
                  ? "border-[var(--aperture)]/30 bg-[var(--aperture)]/10 text-[var(--flare)]"
                  : "border-[var(--chassis)] text-[var(--etch)] hover:text-[var(--flare)] hover:bg-[var(--accent)]"
              )}
              title="Toggle relationship labels on graph edges"
            >
              <Tags className="h-3.5 w-3.5" />
              Edge labels
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ReactFlowProvider>
          <ModelRelationshipCanvas
            graph={graph}
            showEdgeLabels={showEdgeLabels}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

interface ModelRelationshipCanvasProps {
  graph: Graph;
  showEdgeLabels: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function ModelRelationshipCanvas({
  graph,
  showEdgeLabels,
  selectedId,
  onSelect,
}: ModelRelationshipCanvasProps) {
  const subgraph = useMemo(
    () => buildModelRelationshipGraph(graph),
    [graph]
  );

  const seedIds = useMemo(
    () => modelRelationshipSeedIds(subgraph),
    [subgraph]
  );

  const { nodes: laidOut, edges } = useMemo(() => {
    const { nodes: positioned } = layoutHierarchyGraph(subgraph, seedIds, {
      nodeHeight: modelNodeHeight,
    });
    const rfNodes: Node<LaraLensNodeData>[] = positioned.map(
      (n: GraphNode & { position: { x: number; y: number } }) => {
        const nodeType = displayNodeType(n);
        return {
          id: n.id,
          type: "laraNode",
          position: n.position,
          data: {
            ...n.data,
            label: n.label,
            nodeType,
            subtitle: nodeSubtitle(n),
            accent: ACCENT_COLORS[nodeType],
          },
          selected: n.id === selectedId,
        };
      }
    );

    const rfEdges: Edge[] = subgraph.edges.map((e) => {
      const active = selectedId !== null && (e.source === selectedId || e.target === selectedId);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: showEdgeLabels || active ? e.label : undefined,
        type: "smoothstep",
        animated: active,
        style: {
          stroke: active ? "var(--aperture)" : "var(--border)",
          strokeWidth: active ? 1.8 : 1,
          opacity: active ? 0.95 : 0.72,
        },
        labelStyle: {
          fontSize: active ? 11 : 10,
          fontWeight: active ? 600 : 400,
          fill: active ? "var(--flare)" : "var(--muted-foreground)",
        },
        labelBgStyle: { fill: "var(--card)", fillOpacity: active ? 0.96 : 0.9 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [subgraph, seedIds, selectedId, showEdgeLabels]);

  const [nodes, setNodes, onNodesChange] = useNodesState(laidOut);
  const [edgesState, setEdges, onEdgesChange] = useEdgesState(edges);

  useEffect(() => {
    setNodes(laidOut);
    setEdges(edges);
  }, [laidOut, edges, setNodes, setEdges]);

  useEffect(() => {
    const handler = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string" && id.length > 0) onSelect(id);
    };
    window.addEventListener("laralens:select-node", handler);
    return () => window.removeEventListener("laralens:select-node", handler);
  }, [onSelect]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelect(node.id);
    },
    [onSelect]
  );

  const handleNodeDoubleClick = useCallback(
    async (_: React.MouseEvent, node: Node) => {
      const graphNode = subgraph.nodes.find((n) => n.id === node.id);
      const location =
        nodeLocation(graphNode, subgraph) ?? nodeLocation(graphNode, graph);
      if (!location) {
        logMissingNodeLocation(graphNode, graph, "model node double-click");
        return;
      }
      try {
        await window.laralens.openCodeWindow(location.file, location.line);
      } catch (error) {
        console.error("Failed to open code window", error);
      }
    },
    [graph, subgraph]
  );

  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);

  return (
    <div className="h-full w-full min-w-0 bg-background">
      <ReactFlow
        className="h-full w-full"
        style={{ width: "100%", height: "100%" }}
        nodes={nodes}
        edges={edgesState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.45, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2.5}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border)"
        />
        <MiniMap
          pannable
          zoomable
          className="!rounded-md !border !border-border !bg-card"
          maskColor="rgba(0,0,0,0.4)"
          nodeColor={(n) => (n.data as LaraLensNodeData).accent ?? "#94a3b8"}
        />
      </ReactFlow>
    </div>
  );
}
