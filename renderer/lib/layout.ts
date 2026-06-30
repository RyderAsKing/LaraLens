import type { Graph, GraphNode } from "./types";

interface PositionedNode extends GraphNode {
  position: { x: number; y: number };
}

/**
 * Layered layout: compute each node's "depth" (column) via BFS from route/command
 * seeds, then stack nodes vertically within each column. Produces a clean
 * left-to-right architecture flow without an external graph-layout dependency.
 */
export function layoutGraph(graph: Graph): {
  nodes: (GraphNode & { position: { x: number; y: number } })[];
} {
  const COLUMN_WIDTH = 260;
  const ROW_HEIGHT = 110;
  const PAD = 40;

  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of graph.nodes) {
    adjacency.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of graph.edges) {
    if (!adjacency.has(e.source) || !inDegree.has(e.target)) continue;
    adjacency.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  // Seed: route nodes first, then any zero-in-degree node.
  const seeds = graph.nodes
    .filter((n) => n.type === "route")
    .map((n) => n.id);
  const zeroIn = graph.nodes
    .filter((n) => n.type !== "route" && (inDegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const queue = [...seeds, ...zeroIn];

  const depth = new Map<string, number>();
  for (const id of queue) depth.set(id, 0);

  // BFS (Kahn-ish) for longest-path depth.
  let head = 0;
  const remaining = new Map(inDegree);
  // Reset in-degree counts for seed nodes so they propagate.
  for (const id of queue) remaining.set(id, 0);
  while (head < queue.length) {
    const id = queue[head++]!;
    const d = depth.get(id) ?? 0;
    for (const next of adjacency.get(id) ?? []) {
      const nd = d + 1;
      if (nd > (depth.get(next) ?? 0)) depth.set(next, nd);
      remaining.set(next, (remaining.get(next) ?? 1) - 1);
      if ((remaining.get(next) ?? 0) <= 0 && !queue.includes(next)) {
        queue.push(next);
      }
    }
  }

  // Any unreached nodes get depth 0.
  for (const n of graph.nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  }

  // Group by column, then order within column by type priority then label.
  const columns = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n);
  }

  const positioned: (GraphNode & { position: { x: number; y: number } })[] = [];
  for (const [col, nodes] of columns) {
    nodes.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
    nodes.forEach((n, i) => {
      positioned.push({ ...n, position: { x: PAD + col * COLUMN_WIDTH, y: PAD + i * ROW_HEIGHT } });
    });
  }
  return { nodes: positioned };
}

export type { PositionedNode };
