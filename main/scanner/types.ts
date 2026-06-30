/**
 * Graph + analysis type definitions for the LaraLens scanner.
 * Mirrors the reference (laravel-brain) JSON schema for forward compatibility.
 */

// ---------------------------------------------------------------------------
// Core graph types (the wire format sent to the renderer over IPC)
// ---------------------------------------------------------------------------

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
  | "filament_relation_manager";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: string;
}

export interface GraphMeta {
  project: string;
  analyzedAt: string;
  nodeCount: number;
  edgeCount: number;
}

export interface Graph {
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FlowStep {
  type: "call" | "assign" | "return" | "throw" | "if" | "loop" | "dispatch" | "event";
  label: string;
  then?: FlowStep[];
  else?: FlowStep[];
  body?: FlowStep[];
  n1?: boolean;
}

export interface MethodMetrics {
  lineCount: number;
  cyclomaticComplexity: number;
  statementCount: number;
  paramCount: number;
}

// ---------------------------------------------------------------------------
// Accent color mapping (replicated exactly from reference graphConstants.ts)
// ---------------------------------------------------------------------------

export const ACCENT_COLORS: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Intermediate analysis types
// ---------------------------------------------------------------------------

export interface Psr4Map {
  /** namespace prefix -> array of source directories (absolute) */
  [prefix: string]: string[];
}

export interface ComposerInfo {
  name: string;
  psr4: Psr4Map;
  devPsr4: Psr4Map;
  require: Record<string, string>;
  requireDev: Record<string, string>;
}

export interface RouteDefinition {
  method: string; // GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD
  uri: string;
  controller?: string; // FQCN
  action?: string; // method name
  middlewares: string[]; // alias or FQCN
  name?: string;
  file: string; // absolute
  line: number;
  isClosure: boolean;
  closureNode?: unknown;
}

export interface MethodDefinition {
  name: string;
  visibility: string; // public, protected, private
  parameters: { name: string; type?: string }[];
  returnType?: string;
  body?: unknown; // AST body
  declaringFqcn: string;
  loc?: { start: { line: number }; end: { line: number } };
}

export interface ControllerDefinition {
  fqcn: string;
  file: string;
  constructorDeps: { name: string; type: string }[];
  methods: MethodDefinition[];
  parent?: string;
  ancestorFqcns: string[];
}

export interface ModelRelationship {
  type: string; // hasMany, belongsTo, hasOne, belongsToMany, ...
  related: string; // FQCN
  name: string; // method name
}

export interface ModelDefinition {
  fqcn: string;
  file: string;
  relationships: ModelRelationship[];
  fillable: string[];
  guarded: string[];
  casts: Record<string, string>;
  table?: string;
  primaryKey?: string;
  usesSoftDeletes: boolean;
  timestamps: boolean;
}

export type CallChainType =
  | "service"
  | "repository"
  | "model"
  | "job"
  | "event"
  | "action"
  | "view"
  | "mail"
  | "notification"
  | "enum"
  | "interface"
  | "trait"
  | "abstract_class"
  | "facade"
  | "validation_request";

export interface CallChainEdge {
  callerFqcn: string;
  callerMethod: string;
  calleeFqcn: string;
  calleeMethod: string;
  type: CallChainType;
  visibility: string;
}

export interface ConsoleCommandDefinition {
  signature: string;
  description?: string;
  class?: string; // FQCN
  file: string;
  source: "class" | "closure";
}

export interface ScheduleEntry {
  type: "command" | "closure";
  target: string;
  frequency: string;
  file: string;
}

export interface MiddlewareRegistry {
  global: string[]; // FQCNs
  groups: Record<string, string[]>; // group name -> FQCNs
  aliases: Record<string, string>; // alias -> FQCN
}

export interface ChannelDefinition {
  name: string;
  class?: string;
  file: string;
}

export interface ServiceProviderDefinition {
  fqcn: string;
  file: string;
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
