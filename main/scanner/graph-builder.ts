/**
 * GraphBuilder â€” assembles the final { meta, nodes, edges } graph from all
 * analyzer outputs, using the exact id conventions and accent colors from the
 * reference (laravel-brain) schema.
 */
import { ACCENT_COLORS, type Graph, type GraphNode, type GraphEdge } from "./types";
import type {
  RouteDefinition,
  ControllerDefinition,
  ModelDefinition,
  CallChainEdge,
  ConsoleCommandDefinition,
  ScheduleEntry,
  MiddlewareRegistry,
  ChannelDefinition,
  ServiceProviderDefinition,
} from "./types";

export interface GraphBuilderInput {
  projectName: string;
  routes: RouteDefinition[];
  middlewareRegistry: MiddlewareRegistry;
  controllers: Map<string, ControllerDefinition>;
  callChain: CallChainEdge[];
  models: Map<string, ModelDefinition>;
  commands: ConsoleCommandDefinition[];
  schedules: ScheduleEntry[];
  channels: ChannelDefinition[];
  providers: ServiceProviderDefinition[];
  env: Record<string, string>;
}

const RELATIONSHIP_EDGE_TYPES = new Set([
  "model",
  "service",
  "repository",
  "event",
  "job",
  "view",
  "mail",
  "notification",
  "enum",
  "interface",
  "trait",
  "abstract_class",
  "facade",
  "validation_request",
  "action",
]);

