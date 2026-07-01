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
import { ACCENT_COLORS, displayNodeType, nodeSubtitle } from "@/lib/graph";
import { buildRouteDevelopmentSubgraph, subgraphSeedIds } from "@/lib/route-tree";
import { logMissingNodeLocation, nodeLocation } from "@/lib/node-location";
import type { Graph, GraphNode } from "@/lib/types";

const nodeTypes: NodeTypes = { laraNode: NodeCard };

interface RouteSubgraphViewProps {
  graph: Graph;
  routeId: string;
  withLifecycle: boolean;
  showEdgeLabels: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function RouteSubgraphCanvas({
  graph,
  routeId,
  withLifecycle,
  showEdgeLabels,
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
    const selectedSubgraphNodeIds = new Set(
      positioned
        .filter((n) => n.id === selectedId || n.data.originalNodeId === selectedId)
        .map((n) => n.id)
    );
    const activeEdgeIds = lineageEdgeIds(subgraph, selectedSubgraphNodeIds);

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
          selected: n.id === selectedId || n.data.originalNodeId === selectedId,
        };
      }
    );

    const rfEdges: Edge[] = subgraph.edges.map((e) => {
      const active = activeEdgeIds.has(e.id);
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

export function RouteSubgraphView(props: RouteSubgraphViewProps) {
  return (
    <ReactFlowProvider>
      <RouteSubgraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function lineageEdgeIds(graph: Graph, roots: Set<string>): Set<string> {
  const active = new Set<string>();
  if (roots.size === 0) return active;

  const outgoing = new Map<string, typeof graph.edges>();
  const incoming = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const outbound = outgoing.get(edge.source) ?? [];
    outbound.push(edge);
    outgoing.set(edge.source, outbound);

    const inbound = incoming.get(edge.target) ?? [];
    inbound.push(edge);
    incoming.set(edge.target, inbound);
  }

  const visit = (
    edgeMap: Map<string, typeof graph.edges>,
    nextNode: (edge: Graph["edges"][number]) => string
  ) => {
    const visited = new Set<string>();
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
      const nodeId = queue[index];
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      for (const edge of edgeMap.get(nodeId) ?? []) {
        active.add(edge.id);
        const next = nextNode(edge);
        if (!visited.has(next)) queue.push(next);
      }
    }
  };

  // Highlight the selected node's lineage: all incoming path edges leading into
  // it, plus all outgoing path edges below it. Avoid walking outward from
  // ancestors so sibling branches do not light up just because they share a
  // controller or file.
  visit(incoming, (edge) => edge.source);
  visit(outgoing, (edge) => edge.target);

  return active;
}
