/**
 * Graph types used by the renderer. Mirrors the main-process scanner schema.
 */

export type NodeType =
  | "route"
  | "middleware"
  | "controller"
  | "livewire_component"
  | "action"
  | "service"
  | "validation_request"
  | "model"
  | "event"
  | "job"
  | "command"
  | "channel"
  | "schedule"
  | "view"
  | "mail"
  | "notification"
  | "enum"
  | "interface"
  | "trait"
  | "abstract_class"
  | "service_provider"
  | "facade"
  | "filament_panel"
  | "filament_resource"
  | "filament_page"
  | "filament_page_method"
  | "filament_widget"
  | "filament_relation_manager"
  | "file"
  | "method"
  | "lifecycle";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: Record<string, unknown> & { accent?: string };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: string;
}

export interface MigrationColumn {
  name: string;
  type: string;
  primary?: boolean;
  nullable?: boolean;
  autoIncrement?: boolean;
  default?: string;
}

export interface Graph {
  meta: {
    project: string;
    analyzedAt: string;
    nodeCount: number;
    edgeCount: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ScanSummary {
  totalRoutes: number;
  totalControllers: number;
  totalModels: number;
  totalCommands: number;
  totalMiddleware: number;
  totalProviders: number;
  durationMs: number;
}

export interface ScanResult {
  ok: boolean;
  error?: string;
  graph: Graph;
  summary: ScanSummary;
}
