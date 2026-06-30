import type { Graph, GraphNode } from "./types";

export interface NodeLocation {
  file: string;
  line?: number;
}

export function nodeLocation(node?: GraphNode, graph?: Graph): NodeLocation | null {
  const direct = directNodeLocation(node);
  if (direct) return direct;

  if (!node || !graph) return null;

  const sameId = graph.nodes.find((candidate) => candidate.id === node.id && candidate !== node);
  const sameIdLocation = directNodeLocation(sameId);
  if (sameIdLocation) return withOwnLine(node, sameIdLocation);

  // Older scans, and any partially populated action nodes, can have the method
  // line but no file. In that case use the owning controller's file and keep the
  // action's own line so double-click still opens the exact method location.
  if (node.type === "action") {
    const fqcn = node.data.fqcn;
    if (typeof fqcn !== "string" || fqcn.length === 0) return null;
    const controller = graph.nodes.find((candidate) => candidate.id === `controller::${fqcn}`);
    const controllerLocation = directNodeLocation(controller);
    if (controllerLocation) return withOwnLine(node, controllerLocation);
  }

  const fqcn = nodeFqcn(node);
  if (fqcn) {
    const sameClass = graph.nodes.find((candidate) => {
      if (candidate.id === node.id) return false;
      if (nodeFqcn(candidate) !== fqcn) return false;
      return directNodeLocation(candidate) !== null;
    });
    const sameClassLocation = directNodeLocation(sameClass);
    if (sameClassLocation) return withOwnLine(node, sameClassLocation);
  }

  return null;
}

export function logMissingNodeLocation(node?: GraphNode, graph?: Graph, context = "node"): void {
  if (!node) {
    console.warn(`[LaraLens] Cannot open ${context}: no node was provided.`);
    return;
  }
  const fqcn = nodeFqcn(node);
  const sameFqcnNodes = fqcn && graph
    ? graph.nodes
        .filter((candidate) => nodeFqcn(candidate) === fqcn)
        .map((candidate) => ({ id: candidate.id, type: candidate.type, label: candidate.label, file: candidate.data.file, line: candidate.data.line }))
    : [];

  console.groupCollapsed(`[LaraLens] Cannot open source for ${context}: ${node.id}`);
  console.info("Selected node", {
    id: node.id,
    type: node.type,
    label: node.label,
    fqcn,
    file: node.data.file,
    line: node.data.line,
    data: node.data,
  });
  console.info("Reason", "No usable data.file was found on this node or on a matching node with the same FQCN.");
  if (sameFqcnNodes.length > 0) console.info("Nodes with same FQCN", sameFqcnNodes);
  console.info("Tip", "Rescan the project. If this still happens, the scanner likely discovered a reference but did not resolve that class file.");
  console.groupEnd();
}

function directNodeLocation(node?: GraphNode): NodeLocation | null {
  const file = node?.data.file;
  if (typeof file !== "string" || file.length === 0) return null;

  const line = node?.data.line;
  return { file, line: typeof line === "number" ? line : undefined };
}

function withOwnLine(node: GraphNode, location: NodeLocation): NodeLocation {
  const line = node.data.line;
  return { file: location.file, line: typeof line === "number" ? line : location.line };
}

function nodeFqcn(node?: GraphNode): string | null {
  const direct = node?.data.fqcn;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const id = node?.id ?? "";
  const [, ...parts] = id.split("::");
  const value = parts[0];
  return value && value.includes("\\") ? value : null;
}
