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
import { nodeLocation } from "./node-location";
import { displayHttpMethod } from "./graph";

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
  file: -1,
  method: 0,
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

const REFERENCE_ONLY_NODE_TYPES = new Set<NodeType>([
  "model",
  "enum",
  "interface",
  "trait",
  "abstract_class",
  "facade",
]);

const REFERENCE_ONLY_EDGE_TYPES = new Set([
  "action-to-model",
  "model-relationship",
  "controller-extends",
]);

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
  graph = normalizeRequestPipelineGraph(graph);
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
  graph = normalizeRequestPipelineGraph(graph);
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
 * Build the graph view used for real project work: a route is shown as a
 * file-by-file execution path instead of a raw scanner relationship graph.
 *
 * Reference-only discoveries (models, enums, interfaces, traits, facades, and
 * model relationships) stay available in the Inspector/sidebar because the
 * original graph is untouched, but they do not crowd the canvas. The canvas is
 * intentionally reduced to files and callable methods so a developer can see:
 * routes file -> route definition -> middleware file -> handle() -> controller
 * file -> action() -> runtime call-outs.
 */
export function buildRouteDevelopmentSubgraph(
  graph: Graph,
  routeId: string,
  withLifecycle: boolean
): Graph {
  const sourceGraph = normalizeRequestPipelineGraph(graph);
  const raw = buildRouteFlowOnlySubgraph(sourceGraph, routeId, withLifecycle);
  const sourceById = new Map(sourceGraph.nodes.map((node) => [node.id, node]));
  const outputNodes = new Map<string, GraphNode>();
  const outputEdges = new Map<string, GraphEdge>();
  const nodeMap = new Map<string, { entryId: string; exitId: string }>();

  const addNode = (node: GraphNode) => {
    if (!outputNodes.has(node.id)) outputNodes.set(node.id, node);
  };

  const addEdge = (edge: GraphEdge) => {
    if (edge.source === edge.target) return;
    const key = `${edge.source}->${edge.target}:${edge.type}`;
    if (!outputEdges.has(key)) outputEdges.set(key, edge);
  };

  for (const node of raw.nodes) {
    if (REFERENCE_ONLY_NODE_TYPES.has(node.type)) continue;

    if (node.type === "lifecycle") {
      addNode(node);
      nodeMap.set(node.id, { entryId: node.id, exitId: node.id });
      continue;
    }

    const sourceNode = sourceById.get(String(node.data.originalNodeId ?? node.id)) ?? node;
    const location = nodeLocation(sourceNode, sourceGraph) ?? nodeLocation(node, raw);
    const hasMethod = shouldRenderAsMethod(sourceNode);

    if (!location?.file && !hasMethod) continue;

    let entryId: string;
    let exitId: string;

    if (location?.file) {
      const fileNode = makeFileNode(location.file, sourceNode);
      addNode(fileNode);
      entryId = fileNode.id;
      exitId = fileNode.id;

      if (hasMethod) {
        const methodNode = makeMethodNode(sourceNode, location.file, location.line);
        addNode(methodNode);
        addEdge({
          id: `file-method::${fileNode.id}::${methodNode.id}`,
          source: fileNode.id,
          target: methodNode.id,
          label: "contains",
          type: "file-to-method",
        });
        exitId = methodNode.id;
      }
    } else {
      const methodNode = makeMethodNode(sourceNode);
      addNode(methodNode);
      entryId = methodNode.id;
      exitId = methodNode.id;
    }

    nodeMap.set(node.id, { entryId, exitId });
  }

  for (const edge of raw.edges) {
    if (REFERENCE_ONLY_EDGE_TYPES.has(edge.type)) continue;
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;

    const targetId = flowTargetId(source, target);
    if (!targetId) continue;

    addEdge({
      ...edge,
      id: `development::${edge.id}`,
      source: source.exitId,
      target: targetId,
    });
  }

  return {
    meta: raw.meta,
    nodes: [...outputNodes.values()],
    edges: [...outputEdges.values()],
  };
}

function buildRouteFlowOnlySubgraph(
  graph: Graph,
  routeId: string,
  withLifecycle: boolean
): Graph {
  const routeNode = graph.nodes.find((node) => node.id === routeId);
  if (!routeNode) return { meta: graph.meta, nodes: [], edges: [] };

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outEdges = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!isRouteFlowEdge(edge, routeNode)) continue;
    const arr = outEdges.get(edge.source) ?? [];
    arr.push(edge);
    outEdges.set(edge.source, arr);
  }

  const ids = new Set<string>();
  const edgeIds = new Set<string>();
  const queue = [routeId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    ids.add(id);

    for (const edge of outEdges.get(id) ?? []) {
      if (!byId.has(edge.target)) continue;
      edgeIds.add(edge.id);
      if (!ids.has(edge.target)) queue.push(edge.target);
    }
  }

  const nodes = graph.nodes.filter((node) => ids.has(node.id));
  const edges = graph.edges.filter(
    (edge) => edgeIds.has(edge.id) && ids.has(edge.source) && ids.has(edge.target)
  );

  if (!withLifecycle) return { meta: graph.meta, nodes, edges };

  const chain = buildLifecycleChain(routeId);
  return {
    meta: graph.meta,
    nodes: [...chain.nodes, ...nodes],
    edges: [...chain.edges, ...edges],
  };
}

function isRouteFlowEdge(edge: GraphEdge, routeNode: GraphNode): boolean {
  if (REFERENCE_ONLY_EDGE_TYPES.has(edge.type)) return false;
  if (edge.type === "controller-to-action") {
    const routeAction = typeof routeNode.data.action === "string" ? routeNode.data.action : "";
    if (routeAction) return edge.target.endsWith(`::${routeAction}`);
  }
  return true;
}

