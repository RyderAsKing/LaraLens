/**
 * Tree builders for the Route Explorer (left sidebar) and Route Detail (main area).
 *
 * - `buildRouteUriTree` groups every route node by URI prefix segments so the
 *   sidebar can render a collapsible folder-like tree (e.g. `api` > `users` >
 *   `{id}`).
 * - `buildRouteDescendantTree` walks every outgoing edge from a selected route
 *   so the main area can render a hierarchy of everything reachable from it
 *   (controller > actions > models / services / events / jobs / middleware ...).
 */

import type { Graph, GraphEdge, GraphNode, NodeType } from "./types";
import { buildLifecycleChain, LIFECYCLE_IDS } from "./lifecycle";

/* -------------------------------------------------------------------------- */
/* URI prefix tree (Route Explorer sidebar)                                   */
/* -------------------------------------------------------------------------- */

export interface UriTreeNode {
  /** Segment label; "/" for the root node. */
  segment: string;
  /** Accumulated path; "/" for root, "/api" for a first-level child, etc. */
  path: string;
  children: UriTreeNode[];
  /** Route nodes whose URI ends exactly at this segment. */
  routes: GraphNode[];
  /** Total routes in this subtree (including this node's own routes). */
  routeCount: number;
}

/** Sort URI segments: static segments first (alphabetical), then `{param}`. */
function segmentCompare(a: string, b: string): number {
  const aParam = a.startsWith("{");
  const bParam = b.startsWith("{");
  if (aParam !== bParam) return aParam ? 1 : -1;
  return a.localeCompare(b);
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ANY"];

function methodRank(route: GraphNode): number {
  const m = String(route.data.method ?? "").toUpperCase();
  const idx = METHOD_ORDER.indexOf(m);
  return idx === -1 ? 99 : idx;
}

/**
 * Build a URI prefix tree from all route nodes in the graph.
 * The returned root node has `segment: "/"`; routes whose URI is `/` live in
 * `root.routes`, everything else is nested under `root.children`.
 */
export function buildRouteUriTree(graph: Graph): UriTreeNode {
  const root: UriTreeNode = {
    segment: "/",
    path: "/",
    children: [],
    routes: [],
    routeCount: 0,
  };

  const routeNodes = graph.nodes.filter((n) => n.type === "route");

  for (const route of routeNodes) {
    const uri = String(route.data.uri ?? "/");
    const segments = uri.split("/").filter(Boolean);
    let node = root;
    let path = "";
    for (const seg of segments) {
      path += "/" + seg;
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, path, children: [], routes: [], routeCount: 0 };
        node.children.push(child);
      }
      node = child;
    }
    node.routes.push(route);
  }

  // Sort children + routes, and compute subtree route counts.
  const finalize = (node: UriTreeNode): number => {
    node.children.sort((a, b) => segmentCompare(a.segment, b.segment));
    node.routes.sort((a, b) => methodRank(a) - methodRank(b));
    let total = node.routes.length;
    for (const child of node.children) total += finalize(child);
    node.routeCount = total;
    return total;
  };
  finalize(root);

  return root;
}

/* -------------------------------------------------------------------------- */
/* Reachable-from-route descendant tree (Route Detail main area)              */
/* -------------------------------------------------------------------------- */

export interface DescendantTreeNode {
  node: GraphNode;
  /** Edge from the parent to this node; undefined for the route root. */
  edge?: GraphEdge;
  depth: number;
  children: DescendantTreeNode[];
}

/** Sort priority for descendant-tree children (controllers first, etc.). */
const TYPE_PRIORITY: Record<NodeType, number> = {
  lifecycle: -1,
  controller: 0,
  middleware: 1,
  action: 2,
  validation_request: 3,
  model: 4,
  service: 5,
  job: 6,
  event: 7,
  view: 8,
  mail: 9,
  notification: 10,
  enum: 11,
  interface: 12,
  trait: 13,
  abstract_class: 14,
  facade: 15,
  command: 16,
  schedule: 17,
  channel: 18,
  service_provider: 19,
  livewire_component: 20,
  filament_panel: 21,
  filament_resource: 22,
  filament_page: 23,
  filament_page_method: 24,
  filament_widget: 25,
  filament_relation_manager: 26,
  route: 27,
};

const MAX_DEPTH = 64;

