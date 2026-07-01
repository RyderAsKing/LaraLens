import type { Graph, GraphNode } from "./types";

interface PositionedNode extends GraphNode {
  position: { x: number; y: number };
}

/**
 * Layered layout: compute each node's "depth" (column) via BFS from the given
 * seeds, then stack nodes vertically within each column. Produces a clean
 * left-to-right architecture flow without an external graph-layout dependency.
 *
 * When `seedIds` is provided, those nodes (in order) are used as the BFS roots.
 * When omitted, the default heuristic seeds route nodes first, then any
 * zero-in-degree node — the right behavior for a full project graph.
 */
export function layoutGraph(
  graph: Graph,
  seedIds?: string[]
): {
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

  // Determine seed nodes.
  let queue: string[];
  if (seedIds && seedIds.length > 0) {
    // Only seeds that actually exist in the graph.
    const present = new Set(graph.nodes.map((n) => n.id));
    queue = seedIds.filter((id) => present.has(id));
  } else {
    // Default heuristic: route nodes first, then zero-in-degree nodes.
    const seeds = graph.nodes
      .filter((n) => n.type === "route")
      .map((n) => n.id);
    const zeroIn = graph.nodes
      .filter((n) => n.type !== "route" && (inDegree.get(n.id) ?? 0) === 0)
      .map((n) => n.id);
    queue = [...seeds, ...zeroIn];
  }

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

/**
 * Left-to-right tree layout for a single route subgraph. The selected route (or
 * lifecycle entry node) starts on the left; files/methods/dependencies branch to
 * the right while siblings stack vertically. This keeps long method labels on
 * their own rows instead of spreading a large file's methods across one level.
 */
export function layoutHierarchyGraph(
  graph: Graph,
  seedIds?: string[]
): {
  nodes: (GraphNode & { position: { x: number; y: number } })[];
} {
  const NODE_HEIGHT = 84;
  const LEVEL_WIDTH = 390;
  const SIBLING_GAP = 56;
  const PAD_X = 80;
  const PAD_Y = 56;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of graph.nodes) {
    adjacency.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adjacency.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  for (const children of adjacency.values()) {
    children.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return na.type.localeCompare(nb.type) || na.label.localeCompare(nb.label);
    });
  }

  const present = new Set(graph.nodes.map((n) => n.id));
  let roots = seedIds?.filter((id) => present.has(id)) ?? [];
  if (roots.length === 0) {
    roots = graph.nodes.filter((n) => n.type === "route").map((n) => n.id);
  }
  if (roots.length === 0) {
    roots = graph.nodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
      .map((n) => n.id);
  }
  if (roots.length === 0 && graph.nodes[0]) roots = [graph.nodes[0].id];

  const measuring = new Set<string>();
  const measured = new Set<string>();
  const subtreeHeight = new Map<string, number>();

  const measure = (id: string): number => {
    if (measured.has(id)) return subtreeHeight.get(id) ?? NODE_HEIGHT;
    if (measuring.has(id)) return NODE_HEIGHT;
    measuring.add(id);
    const children = (adjacency.get(id) ?? []).filter((child) => byId.has(child));
    if (children.length === 0) {
      measuring.delete(id);
      measured.add(id);
      subtreeHeight.set(id, NODE_HEIGHT);
      return NODE_HEIGHT;
    }
    const childTotal = children.reduce((sum, child, index) => {
      return sum + measure(child) + (index === 0 ? 0 : SIBLING_GAP);
    }, 0);
    const height = Math.max(NODE_HEIGHT, childTotal);
    measuring.delete(id);
    measured.add(id);
    subtreeHeight.set(id, height);
    return height;
  };

  roots.forEach(measure);

  const positioned = new Map<string, GraphNode & { position: { x: number; y: number } }>();
  const placed = new Set<string>();

  const place = (id: string, top: number, depth: number) => {
    if (placed.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    placed.add(id);

    const height = subtreeHeight.get(id) ?? NODE_HEIGHT;
    positioned.set(id, {
      ...node,
      position: {
        x: PAD_X + depth * LEVEL_WIDTH,
        y: top + height / 2 - NODE_HEIGHT / 2,
      },
    });

    const children = (adjacency.get(id) ?? []).filter((child) => byId.has(child) && !placed.has(child));
    const childTotal = children.reduce((sum, child, index) => {
      return sum + (subtreeHeight.get(child) ?? NODE_HEIGHT) + (index === 0 ? 0 : SIBLING_GAP);
    }, 0);
    let childTop = top + Math.max(0, (height - childTotal) / 2);
    for (const child of children) {
      place(child, childTop, depth + 1);
      childTop += (subtreeHeight.get(child) ?? NODE_HEIGHT) + SIBLING_GAP;
    }
  };

  let cursor = PAD_Y;
  for (const root of roots) {
    const height = subtreeHeight.get(root) ?? NODE_HEIGHT;
    place(root, cursor, 0);
    cursor += height + SIBLING_GAP;
  }

  // Any disconnected leftovers are still rendered, to the right of the main hierarchy.
  let extraIndex = 0;
  const extraDepth = maxDepth(positioned, PAD_X, LEVEL_WIDTH) + 1;
  for (const n of graph.nodes) {
    if (positioned.has(n.id)) continue;
    positioned.set(n.id, {
      ...n,
      position: {
        x: PAD_X + extraDepth * LEVEL_WIDTH,
        y: PAD_Y + extraIndex * (NODE_HEIGHT + SIBLING_GAP),
      },
    });
    extraIndex++;
  }

  return { nodes: [...positioned.values()] };
}

function maxDepth(
  nodes: Map<string, GraphNode & { position: { x: number; y: number } }>,
  padX: number,
  levelWidth: number
): number {
  let max = 0;
  for (const n of nodes.values()) {
    max = Math.max(max, Math.round((n.position.x - padX) / levelWidth));
  }
  return max;
}

export type { PositionedNode };
