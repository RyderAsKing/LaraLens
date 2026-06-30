/**
 * ProjectAnalyzer â€” orchestrates all analyzers and assembles the final graph.
 * This is the entry point invoked by the IPC handler in main.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { existsSync } from "node:fs";
import { readComposer } from "./psr4";
import { analyzeRoutes } from "./routes";
import { analyzeMiddleware } from "./middleware";
import { analyzeControllers } from "./controllers";
import { analyzeModels } from "./models";
import { traceCallChain } from "./callchain";
import { analyzeConsole } from "./console";
import { analyzeEnv } from "./env";
import { GraphBuilder } from "./graph-builder";
import {
  parsePhp,
  extractUseMap,
  extractClasses,
  walkAst,
  callName,
  stringValue,
  isCall,
  callKind,
  callMethod,
  callReceiver,
  callArgs,
} from "./php";
import type {
  ScanResult,
  ScanSummary,
  Graph,
  ChannelDefinition,
  ServiceProviderDefinition,
  RouteDefinition,
} from "./types";

export async function scanProject(projectRoot: string): Promise<ScanResult> {
  const startedAt = Date.now();
  const root = path.resolve(projectRoot);
  if (!existsSync(root)) {
    return fail(`Project directory does not exist: ${root}`, startedAt);
  }

  const composer = await readComposer(root);
  const psr4 = composer?.psr4 ?? {};
  const devPsr4 = composer?.devPsr4 ?? {};
  const projectName = composer?.name ?? path.basename(root);

  // Run analyzers in dependency order.
  const routes = await analyzeRoutes(root);
  const middlewareRegistry = await analyzeMiddleware(root);
  const controllers = await analyzeControllers(routes, psr4, devPsr4);

  // First-pass model discovery (needed to classify call-chain model hops).
  const initialModels = await analyzeModels(root, psr4, devPsr4);
  const modelFqcns = new Set(initialModels.keys());

  const callChain = traceCallChain(controllers, psr4, devPsr4, modelFqcns);

  // Re-run model analysis with any extra model FQCNs discovered in the call chain.
  const extraModelFqcns = callChain
    .filter((e) => e.type === "model")
    .map((e) => e.calleeFqcn)
    .filter((f) => !initialModels.has(f));
  const models =
    extraModelFqcns.length > 0
      ? await analyzeModels(root, psr4, devPsr4, extraModelFqcns)
      : initialModels;

  const { commands, schedules } = await analyzeConsole(root, psr4);
  const channels = await analyzeChannels(root);
  const providers = await discoverProviders(root);
  const env = await analyzeEnv(root);

  const graph: Graph = new GraphBuilder().build({
    projectName,
    routes,
    middlewareRegistry,
    controllers,
    callChain,
    models,
    commands,
    schedules,
    channels,
    providers,
    env,
  });

  const summary: ScanSummary = {
    totalRoutes: routes.length,
    totalControllers: controllers.size,
    totalModels: models.size,
    totalCommands: commands.length,
    totalMiddleware:
      middlewareRegistry.global.length +
      Object.values(middlewareRegistry.groups).reduce((n, g) => n + g.length, 0) +
      Object.keys(middlewareRegistry.aliases).length,
    totalProviders: providers.length,
    durationMs: Date.now() - startedAt,
  };

  return { ok: true, graph, summary };
}

async function analyzeChannels(projectRoot: string): Promise<ChannelDefinition[]> {
  const files = await fg(["routes/**/*.php", "app/Broadcasting/**/*.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });
  const channels: ChannelDefinition[] = [];
  for (const file of files) {
    if (!/channel/i.test(path.basename(file))) continue;
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const useMap = extractUseMap(ast);
    const namespace = getNs(ast);
    walkAst(ast.root, (node) => {
      if (!isCall(node)) return;
      if (callKind(node) !== "static") return;
      const receiver = callReceiver(node);
      if (receiver !== "Broadcast" && receiver !== "Channel") return;
      if (callMethod(node) !== "channel") return;
      const args = callArgs(node);
      const name = stringValue(args[0]);
      if (!name) return;
      const channelClass = args[1] && typeof args[1] === "object" && (args[1] as { kind?: string }).kind === "string"
        ? stringValue(args[1]) ?? undefined
        : undefined;
      channels.push({
        name,
        class: channelClass ? (channelClass.includes("\\") ? channelClass : `${namespace}\\${channelClass}`) : undefined,
        file,
      });
      void useMap;
    });
  }
  return channels;
}

async function discoverProviders(projectRoot: string): Promise<ServiceProviderDefinition[]> {
  const files = await fg(["app/Providers/**/*.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });
  const providers: ServiceProviderDefinition[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const classes = extractClasses(ast, file);
    for (const cls of classes) {
      // A service provider extends ServiceProvider (heuristic).
      if (cls.extends && /ServiceProvider$/.test(cls.extends)) {
        providers.push({ fqcn: cls.fqcn, file });
      }
    }
  }
  return providers;
}

function getNs(ast: { root: unknown }): string {
  const children = (ast.root as { children?: unknown[] })?.children;
  if (!Array.isArray(children)) return "";
  for (const child of children) {
    if ((child as { kind?: string }).kind === "namespace") {
      const nameNode = (child as { name?: unknown }).name;
      if (typeof nameNode === "string") return nameNode;
      return callName(nameNode);
    }
  }
  return "";
}

function fail(message: string, startedAt: number): ScanResult {
  return {
    ok: false,
    error: message,
    graph: {
      meta: { project: "", analyzedAt: new Date().toISOString(), nodeCount: 0, edgeCount: 0 },
      nodes: [],
      edges: [],
    },
    summary: {
      totalRoutes: 0,
      totalControllers: 0,
      totalModels: 0,
      totalCommands: 0,
      totalMiddleware: 0,
      totalProviders: 0,
      durationMs: Date.now() - startedAt,
    },
  };
}

// Re-export the route type for the IPC layer.
export type { RouteDefinition };
