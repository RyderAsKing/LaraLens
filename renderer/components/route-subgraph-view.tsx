"use client";

import { useCallback, useEffect, useMemo } from "react";
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
import { NodeCard, type LaraLensNodeData } from "./node-card";
import { layoutHierarchyGraph } from "@/lib/layout";
import { ACCENT_COLORS, nodeSubtitle } from "@/lib/graph";
import { buildRouteDevelopmentSubgraph, subgraphSeedIds } from "@/lib/route-tree";
import { logMissingNodeLocation, nodeLocation } from "@/lib/node-location";
import type { Graph, GraphNode } from "@/lib/types";

const nodeTypes: NodeTypes = { laraNode: NodeCard };

interface RouteSubgraphViewProps {
  graph: Graph;
  routeId: string;
  withLifecycle: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function RouteSubgraphCanvas({
  graph,
  routeId,
  withLifecycle,
  selectedId,
  onSelect,
}: RouteSubgraphViewProps) {
  const subgraph = useMemo(
    () => buildRouteDevelopmentSubgraph(graph, routeId, withLifecycle),
    [graph, routeId, withLifecycle]
  );

  const seedIds = useMemo(
    () => subgraphSeedIds(withLifecycle),
    [withLifecycle]
  );

  const { nodes: laidOut, edges } = useMemo(() => {
    const { nodes: positioned } = layoutHierarchyGraph(subgraph, seedIds);

    const rfNodes: Node<LaraLensNodeData>[] = positioned.map(
      (n: GraphNode & { position: { x: number; y: number } }) => ({
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
        selected: n.id === selectedId || n.data.originalNodeId === selectedId,
      })
    );

    const rfEdges: Edge[] = subgraph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: "smoothstep",
      animated: false,
      style: { stroke: "var(--border)", strokeWidth: 1.4 },
      labelStyle: { fontSize: 12, fill: "var(--muted-foreground)" },
      labelBgStyle: { fill: "var(--card)" },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [subgraph, seedIds, selectedId]);

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
      const graphNode = subgraph.nodes.find((n) => n.id === node.id);
      const originalNodeId = graphNode?.data.originalNodeId;
      onSelect(typeof originalNodeId === "string" ? originalNodeId : node.id);
    },
    [onSelect, subgraph]
  );

  const handleNodeDoubleClick = useCallback(
    async (_: React.MouseEvent, node: Node) => {
      const graphNode = subgraph.nodes.find((n) => n.id === node.id);
      const originalNodeId = graphNode?.data.originalNodeId;
      const originalNode = typeof originalNodeId === "string"
        ? graph.nodes.find((n) => n.id === originalNodeId)
        : undefined;
      const location = nodeLocation(graphNode, subgraph) ?? nodeLocation(originalNode, graph) ?? nodeLocation(graph.nodes.find((n) => n.id === node.id), graph);
      if (!location) {
        logMissingNodeLocation(graphNode ?? originalNode ?? graph.nodes.find((n) => n.id === node.id), graph, "graph node double-click");
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
        fitViewOptions={{ padding: 0.35, maxZoom: 1.1 }}
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

export function RouteSubgraphView(props: RouteSubgraphViewProps) {
  return (
    <ReactFlowProvider>
      <RouteSubgraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
