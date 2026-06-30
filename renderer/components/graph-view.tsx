"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NodeCard, type LaraLensNodeData } from "./node-card";
import { layoutGraph } from "@/lib/layout";
import { ACCENT_COLORS, nodeSubtitle } from "@/lib/graph";
import type { Graph, GraphNode, NodeType } from "@/lib/types";

const nodeTypes: NodeTypes = { laraNode: NodeCard };

interface GraphViewProps {
  graph: Graph;
  activeTypes: Set<NodeType>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function GraphCanvas({ graph, activeTypes, selectedId, onSelect }: GraphViewProps) {
  const { nodes: laidOut, edges } = useMemo(() => {
    const { nodes: positioned } = layoutGraph(graph);

    // Filter by active types; keep edges whose both endpoints survive.
    const visibleIds = new Set(
      positioned.filter((n) => activeTypes.has(n.type)).map((n) => n.id)
    );

    const rfNodes: Node<LaraLensNodeData>[] = positioned
      .filter((n) => visibleIds.has(n.id))
      .map((n: GraphNode & { position: { x: number; y: number } }) => ({
        id: n.id,
        type: "laraNode",
        position: n.position,
        data: {
          label: n.label,
          nodeType: n.type,
          subtitle: nodeSubtitle(n),
          accent: ACCENT_COLORS[n.type],
          ...n.data,
        },
        selected: n.id === selectedId,
      }));

    const rfEdges: Edge[] = graph.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: "smoothstep",
        animated: false,
        style: { stroke: "var(--border)", strokeWidth: 1.2 },
        labelStyle: { fontSize: 10, fill: "var(--muted-foreground)" },
        labelBgStyle: { fill: "var(--card)" },
      }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [graph, activeTypes, selectedId]);

  const [nodes, setNodes, onNodesChange] = useNodesState(laidOut);
  const [edgesState, setEdges, onEdgesChange] = useEdgesState(edges);

  // Sync when the underlying graph/selection/filter changes.
  useEffect(() => {
    setNodes(laidOut);
    setEdges(edges);
  }, [laidOut, edges, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => onSelect(node.id),
    [onSelect]
  );

  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);

  return (
    <div
      className="w-full min-w-0 bg-background"
      style={{ height: "calc(100vh - 3.5rem)" }}
    >
      <ReactFlow
        className="h-full w-full"
        style={{ width: "100%", height: "100%" }}
        nodes={nodes}
        edges={edgesState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2.5}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls
          className="!rounded-md !border !border-border !bg-card !shadow-sm"
          showInteractive={false}
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

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
