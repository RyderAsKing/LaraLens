import type { NodeType } from "./types";

/** Exact accent color mapping from the reference laravel-brain graphConstants. */
export const ACCENT_COLORS: Record<NodeType, string> = {
  route: "#4CAF50",
  middleware: "#FF9800",
  controller: "#2196F3",
  livewire_component: "#FB7185",
  action: "#03A9F4",
  service: "#9C27B0",
  validation_request: "#0d9488",
  model: "#F44336",
  event: "#FFD600",
  job: "#607D8B",
  command: "#14b8a6",
  channel: "#8b5cf6",
  schedule: "#f97316",
  view: "#ec4899",
  mail: "#f472b6",
  notification: "#db2777",
  enum: "#0ea5e9",
  interface: "#38bdf8",
  trait: "#a78bfa",
  abstract_class: "#94a3b8",
  service_provider: "#ca8a04",
  facade: "#00BCD4",
  filament_panel: "#7C3AED",
  filament_resource: "#A855F7",
  filament_page: "#C084FC",
  filament_page_method: "#E879F9",
  filament_widget: "#06B6D4",
  filament_relation_manager: "#0891B2",
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
};

/** Human-readable label for a node's primary data field, used in the inspector. */
export function nodeSubtitle(node: GraphNodeLike): string {
  const d = node.data;
  switch (node.type) {
    case "route":
      return `${d.method ?? ""} ${d.uri ?? ""}`.trim();
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
    default:
      return "";
  }
}

interface GraphNodeLike {
  type: NodeType;
  label: string;
  data: Record<string, unknown>;
}

/** Convert a hex accent to an rgba with alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