function flowTargetId(
  source: { entryId: string; exitId: string },
  target: { entryId: string; exitId: string }
): string | null {
  // When a class-level node and its method live in the same file, routing the
  // flow edge back into the file container creates loops or self-edges and makes
  // the canvas look disconnected. In that case, continue straight to the method.
  if (
    (source.entryId === target.entryId || source.exitId === target.entryId) &&
    target.exitId !== target.entryId
  ) {
    return target.exitId;
  }
  if (source.exitId === target.entryId) return null;
  return target.entryId;
}

function shouldRenderAsMethod(node: GraphNode): boolean {
  if ([
    "route",
    "middleware",
    "controller",
    "action",
    "service",
    "validation_request",
    "filament_page_method",
  ].includes(node.type)) {
    return true;
  }
  return typeof node.data.method === "string" && node.data.method.length > 0;
}

function makeFileNode(file: string, sourceNode: GraphNode): GraphNode {
  return {
    id: `file::${file}`,
    type: "file",
    label: basename(file),
    data: {
      file,
      path: file,
      originalNodeId: sourceNode.id,
      originalNodeType: sourceNode.type,
    },
  };
}

function makeMethodNode(sourceNode: GraphNode, file?: string, line?: number): GraphNode {
  const label = methodLabel(sourceNode);
  return {
    id: `method::${sourceNode.id}`,
    type: "method",
    label,
    data: {
      ...sourceNode.data,
      file: file ?? sourceNode.data.file,
      line: line ?? sourceNode.data.line,
      method: methodName(sourceNode),
      signature: methodSignature(sourceNode),
      originalNodeId: sourceNode.id,
      originalNodeType: sourceNode.type,
      originalLabel: sourceNode.label,
    },
  };
}

function methodName(node: GraphNode): string {
  if (node.type === "route") return displayHttpMethod(node.data.method) || "Route";
  if (node.type === "middleware") return "handle";
  if (node.type === "controller") return node.label;
  if (node.type === "validation_request") return "rules";
  return String(node.data.method ?? node.label ?? "method");
}

function methodLabel(node: GraphNode): string {
  if (node.type === "route") {
    return `${displayHttpMethod(node.data.method)} ${String(node.data.uri ?? node.label)}`.trim();
  }
  if (node.type === "middleware") return `${middlewareDisplayName(node)} · handle()`;
  if (node.type === "controller") return node.label;
  if (node.type === "validation_request") return "rules()";
  const method = methodName(node);
  return method.endsWith(")") ? method : `${method}()`;
}

function methodSignature(node: GraphNode): string {
  const fqcn = String(node.data.fqcn ?? "");
  const method = methodName(node);
  if (node.type === "route") return `${displayHttpMethod(node.data.method)} ${node.data.uri ?? ""}`.trim();
  return fqcn ? `${fqcn}::${method}` : method;
}

function middlewareDisplayName(node: GraphNode): string {
  const alias = String(node.data.alias ?? "");
  if (alias) return alias;
  return node.label || String(node.data.fqcn ?? "Middleware");
}

function basename(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? file;
}

function normalizeRequestPipelineGraph(graph: Graph): Graph {
  const legacyMiddlewareEdges = graph.edges.filter((edge) => edge.type === "route-to-middleware");
  if (legacyMiddlewareEdges.length === 0) return graph;

  const edgesByRoute = new Map<string, typeof legacyMiddlewareEdges>();
  for (const edge of legacyMiddlewareEdges) {
    const arr = edgesByRoute.get(edge.source) ?? [];
    arr.push(edge);
    edgesByRoute.set(edge.source, arr);
  }

  const normalizedEdges = graph.edges.filter(
    (edge) => edge.type !== "route-to-middleware" && !(
      edge.type === "route-to-controller" && edgesByRoute.has(edge.source)
    )
  );

  for (const [routeId, middlewareEdges] of edgesByRoute) {
    const controllerEdges = graph.edges.filter(
      (edge) => edge.source === routeId && edge.type === "route-to-controller"
    );
    if (controllerEdges.length === 0) {
      normalizedEdges.push(...middlewareEdges.map((edge, index) => ({
        ...edge,
        id: `normalized::${edge.id}`,
        label: index === 0 ? "passes through" : "then",
        type: "request-middleware",
      })));
      continue;
    }

    let previousId = routeId;
    middlewareEdges.forEach((edge, index) => {
      normalizedEdges.push({
        ...edge,
        id: `normalized::${edge.id}`,
        source: previousId,
        target: edge.target,
        label: index === 0 ? "passes through" : "then",
        type: "request-middleware",
      });
      previousId = edge.target;
    });

    controllerEdges.forEach((edge, index) => {
      normalizedEdges.push({
        ...edge,
        id: `normalized::${edge.id}`,
        source: index === 0 ? previousId : routeId,
        label: index === 0 ? "continues to" : edge.label,
      });
    });
  }

  return { ...graph, edges: normalizedEdges };
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
  setDepths(real, chainNodes.length);

  let child: DescendantTreeNode = real;
  for (let i = chainNodes.length - 1; i >= 0; i--) {
    const node = chainNodes[i]!;
    const edge = chain.edges.find((e) => e.target === node.id);
    child = { node, edge, depth: i, children: [child] };
  }
  return child; // root = index
}

function setDepths(node: DescendantTreeNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) setDepths(child, depth + 1);
}
