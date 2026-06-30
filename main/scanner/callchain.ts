/**
 * CallChainTracer — walks controller action method bodies (AST) to discover
 * outbound calls to services, models, jobs, events, views, mail, notifications.
 * Pragmatic depth cap (2 hops) with a visited guard.
 *
 * Uses glayzzle/php-parser v3 AST where all calls are `kind:'call'`.
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import {
  parsePhp,
  extractUseMap,
  extractClasses,
  walkAst,
  callName,
  resolveClassRef,
  stringValue,
  isCall,
  callKind,
  callReceiver,
  callMethod,
  callArgs,
  classConstName,
  newClassName,
  isAssign,
  assignTarget,
  assignValue,
} from "./php";
import { resolveFqcn } from "./psr4";
import type { CallChainEdge, CallChainType, ControllerDefinition, Psr4Map } from "./types";

const MAX_DEPTH = 2;

const DISPATCH_FUNCS = new Set(["dispatch", "dispatch_sync", "dispatchSync", "dispatchNow"]);
const EVENT_FUNCS = new Set(["event", "Event"]);
const VIEW_FUNCS = new Set(["view"]);
const BUS_CLASSES = new Set(["Bus", "Illuminate\\Bus\\Bus", "Illuminate\\Contracts\\Bus\\Dispatcher"]);
const EVENT_CLASSES = new Set(["Event", "Illuminate\\Events\\Dispatcher", "Illuminate\\Support\\Facades\\Event"]);
const VIEW_CLASSES = new Set(["View", "Illuminate\\Support\\Facades\\View", "Illuminate\\Contracts\\View\\Factory", "Inertia", "Illuminate\\Support\\Facades\\Inertia"]);
const NOTIFICATION_CLASSES = new Set(["Notification", "Illuminate\\Support\\Facades\\Notification", "Illuminate\\Notifications\\NotificationSender", "Notify"]);
const MAIL_CLASSES = new Set(["Mail", "Illuminate\\Support\\Facades\\Mail", "Illuminate\\Mail\\Mailer"]);
const DB_CLASSES = new Set(["DB", "Illuminate\\Support\\Facades\\DB"]);

interface TraceContext {
  controllers: Map<string, ControllerDefinition>;
  psr4: Psr4Map;
  devPsr4: Psr4Map;
  models: Set<string>;
  visited: Set<string>;
  edges: CallChainEdge[];
  classFileCache: Map<string, { useMap: Map<string, string>; namespace: string } | null>;
  formRequestCache: Map<string, Record<string, unknown> | undefined>;
}

export function traceCallChain(
  controllers: Map<string, ControllerDefinition>,
  psr4: Psr4Map,
  devPsr4: Psr4Map,
  models: Set<string>
): CallChainEdge[] {
  const ctx: TraceContext = {
    controllers,
    psr4,
    devPsr4,
    models,
    visited: new Set(),
    edges: [],
    classFileCache: new Map(),
    formRequestCache: new Map(),
  };

  for (const controller of controllers.values()) {
    // Base dep types from constructor injection (available to all methods).
    const baseDepTypes = new Map<string, string>();
    for (const dep of controller.constructorDeps) baseDepTypes.set(dep.name, dep.type);
    // Resolve constructor dep types to FQCNs using the controller's use map.
    const controllerFile = resolveFqcn(controller.fqcn, psr4, devPsr4);
    let controllerUseMap = new Map<string, string>();
    let controllerNs = "";
    if (controllerFile && existsSync(controllerFile)) {
      const src = readFileSync(controllerFile, "utf8");
      const ast = parsePhp(src, controllerFile);
      if (ast) {
        controllerUseMap = extractUseMap(ast);
        controllerNs = getNs(ast);
      }
    }
    for (const [varName, type] of baseDepTypes) {
      baseDepTypes.set(varName, resolveClassRef(type, controllerUseMap, controllerNs));
    }

    for (const method of controller.methods) {
      if (method.visibility !== "public") continue;
      if (!method.body) continue;
      // Per-method dep types: constructor deps + method parameters.
      const depTypes = new Map(baseDepTypes);
      for (const param of method.parameters) {
        if (param.type && !isBuiltin(param.type)) {
          const resolved = resolveClassRef(param.type, controllerUseMap, controllerNs);
          depTypes.set(param.name, resolved);
          if (classifyClass(resolved, ctx) === "validation_request") {
            addEdge(ctx, controller.fqcn, method.name, resolved, "rules", "validation_request", analyzeFormRequest(resolved, ctx));
          }
        }
      }
      traceMethod(controller.fqcn, method.name, method.body, depTypes, ctx, 0);
    }
  }
  return ctx.edges;
}

function traceMethod(
  callerFqcn: string,
  callerMethod: string,
  body: unknown,
  depTypes: Map<string, string>,
  ctx: TraceContext,
  depth: number
): void {
  const visitedKey = `${callerFqcn}::${callerMethod}`;
  if (ctx.visited.has(visitedKey)) return;
  ctx.visited.add(visitedKey);

  // Build a local var type map that starts as a copy of depTypes.
  // As we walk the body, we track `$var = new Class()` assignments.
  const localTypes = new Map(depTypes);

  walkAst(body, (node) => {
    // Track `$var = new Class()` assignments to build local var types.
    if (isAssign(node)) {
      const target = assignTarget(node);
      if (target) {
        const rhs = assignValue(node);
        if (rhs && (rhs as { kind?: string }).kind === "new") {
          const cls = newClassName(rhs);
          if (cls) localTypes.set(target.slice(1), cls);
        }
        // Also track `$var = OtherClass::method()` — can't infer return type,
        // but track `$var = Class::query()` or similar model factory calls
        // by checking if the receiver resolves to a known model.
        if (rhs && isCall(rhs)) {
          const rk = callKind(rhs);
          if (rk === "static") {
            const recv = callReceiver(rhs);
            const meth = callMethod(rhs);
            // Common Eloquent patterns: Model::query(), Model::where(), etc.
            // The result is an Eloquent builder, not the model itself — skip.
            void recv;
            void meth;
          }
        }
      }
    }

    // In glayzzle, all calls are `kind:'call'`.
    if (isCall(node)) {
      const kind = callKind(node);
      const receiver = callReceiver(node);
      const methodName = callMethod(node);
      const args = callArgs(node);

      if (kind === "function") {
        handleFunctionCall(methodName, args, callerFqcn, callerMethod, ctx);
      } else if (kind === "static") {
        handleStaticCall(receiver, methodName, args, callerFqcn, callerMethod, ctx, depth);
      } else if (kind === "method") {
        handleInstanceCall(receiver, methodName, callerFqcn, callerMethod, ctx, localTypes);
      }
      return;
    }

    // new Class()
    if ((node as { kind?: string }).kind === "new") {
      const className = newClassName(node);
      handleNewExpr(className, callerFqcn, callerMethod, ctx);
      return;
    }
  });
}

function handleFunctionCall(
  fnName: string,
  args: unknown[],
  callerFqcn: string,
  callerMethod: string,
  ctx: TraceContext
): void {
  if (DISPATCH_FUNCS.has(fnName)) {
    const jobClass = resolveArgClass(args[0], ctx);
    if (jobClass) addEdge(ctx, callerFqcn, callerMethod, jobClass, "handle", "job");
  } else if (EVENT_FUNCS.has(fnName)) {
    const eventClass = resolveArgClass(args[0], ctx);
    if (eventClass) addEdge(ctx, callerFqcn, callerMethod, eventClass, "", "event");
  } else if (VIEW_FUNCS.has(fnName)) {
    const viewName = stringArg(args[0]);
    if (viewName) addEdge(ctx, callerFqcn, callerMethod, `blade::${viewName}`, "", "view");
  }
}

function handleStaticCall(
  receiver: string,
  methodName: string,
  args: unknown[],
  callerFqcn: string,
  callerMethod: string,
  ctx: TraceContext,
  depth: number
): void {
  // Bus::dispatch(new JobClass) / Event::dispatch(new EventClass)
  if (BUS_CLASSES.has(receiver) && (methodName === "dispatch" || methodName === "dispatchSync" || methodName === "dispatchNow")) {
    const jobClass = resolveArgClass(args[0], ctx);
    if (jobClass) addEdge(ctx, callerFqcn, callerMethod, jobClass, "handle", "job");
    return;
  }
  if (EVENT_CLASSES.has(receiver) && methodName === "dispatch") {
    const eventClass = resolveArgClass(args[0], ctx);
    if (eventClass) addEdge(ctx, callerFqcn, callerMethod, eventClass, "", "event");
    return;
  }
  if (VIEW_CLASSES.has(receiver) && (methodName === "make" || methodName === "create")) {
    const viewName = stringArg(args[0]);
    if (viewName) addEdge(ctx, callerFqcn, callerMethod, `blade::${viewName}`, "", "view");
    return;
  }
  if (NOTIFICATION_CLASSES.has(receiver) && methodName === "send") {
    const notifClass = resolveArgClass(args[1], ctx);
    if (notifClass) addEdge(ctx, callerFqcn, callerMethod, notifClass, "", "notification");
    return;
  }
  if (MAIL_CLASSES.has(receiver) && (methodName === "to" || methodName === "send" || methodName === "queue")) {
    const mailClass = resolveArgClass(args[0], ctx);
    if (mailClass) addEdge(ctx, callerFqcn, callerMethod, mailClass, "", "mail");
    return;
  }
  if (DB_CLASSES.has(receiver)) return; // skip raw DB facade

  // Generic static call on an app class.
  const resolved = resolveReceiver(receiver, ctx);
  if (!resolved) return;
  if (ctx.models.has(resolved)) {
    addEdge(ctx, callerFqcn, callerMethod, resolved, methodName, "model");
    return;
  }
  const type = classifyClass(resolved, ctx);
  addEdge(ctx, callerFqcn, callerMethod, resolved, methodName, type);
  if (depth < MAX_DEPTH) {
    void recurseInto(resolved, methodName, callerFqcn, callerMethod, ctx, depth);
  }
}

function handleInstanceCall(
  receiver: string,
  methodName: string,
  callerFqcn: string,
  callerMethod: string,
  ctx: TraceContext,
  depTypes: Map<string, string>
): void {
  // callReceiver returns "$this", "$dep", "$request", etc. for method calls on variables.
  const varName = receiver.startsWith("$") ? receiver.slice(1) : receiver;

  // $this->method() — internal controller call; skip to avoid self-loops.
  if (varName === "this") return;
  // $dep->method() where $dep is a constructor-injected service.
  if (varName && depTypes.has(varName)) {
    const depType = depTypes.get(varName)!;
    const type = classifyClass(depType, ctx);
    addEdge(ctx, callerFqcn, callerMethod, depType, methodName, type);
    return;
  }
  // $request->validate(...) — skip $request.
  if (varName === "request") return;
}

function handleNewExpr(
  className: string,
  callerFqcn: string,
  callerMethod: string,
  ctx: TraceContext
): void {
  if (!className) return;
  const resolved = resolveReceiver(className, ctx);
  if (!resolved) return;
  const type = classifyClass(resolved, ctx);
  addEdge(ctx, callerFqcn, callerMethod, resolved, "", type);
}

function resolveReceiver(rawName: string, ctx: TraceContext): string | null {
  if (!rawName) return null;
  const clean = rawName.replace(/^\\/, "");
  if (clean.startsWith("Illuminate\\")) return null;
  if (clean.startsWith("Symfony\\")) return null;
  if (ctx.models.has(clean)) return clean;
  const file = resolveFqcn(clean, ctx.psr4, ctx.devPsr4);
  if (file) return clean;
  return null;
}

function classifyClass(fqcn: string, ctx: TraceContext): CallChainType {
  if (ctx.models.has(fqcn)) return "model";
  const short = fqcn.split("\\").pop() ?? fqcn;
  if (/Mail(able)?$/.test(short)) return "mail";
  if (/Notification$/.test(short)) return "notification";
  if (/Job$/.test(short)) return "job";
  if (/Event$/.test(short)) return "event";
  if (/Request$/.test(short)) return "validation_request";
  return "service";
}

async function recurseInto(
  calleeFqcn: string,
  calleeMethod: string,
  callerFqcn: string,
  callerMethod: string,
  ctx: TraceContext,
  depth: number
): Promise<void> {
  void callerFqcn;
  void callerMethod;
  if (depth >= MAX_DEPTH) return;
  const file = resolveFqcn(calleeFqcn, ctx.psr4, ctx.devPsr4);
  if (!file || !existsSync(file)) return;
  const cacheKey = calleeFqcn;
  let cached = ctx.classFileCache.get(cacheKey);
  if (cached === undefined) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) {
      ctx.classFileCache.set(cacheKey, null);
      return;
    }
    const ast = parsePhp(source, file);
    if (!ast) {
      ctx.classFileCache.set(cacheKey, null);
      return;
    }
    cached = { useMap: extractUseMap(ast), namespace: getNs(ast) };
    ctx.classFileCache.set(cacheKey, cached);
  }
  if (!cached) return;

  const ast = parsePhp(await fs.readFile(file, "utf8").catch(() => ""), file);
  if (!ast) return;
  const classes = extractClasses(ast, file);
  const cls = classes.find((c) => c.fqcn === calleeFqcn);
  if (!cls) return;
  const method = cls.methods.find((m) => m.name === calleeMethod);
  if (!method || !method.body) return;

  const depTypes = new Map<string, string>();
  const ctor = cls.methods.find((m) => m.name === "__construct");
  if (ctor) {
    for (const p of ctor.parameters) {
      if (p.type && !isBuiltin(p.type)) {
        depTypes.set(p.name, resolveClassRef(p.type, cached.useMap, cached.namespace));
      }
    }
  }
  traceMethod(calleeFqcn, calleeMethod, method.body, depTypes, ctx, depth + 1);
}

function resolveArgClass(arg: unknown, ctx: TraceContext): string | null {
  if (!arg || typeof arg !== "object") return null;
  // `Foo::class` → staticlookup
  const classRef = classConstName(arg);
  if (classRef) return resolveReceiver(classRef, ctx);
  // `new Foo(...)`
  if ((arg as { kind?: string }).kind === "new") {
    return resolveReceiver(newClassName(arg), ctx);
  }
  return null;
}

function stringArg(arg: unknown): string | null {
  return stringValue(arg);
}

function addEdge(
  ctx: TraceContext,
  callerFqcn: string,
  callerMethod: string,
  calleeFqcn: string,
  calleeMethod: string,
  type: CallChainType,
  data?: Record<string, unknown>
): void {
  ctx.edges.push({ callerFqcn, callerMethod, calleeFqcn, calleeMethod, type, visibility: "public", data });
}

function analyzeFormRequest(fqcn: string, ctx: TraceContext): Record<string, unknown> | undefined {
  if (ctx.formRequestCache.has(fqcn)) return ctx.formRequestCache.get(fqcn);
  const file = resolveFqcn(fqcn, ctx.psr4, ctx.devPsr4);
  if (!file || !existsSync(file)) return undefined;
  try {
    const source = readFileSync(file, "utf8");
    const ast = parsePhp(source, file);
    if (!ast) return cacheFormRequest(ctx, fqcn, { file });
    const classes = extractClasses(ast, file);
    const cls = classes.find((c) => c.fqcn === fqcn || c.name === fqcn.split("\\").pop());
    if (!cls) return cacheFormRequest(ctx, fqcn, { file });
    const rulesMethod = cls.methods.find((m) => m.name === "rules" && m.body);
    const fields: { name: string; rules: string[] }[] = [];
    if (rulesMethod?.body) {
      // Best-effort support for the common Laravel shape:
      // return ['field' => 'required|string', 'tags' => ['array']];
      // Dynamic rule builders are intentionally reported as code location only.
      walkAst(rulesMethod.body, (node) => {
        if ((node as { kind?: string })?.kind !== "return") return;
        const expr = (node as { expr?: unknown }).expr;
        if (!expr || typeof expr !== "object" || (expr as { kind?: string }).kind !== "array") return;
        for (const item of ((expr as { items?: unknown[] }).items ?? [])) {
          const entry = item as { key?: unknown; value?: unknown };
          const name = literalString(entry.key);
          if (!name) continue;
          fields.push({ name, rules: ruleStrings(entry.value) });
        }
      });
    }
    return cacheFormRequest(ctx, fqcn, fields.length > 0 ? { file, fields } : { file });
  } catch {
    return cacheFormRequest(ctx, fqcn, { file });
  }
}

function cacheFormRequest(ctx: TraceContext, fqcn: string, data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  ctx.formRequestCache.set(fqcn, data);
  return data;
}

function literalString(node: unknown): string | null {
  if (!node) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const value = (node as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return null;
}

function ruleStrings(node: unknown): string[] {
  const direct = literalString(node);
  if (direct) return direct.split("|").filter(Boolean);
  if (!node || typeof node !== "object" || (node as { kind?: string }).kind !== "array") return [];
  const out: string[] = [];
  for (const item of ((node as { items?: unknown[] }).items ?? [])) {
    const value = (item as { value?: unknown }).value ?? item;
    const rule = literalString(value);
    if (rule) out.push(rule);
  }
  return out;
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

function isBuiltin(type: string): boolean {
  return new Set([
    "string", "int", "integer", "float", "double", "bool", "boolean", "array",
    "object", "callable", "mixed", "void", "null", "self", "static", "iterable",
  ]).has(type.toLowerCase());
}
