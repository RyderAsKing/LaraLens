import type { Graph, GraphEdge, NodeType } from "./types";

export function displayNodeType(node: GraphNodeLike): NodeType {
  if (node.type !== "method") return node.type;
  const originalType = node.data.originalNodeType;
  return isNodeType(originalType) ? originalType : node.type;
}

export function displayHttpMethod(method: unknown): string {
  const raw = String(method ?? "").toUpperCase().trim();
  if (!raw) return "";
  const parts = raw.split(/[|,\s]+/).filter(Boolean);
  return parts[0] ?? raw;
}

/** Optical-accent color mapping — warm, muted, harmonious. */
export const ACCENT_COLORS: Record<NodeType, string> = {
  route: "#5A9B8E",
  middleware: "#C49A5E",
  controller: "#5B8DB8",
  livewire_component: "#B88B9A",
  action: "#6B9FB8",
  service: "#9B8BB8",
  validation_request: "#5E9B8A",
  model: "#B85C5C",
  event: "#C4A85E",
  job: "#7A8B9B",
  command: "#5E9B8E",
  channel: "#8B7CB3",
  schedule: "#C4945E",
  view: "#B87A9B",
  mail: "#B88B9B",
  notification: "#B85C7A",
  enum: "#5EA8C4",
  interface: "#6B9FC4",
  trait: "#8B8BB8",
  abstract_class: "#7A7E85",
  service_provider: "#C4A25E",
  facade: "#5EB8C4",
  filament_panel: "#7A6BB8",
  filament_resource: "#8B7CB8",
  filament_page: "#9B8BC4",
  filament_page_method: "#A88BC4",
  filament_widget: "#5EB8B8",
  filament_relation_manager: "#5EA8B8",
  file: "#6F8798",
  method: "#7AA8C4",
  lifecycle: "#7A7EB8",
};

export const TYPE_LABELS: Record<NodeType, string> = {
  route: "Route",
  middleware: "Middleware",
  controller: "Controller",
  livewire_component: "Livewire",
  action: "Action",
  service: "Service",
  validation_request: "Form Request",
  model: "Model",
  event: "Event",
  job: "Job",
  command: "Command",
  channel: "Channel",
  schedule: "Schedule",
  view: "View",
  mail: "Mail",
  notification: "Notification",
  enum: "Enum",
  interface: "Interface",
  trait: "Trait",
  abstract_class: "Abstract Class",
  service_provider: "Provider",
  facade: "Facade",
  filament_panel: "Filament Panel",
  filament_resource: "Filament Resource",
  filament_page: "Filament Page",
  filament_page_method: "Filament Method",
  filament_widget: "Filament Widget",
  filament_relation_manager: "Relation Manager",
  file: "File",
  method: "Method",
  lifecycle: "Lifecycle",
};

/** Human-readable label for a node's primary data field, used in the inspector. */
export function nodeSubtitle(node: GraphNodeLike): string {
  const d = node.data;
  switch (displayNodeType(node)) {
    case "route":
      return `${displayHttpMethod(d.method)} ${d.uri ?? ""}`.trim();
    case "command":
      return (d.signature as string) ?? (d.class as string) ?? "";
    case "channel":
      return (d.name as string) ?? "";
    case "schedule":
      return `${d.target ?? ""} · ${d.frequency ?? ""}`.trim();
    case "model":
    case "controller":
    case "middleware":
    case "event":
    case "job":
    case "mail":
    case "notification":
    case "enum":
    case "interface":
    case "trait":
    case "abstract_class":
    case "service_provider":
    case "facade":
      return (d.fqcn as string) ?? "";
    case "action":
    case "service":
    case "validation_request":
      return `${d.fqcn ?? ""}::${d.method ?? ""}`.replace(/^::$/, "");
    case "view":
      return (d.fqcn as string) ?? node.label;
    case "lifecycle":
      return (d.file as string) ?? (d.phase as string) ?? "";
    case "file":
      return (d.path as string) ?? (d.file as string) ?? "";
    case "method":
      return (d.signature as string) ?? (d.method as string) ?? (d.originalNodeType as string) ?? "";
    default:
      return "";
  }
}

function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && value in TYPE_LABELS;
}

interface GraphNodeLike {
  type: NodeType;
  label: string;
  data: Record<string, unknown>;
}

/** Tailwind text-color classes for HTTP method badges — optical palette. */
export const METHOD_COLORS: Record<string, string> = {
  GET: "text-[#7AB8AA]",
  POST: "text-[#7AA8C4]",
  PUT: "text-[#C4A97A]",
  PATCH: "text-[#9B8BB8]",
  DELETE: "text-[#C47A7A]",
  OPTIONS: "text-[var(--etch)]",
  HEAD: "text-[var(--etch)]",
  ANY: "text-[var(--etch)]",
};

/** Resolve a Tailwind text-color class for an HTTP method (case-insensitive). */
export function methodColor(method: string): string {
  return METHOD_COLORS[String(method).toUpperCase()] ?? "text-[var(--etch)]";
}

/**
 * Calm, aligned badge classes for HTTP methods. Harmonized with the
 * optical dark theme — muted, warm, coating-like.
 */
export function methodBadgeClass(method: string): string {
  switch (String(method).toUpperCase()) {
    case "GET":
      return "border-[#5A9B8E]/25 bg-[#5A9B8E]/10 text-[#7AB8AA]";
    case "POST":
      return "border-[#5B8DB8]/25 bg-[#5B8DB8]/10 text-[#7AA8C4]";
    case "PUT":
      return "border-[#C49A5E]/25 bg-[#C49A5E]/10 text-[#C4A97A]";
    case "PATCH":
      return "border-[#8B7CB3]/25 bg-[#8B7CB3]/10 text-[#9B8BB8]";
    case "DELETE":
      return "border-[#B85C5C]/25 bg-[#B85C5C]/10 text-[#C47A7A]";
    default:
      return "border-[var(--chassis)] bg-[var(--void)] text-[var(--etch)]";
  }
}

/** Convert a hex accent to an rgba with alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Collect the ids of all edges on the given nodes' lineage: every edge on an
 * incoming path leading into a root, and every edge on an outgoing path below
 * it. Sibling branches that merely share an ancestor are intentionally not lit
 * up. Used to highlight a selected node's full ancestry and descendants on the
 * graph canvas.
 */
export function lineageEdgeIds(graph: Graph, roots: Set<string>): Set<string> {
  const active = new Set<string>();
  if (roots.size === 0) return active;

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const outbound = outgoing.get(edge.source) ?? [];
    outbound.push(edge);
    outgoing.set(edge.source, outbound);

    const inbound = incoming.get(edge.target) ?? [];
    inbound.push(edge);
    incoming.set(edge.target, inbound);
  }

  const visit = (
    edgeMap: Map<string, GraphEdge[]>,
    nextNode: (edge: GraphEdge) => string
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

  visit(incoming, (edge) => edge.source);
  visit(outgoing, (edge) => edge.target);

  return active;
}
