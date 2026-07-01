/**
 * Helpers for the "Models" feature view.
 *
 * The scanner already emits model nodes (type `"model"`, id `model::${fqcn}`)
 * and `model-relationship` edges (label `${type}()`, e.g. `hasMany()`,
 * `belongsTo()`) into the main graph — see `main/scanner/graph-builder.ts`
 * `addModels()`. These helpers filter that data into a self-contained graph for
 * the model-relationship canvas and pick layout seeds.
 */

import type { Graph } from "./types";

const MODEL_NODE_TYPE = "model";
const MODEL_RELATIONSHIP_EDGE_TYPE = "model-relationship";

/**
 * Build a sub-`Graph` containing only model nodes and the relationship edges
 * between them. Placeholder model nodes (related classes the scanner could not
 * resolve to a file) are kept so dangling relationships remain visible.
 */
export function buildModelRelationshipGraph(graph: Graph): Graph {
  const modelNodeIds = new Set(
    graph.nodes.filter((n) => n.type === MODEL_NODE_TYPE).map((n) => n.id)
  );

  const nodes = graph.nodes.filter((n) => modelNodeIds.has(n.id));
  const edges = graph.edges.filter(
    (e) =>
      e.type === MODEL_RELATIONSHIP_EDGE_TYPE &&
      modelNodeIds.has(e.source) &&
      modelNodeIds.has(e.target)
  );

  return { meta: graph.meta, nodes, edges };
}

export interface ModelRelationshipStats {
  modelCount: number;
  relationshipCount: number;
}

/** Count model nodes and `model-relationship` edges directly on a graph. */
export function modelRelationshipStats(graph: Graph): ModelRelationshipStats {
  let modelCount = 0;
  let relationshipCount = 0;
  for (const n of graph.nodes) {
    if (n.type === MODEL_NODE_TYPE) modelCount++;
  }
  for (const e of graph.edges) {
    if (e.type === MODEL_RELATIONSHIP_EDGE_TYPE) relationshipCount++;
  }
  return { modelCount, relationshipCount };
}

/**
 * Seed ids for the model-relationship layout.
 *
 * Prefers zero-in-degree models — aggregate roots that no other model points
 * back at — so the hierarchy reads parent → child. When every model has an
 * incoming edge (a fully cyclic cluster), falls back to all model ids so the
 * layout still produces a forest instead of collapsing to a single root.
 *
 * Results are sorted by label for deterministic ordering.
 */
export function modelRelationshipSeedIds(graph: Graph): string[] {
  const modelNodes = graph.nodes.filter((n) => n.type === MODEL_NODE_TYPE);
  const modelIds = new Set(modelNodes.map((n) => n.id));

  const inDegree = new Map<string, number>();
  for (const n of modelNodes) inDegree.set(n.id, 0);
  for (const e of graph.edges) {
    if (e.type !== MODEL_RELATIONSHIP_EDGE_TYPE) continue;
    if (!modelIds.has(e.target)) continue;
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const zeroIn = modelNodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const roots = zeroIn.length > 0 ? zeroIn : modelNodes;

  return roots
    .map((n) => ({ id: n.id, label: n.label }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((x) => x.id);
}
