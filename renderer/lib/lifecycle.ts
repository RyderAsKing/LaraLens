/**
 * Synthesizes the Laravel request lifecycle bootstrap chain as virtual graph
 * nodes + edges, so the "Request lifecycle" toggle can show how a request
 * reaches a route (entry -> bootstrap -> kernel -> router -> route).
 *
 * These are framework-level files that LaraLens does not scan as classes
 * (public/index.php, bootstrap/app.php, the HTTP kernel, the router). They are
 * represented as `lifecycle` pseudo-nodes connected to the selected route.
 */

import type { GraphEdge, GraphNode } from "./types";

export interface LifecycleChain {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Node ids used in the synthesized lifecycle chain. */
export const LIFECYCLE_IDS = {
  index: "lifecycle::index",
  bootstrap: "lifecycle::bootstrap",
  kernel: "lifecycle::kernel",
  router: "lifecycle::router",
} as const;

const PHASES: Record<string, { label: string; file: string; phase: string }> = {
  [LIFECYCLE_IDS.index]: {
    label: "index.php",
    file: "public/index.php",
    phase: "Entry",
  },
  [LIFECYCLE_IDS.bootstrap]: {
    label: "bootstrap/app.php",
    file: "bootstrap/app.php",
    phase: "Bootstrap",
  },
  [LIFECYCLE_IDS.kernel]: {
    label: "HTTP Kernel",
    file: "app/Http/Kernel.php",
    phase: "Kernel",
  },
  [LIFECYCLE_IDS.router]: {
    label: "Router",
    file: "Illuminate\\Routing\\Router",
    phase: "Routing",
  },
};

/**
 * Build the lifecycle chain nodes + edges. The final edge connects the router
 * to the given `routeId` (label "matches"), so the chain plugs into the route.
 */
export function buildLifecycleChain(routeId: string): LifecycleChain {
  const order = [
    LIFECYCLE_IDS.index,
    LIFECYCLE_IDS.bootstrap,
    LIFECYCLE_IDS.kernel,
    LIFECYCLE_IDS.router,
  ];

  const nodes: GraphNode[] = order.map((id) => {
    const p = PHASES[id];
    return {
      id,
      type: "lifecycle",
      label: p.label,
      data: { file: p.file, phase: p.phase },
    };
  });

  const edgeLabels: Record<string, string> = {
    [LIFECYCLE_IDS.bootstrap]: "boots",
    [LIFECYCLE_IDS.kernel]: "binds",
    [LIFECYCLE_IDS.router]: "dispatches",
  };

  const edges: GraphEdge[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const source = order[i]!;
    const target = order[i + 1]!;
    edges.push({
      id: `${source}->${target}:lifecycle`,
      source,
      target,
      label: edgeLabels[target] ?? "loads",
      type: "lifecycle",
    });
  }
  // Router matches the route.
  edges.push({
    id: `${LIFECYCLE_IDS.router}->${routeId}:lifecycle-route`,
    source: LIFECYCLE_IDS.router,
    target: routeId,
    label: "matches",
    type: "lifecycle-route",
  });

  return { nodes, edges };
}