/**
 * Build a tree of every node reachable from the given route id by following
 * outgoing edges (route->controller, route->middleware, controller->action,
 * action->model/service/event/job/..., model->model relationships, etc.).
 *
 * Each node appears once (first visit wins) so the result is a clean tree even
 * when the underlying graph is a DAG or contains cycles.
 */
export function buildRouteDescendantTree(
  graph: Graph,
  routeId: string
): DescendantTreeNode | null {
  const start = graph.nodes.find((n) => n.id === routeId);
  if (!start) return null;

  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const arr = outEdges.get(e.source);
    if (arr) arr.push(e);
    else outEdges.set(e.source, [e]);
  }

  const visited = new Set<string>([routeId]);

  const build = (node: GraphNode, edge: GraphEdge | undefined, depth: number): DescendantTreeNode => {
    const children: DescendantTreeNode[] = [];
    if (depth < MAX_DEPTH) {
      const edges = outEdges.get(node.id) ?? [];
      for (const e of edges) {
        if (visited.has(e.target)) continue;
        const childNode = byId.get(e.target);
        if (!childNode) continue;
        visited.add(e.target);
        children.push(build(childNode, e, depth + 1));
      }
      children.sort((a, b) => {
        const pa = TYPE_PRIORITY[a.node.type] ?? 99;
        const pb = TYPE_PRIORITY[b.node.type] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.node.label.localeCompare(b.node.label);
      });
    }
    return { node, edge, depth, children };
  };

  return build(start, undefined, 0);
}

/* -------------------------------------------------------------------------- */
/* Helpers for the route browser + route detail views                          */
/* -------------------------------------------------------------------------- */

/** All route nodes whose `data.uri` equals `uri` (i.e. same path, any method). */
export function routesAtUri(graph: Graph, uri: string): GraphNode[] {
  return graph.nodes.filter(
    (n) => n.type === "route" && String(n.data.uri ?? "") === uri
  );
}

/**
 * Build a sub-`Graph` containing only nodes reachable from the given route
 * (via outgoing edges) plus the edges between them. When `withLifecycle` is
 * true, the synthesized Laravel bootstrap chain is prepended.
 */
export function buildRouteSubgraph(
  graph: Graph,
  routeId: string,
  withLifecycle: boolean
): Graph {
  const tree = buildRouteDescendantTree(graph, routeId);
  if (!tree) {
    return { meta: graph.meta, nodes: [], edges: [] };
  }

  const ids = new Set<string>();
  const collect = (n: DescendantTreeNode) => {
    ids.add(n.node.id);
    for (const c of n.children) collect(c);
  };
  collect(tree);

  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  const edges = graph.edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target)
  );

  if (!withLifecycle) {
    return { meta: graph.meta, nodes, edges };
  }

  const chain = buildLifecycleChain(routeId);
  return {
    meta: graph.meta,
    nodes: [...chain.nodes, ...nodes],
    edges: [...chain.edges, ...edges],
  };
}

/**
 * Seed ids for laying out a route subgraph. With the lifecycle chain enabled,
 * the entry (`index.php`) is the leftmost seed; otherwise the route itself is
 * the seed so its reachable components flow rightward from it.
 */
export function subgraphSeedIds(withLifecycle: boolean): string[] {
  return withLifecycle ? [LIFECYCLE_IDS.index] : [];
}

/**
 * Build the tree rendered in the route-detail "table" view. Without lifecycle
 * this is just the route's descendant tree (root = the route). With lifecycle
 * enabled, the Laravel bootstrap chain is nested above the route:
 *   index.php > bootstrap/app.php > HTTP Kernel > Router > Route > ...
 */
export function buildDisplayTree(
  graph: Graph,
  routeId: string,
  withLifecycle: boolean
): DescendantTreeNode | null {
  const real = buildRouteDescendantTree(graph, routeId);
  if (!real) return null;
  if (!withLifecycle) return real;

  const chain = buildLifecycleChain(routeId);
  const chainNodes = chain.nodes; // [index, bootstrap, kernel, router]

  // The route's incoming lifecycle edge (router -> route, "matches").
  real.edge = chain.edges.find((e) => e.target === routeId) ?? real.edge;

  let child: DescendantTreeNode = real;
  for (let i = chainNodes.length - 1; i >= 0; i--) {
    const node = chainNodes[i]!;
    const edge = chain.edges.find((e) => e.target === node.id);
    child = { node, edge, depth: i, children: [child] };
  }
  return child; // root = index
}