export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private edgeCounter = 0;

  build(input: GraphBuilderInput): Graph {
    this.addRoutes(input.routes, input.middlewareRegistry);
    this.addControllers(input.controllers);
    this.addCallChain(input.callChain);
    this.addModels(input.models);
    this.addCommands(input.commands);
    this.addSchedules(input.schedules);
    this.addChannels(input.channels);
    this.addProviders(input.providers);

    const nodes = [...this.nodes.values()];
    const edges = [...this.edges.values()];
    return {
      meta: {
        project: input.projectName,
        analyzedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
      nodes,
      edges,
    };
  }

  // -------------------------------------------------------------------------
  // Node registration helpers
  // -------------------------------------------------------------------------

  private addNode(
    id: string,
    type: GraphNode["type"],
    label: string,
    data: Record<string, unknown>
  ): GraphNode {
    const existing = this.nodes.get(id);
    if (existing) {
      // Merge data without letting early placeholder null/undefined values hide
      // richer analyzer data registered later (for example route-created
      // controller/action placeholders later gaining file + line information).
      existing.data = this.mergeNodeData(existing.data, data);
      return existing;
    }
    const node: GraphNode = { id, type, label, data: { ...data, accent: ACCENT_COLORS[type] ?? "#94a3b8" } };
    this.nodes.set(id, node);
    return node;
  }

  private addEdge(
    source: string,
    target: string,
    label: string,
    type: string
  ): GraphEdge | null {
    if (!source || !target || source === target) return null;
    if (!this.nodes.has(source) || !this.nodes.has(target)) return null;
    const id = `e${this.edgeCounter++}_${source}_${target}`;
    // Dedupe by source+target+type
    const dedupeKey = `${source}->${target}:${type}`;
    if ([...this.edges.values()].some((e) => `${e.source}->${e.target}:${e.type}` === dedupeKey)) {
      return null;
    }
    const edge: GraphEdge = { id, source, target, label, type };
    this.edges.set(id, edge);
    return edge;
  }

  // -------------------------------------------------------------------------
  // Routes + controllers + actions
  // -------------------------------------------------------------------------

  private addRoutes(routes: RouteDefinition[], registry: MiddlewareRegistry): void {
    for (const r of routes) {
      const routeId = `route::${r.method}::${r.uri}`;
      this.addNode(routeId, "route", `${r.method} ${r.uri}`, {
        method: r.method,
        uri: r.uri,
        name: r.name,
        file: r.file,
        line: r.line,
        security: { exposure: "unknown", riskLevel: "none", issues: [] },
      });

      let dispatchTargetId: string | null = null;

      // controller/action dispatch target
      if (r.controller && r.action) {
        const controllerId = `controller::${r.controller}`;
        this.addNode(controllerId, "controller", this.shortName(r.controller), {
          fqcn: r.controller,
          file: null,
        });
        dispatchTargetId = controllerId;

        const actionId = `action::${r.controller}::${r.action}`;
        this.addNode(actionId, "action", `${r.action}()`, {
          fqcn: r.controller,
          declaringFqcn: r.controller,
          method: r.action,
          file: null,
          visibility: "public",
          flowSteps: [],
        });
        this.addEdge(controllerId, actionId, "has method", "controller-to-action");
      }

      // request pipeline: route -> middleware(s) -> controller/action.
      // This keeps middleware between the route and what handles the request
      // instead of rendering it as a side branch.
      let previousId = routeId;
      let middlewareCount = 0;
      for (const mw of r.middlewares) {
        const fqcn = registry.aliases[mw] ?? mw;
        const mwId = `middleware::${r.method}::${r.uri}::${middlewareCount}::${fqcn}`;
        this.addNode(mwId, "middleware", this.shortName(fqcn), {
          fqcn,
          alias: mw === fqcn ? undefined : mw,
          route: `${r.method} ${r.uri}`,
          file: null,
        });
        this.addEdge(previousId, mwId, middlewareCount === 0 ? "passes through" : "then", "request-middleware");
        previousId = mwId;
        middlewareCount++;
      }
      if (dispatchTargetId) {
        this.addEdge(previousId, dispatchTargetId, middlewareCount > 0 ? "continues to" : "routes to", "route-to-controller");
      }
    }
  }

  private addControllers(controllers: Map<string, ControllerDefinition>): void {
    for (const c of controllers.values()) {
      const controllerId = `controller::${c.fqcn}`;
      this.addNode(controllerId, "controller", this.shortName(c.fqcn), {
        fqcn: c.fqcn,
        file: c.file,
      });
      for (const m of c.methods) {
        if (m.visibility !== "public") continue;
        const actionId = `action::${c.fqcn}::${m.name}`;
        this.addNode(actionId, "action", `${m.name}()`, {
          fqcn: c.fqcn,
          declaringFqcn: m.declaringFqcn,
          method: m.name,
          file: c.file,
          line: m.loc?.start.line,
          visibility: m.visibility,
          flowSteps: [],
          metrics: {
            lineCount: m.loc ? m.loc.end.line - m.loc.start.line + 1 : 0,
            cyclomaticComplexity: 1,
            statementCount: 0,
            paramCount: m.parameters.length,
          },
        });
        this.addEdge(controllerId, actionId, "has method", "controller-to-action");
      }
      if (c.parent) {
        const parentId = `controller::${c.parent}`;
        const child = this.nodes.get(controllerId);
        if (child) {
          child.data.extends = c.parent;
          child.data.extendsTargetId = parentId;
        }
        this.addNode(parentId, "controller", this.shortName(c.parent), {
          fqcn: c.parent,
          file: null,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Call chain (actions -> services/models/jobs/events/views/...)
  // -------------------------------------------------------------------------

  private addCallChain(chain: CallChainEdge[]): void {
    for (const edge of chain) {
      const callerId = `action::${edge.callerFqcn}::${edge.callerMethod}`;
      if (!this.nodes.has(callerId)) continue;

      let targetType: GraphNode["type"];
      let targetId: string;
      let label = "calls";

      switch (edge.type) {
        case "model":
          targetType = "model";
          targetId = `model::${edge.calleeFqcn}`;
          label = "queries";
          break;
        case "service":
        case "repository":
          targetType = "service";
          targetId = `service::${edge.calleeFqcn}::${edge.calleeMethod}`;
          label = "calls";
          break;
        case "job":
          targetType = "job";
          targetId = `job::${edge.calleeFqcn}`;
          label = "dispatches";
          break;
        case "event":
          targetType = "event";
          targetId = `event::${edge.calleeFqcn}`;
          label = "dispatches";
          break;
        case "view":
          targetType = "view";
          targetId = `view::${edge.calleeFqcn}`;
          label = "renders";
          break;
        case "mail":
          targetType = "mail";
          targetId = `mail::${edge.calleeFqcn}`;
          label = "sends";
          break;
        case "notification":
          targetType = "notification";
          targetId = `notification::${edge.calleeFqcn}`;
          label = "sends";
          break;
        case "validation_request":
          targetType = "validation_request";
          targetId = `validation_request::${edge.calleeFqcn}`;
          label = "validates with";
          break;
        case "enum":
          targetType = "enum";
          targetId = `enum::${edge.calleeFqcn}`;
          label = "uses";
          break;
        case "interface":
          targetType = "interface";
          targetId = `interface::${edge.calleeFqcn}`;
          label = "uses";
          break;
        case "trait":
          targetType = "trait";
          targetId = `trait::${edge.calleeFqcn}`;
          label = "uses";
          break;
        case "abstract_class":
          targetType = "abstract_class";
          targetId = `abstract_class::${edge.calleeFqcn}`;
          label = "uses";
          break;
        case "facade":
          targetType = "facade";
          targetId = `facade::${edge.calleeFqcn}::${edge.calleeMethod}`;
          label = "calls via facade";
          break;
        case "action":
          targetType = "action";
          targetId = `action::${edge.calleeFqcn}::${edge.calleeMethod}`;
          label = "calls";
          break;
        default:
          continue;
      }

      if (!RELATIONSHIP_EDGE_TYPES.has(edge.type)) continue;

      const data: Record<string, unknown> = { fqcn: edge.calleeFqcn, ...(edge.data ?? {}) };
      if (edge.calleeMethod && targetType !== "model") {
        data.method = edge.calleeMethod;
      }
      if (targetType === "service") {
        data.subtype = edge.type === "repository" ? "repository" : "service";
      }
      this.addNode(targetId, targetType, this.labelFor(targetType, edge.calleeFqcn, edge.calleeMethod), data);
      this.addEdge(callerId, targetId, label, `action-to-${edge.type}`);
    }
  }

  // -------------------------------------------------------------------------
  // Models + relationships
  // -------------------------------------------------------------------------

  private addModels(models: Map<string, ModelDefinition>): void {
    for (const m of models.values()) {
      const modelId = `model::${m.fqcn}`;
      this.addNode(modelId, "model", this.shortName(m.fqcn), {
        fqcn: m.fqcn,
        file: m.file,
        relationships: m.relationships,
        fillable: m.fillable,
        guarded: m.guarded,
        casts: m.casts,
        table: m.table,
        primaryKey: m.primaryKey,
        usesSoftDeletes: m.usesSoftDeletes,
        timestamps: m.timestamps,
      });
      for (const rel of m.relationships) {
        if (!rel.related) continue;
        const relId = `model::${rel.related}`;
        this.addNode(relId, "model", this.shortName(rel.related), {
          fqcn: rel.related,
          file: null,
        });
        this.addEdge(modelId, relId, `${rel.type}()`, "model-relationship");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Console commands + schedules
  // -------------------------------------------------------------------------

  private addCommands(commands: ConsoleCommandDefinition[]): void {
    for (const c of commands) {
      const id = c.class
        ? `command::${c.class}`
        : `command::${c.signature}`;
      this.addNode(id, "command", c.class ? this.shortName(c.class) : c.signature, {
        signature: c.signature,
        description: c.description,
        class: c.class,
        file: c.file,
        source: c.source,
        flowSteps: [],
      });
    }
  }

  private addSchedules(schedules: ScheduleEntry[]): void {
    for (const s of schedules) {
      const id = `schedule::${s.target}`;
      this.addNode(id, "schedule", s.target, {
        type: s.type,
        target: s.target,
        frequency: s.frequency,
        file: s.file,
      });
      if (s.type === "command") {
        // try to link to the command node by signature or class
        const bySignature = `command::${s.target}`;
        const byClass = `command::${s.target}`;
        if (this.nodes.has(bySignature)) {
          this.addEdge(id, bySignature, "runs", "schedule-to-command");
        } else if (this.nodes.has(byClass)) {
          this.addEdge(id, byClass, "runs", "schedule-to-command");
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Channels + service providers
  // -------------------------------------------------------------------------

  private addChannels(channels: ChannelDefinition[]): void {
    for (const c of channels) {
      const id = `channel::${c.name}`;
      this.addNode(id, "channel", c.name, {
        name: c.name,
        class: c.class,
        file: c.file,
        flowSteps: [],
      });
    }
  }

  private addProviders(providers: ServiceProviderDefinition[]): void {
    for (const p of providers) {
      const id = `service_provider::${p.fqcn}`;
      this.addNode(id, "service_provider", this.shortName(p.fqcn), {
        fqcn: p.fqcn,
        file: p.file,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Utils
  // -------------------------------------------------------------------------

  private shortName(fqcn: string): string {
    if (!fqcn) return "";
    return fqcn.split("\\").pop() ?? fqcn;
  }

  private mergeNodeData(
    existing: Record<string, unknown>,
    next: Record<string, unknown>
  ): Record<string, unknown> {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === undefined) continue;
      merged[key] = value;
    }
    return merged;
  }

  private labelFor(type: string, fqcn: string, method?: string): string {
    const short = this.shortName(fqcn);
    if (type === "view" && fqcn.startsWith("blade::")) {
      return fqcn.replace(/^blade::/, "");
    }
    if (method && type !== "model" && type !== "job" && type !== "event" && type !== "mail" && type !== "notification") {
      return `${short}.${method}()`;
    }
    return short;
  }
}
