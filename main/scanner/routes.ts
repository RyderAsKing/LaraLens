/**
 * RouteAnalyzer — discovers route definitions from routes/*.php files using
 * php-parser AST. Handles Route::verb(), Route::group() context stacking,
 * Route::resource()/apiResource(), method chaining, and bare require/include.
 *
 * Uses the glayzzle/php-parser v3 AST structure where all calls are `kind:'call'`
 * with `what` being `staticlookup` (Class::method), `propertylookup` ($obj->method),
 * or `name` (function()).
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  parsePhp,
  extractUseMap,
  callName,
  walkAst,
  resolveClassRef,
  stringValue,
  isCall,
  classConstName,
  isInclude,
  includeTarget,
  resolveIncludePath,
  type PhpAst,
} from "./php";
import type { RouteDefinition } from "./types";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "any", "match"]);
const MODIFIERS = new Set(["middleware", "prefix", "name", "namespace", "controller", "as"]);

interface GroupContext {
  prefix: string;
  middlewares: string[];
  namespace: string;
  namePrefix: string;
  controller?: string;
}

function emptyContext(): GroupContext {
  return { prefix: "", middlewares: [], namespace: "", namePrefix: "" };
}

interface ChainCall {
  name: string;
  args: unknown[];
  kind: "static" | "method";
}

/**
 * Flatten a method chain into ordered calls (from first/base to last/terminal).
 * In glayzzle's AST, a chain like Route::middleware('x')->get('/uri', $action)
 * is nested as:
 *   call(what=propertylookup(
 *     what=call(what=staticlookup(what=name("Route"), offset=id("middleware")), args=["x"]),
 *     offset=id("get")
 *   ), args=["/uri", $action])
 *
 * We walk from the outermost call inward, unshifting to get [middleware, get].
 * The receiver (base class name) is extracted from the innermost staticlookup.
 */
function flattenChain(node: unknown): { receiver: string; calls: ChainCall[] } {
  const calls: ChainCall[] = [];
  let current = node;

  while (current && typeof current === "object" && (current as { kind?: string }).kind === "call") {
    const what = (current as { what?: unknown }).what;
    const whatKind = (what as { kind?: string })?.kind;
    const args = (current as { arguments?: unknown[] }).arguments ?? [];

    if (whatKind === "staticlookup") {
      // Class::method() — base of the chain
      const receiver = callName((what as { what?: unknown }).what);
      const method = callName((what as { offset?: unknown }).offset);
      calls.unshift({ name: method, args, kind: "static" });
      return { receiver, calls };
    } else if (whatKind === "propertylookup") {
      // ->method() — intermediate or terminal chain call
      const method = callName((what as { offset?: unknown }).offset);
      calls.unshift({ name: method, args, kind: "method" });
      // Move to the receiver (which is another call in the chain)
      current = (what as { what?: unknown }).what;
    } else {
      return { receiver: "", calls };
    }
  }
  return { receiver: "", calls };
}

function arrayItems(node: unknown): unknown[] {
  if (!node || typeof node !== "object") return [];
  if ((node as { kind?: string }).kind !== "array") return [];
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const item = it as { value?: unknown };
    return item?.value ?? it;
  });
}

/** Extract key=>value pairs from a PHP array literal AST node. */
function arrayEntries(node: unknown): { key: string | null; value: unknown }[] {
  if (!node || typeof node !== "object") return [];
  if ((node as { kind?: string }).kind !== "array") return [];
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const item = it as { key?: unknown; value?: unknown };
    return {
      key: item.key ? stringValue(item.key) : null,
      value: item.value,
    };
  });
}

export async function analyzeRoutes(projectRoot: string): Promise<RouteDefinition[]> {
  const routeFiles = await fg(["routes/**/*.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });

  const routes: RouteDefinition[] = [];
  for (const file of routeFiles) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const useMap = extractUseMap(ast);
    const namespace = getNamespace(ast);
    const baseContext: GroupContext = { ...emptyContext(), namespace };
    collectRoutes(ast, file, useMap, namespace, baseContext, routes);
  }
  return routes;
}

function getNamespace(ast: PhpAst): string {
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

/**
 * Collect routes from an AST. Finds all `call` nodes whose chain receiver is
 * `Route`, processes verbs/groups/resources, and handles bare require/include.
 */
function collectRoutes(
  ast: PhpAst,
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  context: GroupContext,
  out: RouteDefinition[]
): void {
  // Find intermediate calls (calls that are receivers of other calls in a chain)
  // to avoid double-processing. Only the outermost call in each chain should be processed.
  const intermediateCalls = new Set<unknown>();
  walkAst(ast.root, (node) => {
    if (!isCall(node)) return;
    const what = (node as { what?: unknown }).what;
    if (what && typeof what === "object" && (what as { kind?: string }).kind === "propertylookup") {
      const receiver = (what as { what?: unknown }).what;
      if (isCall(receiver)) {
        intermediateCalls.add(receiver);
      }
    }
  });

  walkAst(ast.root, (node) => {
    // Handle bare require/include statements
    if (isInclude(node)) {
      const target = includeTarget(node);
      const resolved = resolveIncludePath(target, file);
      if (resolved) {
        void scanIncludedFile(resolved, useMap, namespace, context, out);
      }
      return;
    }

    if (!isCall(node) || intermediateCalls.has(node)) return;

    const chain = flattenChain(node);
    if (chain.receiver !== "Route") return;

    // Find the main call (first verb/group/resource in the chain)
    let mainIndex = -1;
    for (let i = 0; i < chain.calls.length; i++) {
      const name = chain.calls[i]!.name;
      if (VERBS.has(name) || name === "group" || name === "resource" || name === "apiResource") {
        mainIndex = i;
        break;
      }
    }
    if (mainIndex === -1) return;

    // Pre-modifiers: calls before the main call
    const localCtx: GroupContext = { ...context };
    for (let i = 0; i < mainIndex; i++) {
      applyChainModifier(chain.calls[i]!, localCtx);
    }

    const main = chain.calls[mainIndex]!;

    // Post-modifiers: calls after the main call (e.g. ->name(), ->middleware())
    const postModifiers = chain.calls.slice(mainIndex + 1);

    if (main.name === "group") {
      handleGroup(main.args, file, useMap, namespace, localCtx, out);
    } else if (VERBS.has(main.name)) {
      handleVerb(main.name, main.args, postModifiers, file, useMap, namespace, localCtx, out);
    } else if (main.name === "resource" || main.name === "apiResource") {
      handleResource(main.name, main.args, file, useMap, namespace, localCtx, out);
    }
  });
}

function applyChainModifier(call: ChainCall, ctx: GroupContext): void {
  if (!MODIFIERS.has(call.name)) return;
  switch (call.name) {
    case "middleware": {
      for (const arg of call.args) {
        const vals = arrayItems(arg);
        if (vals.length > 0) {
          for (const v of vals) {
            const s = stringValue(v);
            if (s) ctx.middlewares.push(s);
          }
        } else {
          const s = stringValue(arg);
          if (s) ctx.middlewares.push(s);
        }
      }
      break;
    }
    case "prefix": {
      const s = stringValue(call.args[0]);
      if (s) ctx.prefix = ctx.prefix ? `${ctx.prefix}/${s}`.replace(/\/+/g, "/") : s;
      break;
    }
    case "name":
    case "as": {
      const s = stringValue(call.args[0]);
      if (s) ctx.namePrefix = ctx.namePrefix + s;
      break;
    }
    case "namespace": {
      const s = stringValue(call.args[0]);
      if (s) ctx.namespace = s;
      break;
    }
    case "controller": {
      const s = stringValue(call.args[0]);
      if (s) ctx.controller = s;
      break;
    }
  }
}

function handleVerb(
  verb: string,
  args: unknown[],
  postModifiers: ChainCall[],
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext,
  out: RouteDefinition[]
): void {
  let methods: string[];
  let actionNode: unknown;
  let uriNode: unknown;

  if (verb === "match") {
    // Route::match(['get','post'], uri, action)
    methods = arrayItems(args[0]).map((m) => stringValue(m)).filter(Boolean) as string[];
    uriNode = args[1];
    actionNode = args[2];
  } else {
    methods = [verb.toUpperCase()];
    uriNode = args[0];
    actionNode = args[1];
  }

  const uri = stringValue(uriNode);
  if (!uri) return;
  const fullUri = joinUri(ctx.prefix, uri);
  const line = getLine(actionNode);

  for (const method of methods) {
    const entry: RouteDefinition = {
      method: method.toUpperCase(),
      uri: fullUri,
      middlewares: [...ctx.middlewares],
      name: ctx.namePrefix || undefined,
      file,
      line,
      isClosure: false,
    };

    // Apply post-modifiers (e.g. ->name('foo'), ->middleware('bar'))
    for (const pm of postModifiers) {
      if (pm.name === "name" || pm.name === "as") {
        const s = stringValue(pm.args[0]);
        if (s) entry.name = (ctx.namePrefix || "") + s;
      } else if (pm.name === "middleware") {
        for (const arg of pm.args) {
          const vals = arrayItems(arg);
          if (vals.length > 0) {
            for (const v of vals) {
              const s = stringValue(v);
              if (s) entry.middlewares.push(s);
            }
          } else {
            const s = stringValue(arg);
            if (s) entry.middlewares.push(s);
          }
        }
      }
    }

    // Action can be: "Controller@method", ["Controller","method"], [Class::class, 'method'],
    // Closure, or "Controller" (__invoke)
    resolveAction(actionNode, entry, useMap, namespace, ctx);
    out.push(entry);
  }
}

function resolveAction(
  actionNode: unknown,
  entry: RouteDefinition,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext
): void {
  if (!actionNode || typeof actionNode !== "object") return;
  const k = (actionNode as { kind?: string }).kind;

  if (k === "closure" || k === "arrowfunc") {
    entry.isClosure = true;
    entry.closureNode = actionNode;
    return;
  }

  if (k === "array") {
    // [Controller::class, 'method'] or ['Controller', 'method']
    const items = arrayItems(actionNode);
    let controllerStr: string | null = null;
    const first = items[0];
    const second = items[1];

    // Check if first element is Class::class (staticlookup with offset='class')
    const classConst = classConstName(first);
    if (classConst) {
      controllerStr = classConst;
    } else {
      controllerStr = stringValue(first);
    }
    const methodStr = stringValue(second);
    if (controllerStr && methodStr) {
      entry.controller = resolveControllerRef(controllerStr, useMap, namespace, ctx);
      entry.action = methodStr;
    }
    return;
  }

  if (k === "string") {
    const s = stringValue(actionNode);
    if (s) {
      if (s.includes("@")) {
        const [controllerStr, methodStr] = s.split("@");
        entry.controller = resolveControllerRef(controllerStr ?? "", useMap, namespace, ctx);
        entry.action = methodStr;
      } else {
        // Could be "Controller" (invokable) or a PHP callable class
        entry.controller = resolveControllerRef(s, useMap, namespace, ctx);
        entry.action = "__invoke";
      }
    }
  }
}

function resolveControllerRef(
  ref: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext
): string {
  const ns = ctx.namespace || namespace;
  if (ref.includes("\\")) {
    return ref.replace(/^\\/, "");
  }
  const head = ref.split("\\")[0]!;
  if (useMap.has(head)) {
    const fqcn = useMap.get(head)!;
    return ref.includes("\\") ? fqcn + ref.slice(head.length) : fqcn;
  }
  // Default: resolve in current namespace. For route files, Laravel convention
  // is App\Http\Controllers, but the route file may not have that namespace.
  // We return the ref as-is; the controller analyzer will try PSR-4 resolution.
  return ns ? `${ns}\\${ref}` : ref;
}

function handleGroup(
  args: unknown[],
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext,
  out: RouteDefinition[]
): void {
  const optsNode = args[0];
  const bodyNode = args[1];

  const inner: GroupContext = { ...ctx };

  // Options can be an array literal.
  if (optsNode && typeof optsNode === "object" && (optsNode as { kind?: string }).kind === "array") {
    for (const entry of arrayEntries(optsNode)) {
      if (!entry.key) continue;
      switch (entry.key) {
        case "prefix": {
          const s = stringValue(entry.value);
          if (s) inner.prefix = joinUri(ctx.prefix, s);
          break;
        }
        case "middleware": {
          const vals = arrayItems(entry.value);
          if (vals.length > 0) {
            for (const v of vals) {
              const s = stringValue(v);
              if (s) inner.middlewares.push(s);
            }
          } else {
            const s = stringValue(entry.value);
            if (s) inner.middlewares.push(s);
          }
          break;
        }
        case "namespace": {
          const s = stringValue(entry.value);
          if (s) inner.namespace = s;
          break;
        }
        case "as":
        case "name": {
          const s = stringValue(entry.value);
          if (s) inner.namePrefix = ctx.namePrefix + s;
          break;
        }
        case "controller": {
          const s = stringValue(entry.value);
          if (s) inner.controller = s;
          break;
        }
      }
    }
  }

  if (!bodyNode) return;
  const k = (bodyNode as { kind?: string }).kind;
  if (k === "closure" || k === "arrowfunc") {
    // Walk the closure body for nested route definitions.
    const body = (bodyNode as { body?: unknown }).body;
    if (body) {
      scanRouteNodes(body, file, useMap, namespace, inner, out);
    }
  } else if (typeof bodyNode === "object" && (bodyNode as { kind?: string }).kind === "string") {
    // Route::group([...], 'file.php') — require the file and scan it.
    const relPath = stringValue(bodyNode);
    if (relPath) {
      const resolved = path.resolve(path.dirname(file), relPath);
      void scanIncludedFile(resolved, useMap, namespace, inner, out);
    }
  }
}

/** Scan route-level nodes (calls + includes) from a closure body or AST root. */
function scanRouteNodes(
  body: unknown,
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext,
  out: RouteDefinition[]
): void {
  // Find intermediate calls to avoid double-processing.
  const intermediateCalls = new Set<unknown>();
  walkAst(body, (node) => {
    if (!isCall(node)) return;
    const what = (node as { what?: unknown }).what;
    if (what && typeof what === "object" && (what as { kind?: string }).kind === "propertylookup") {
      const receiver = (what as { what?: unknown }).what;
      if (isCall(receiver)) {
        intermediateCalls.add(receiver);
      }
    }
  });

  walkAst(body, (node) => {
    if (isInclude(node)) {
      const target = includeTarget(node);
      const resolved = resolveIncludePath(target, file);
      if (resolved) {
        void scanIncludedFile(resolved, useMap, namespace, ctx, out);
      }
      return;
    }

    if (!isCall(node) || intermediateCalls.has(node)) return;

    const chain = flattenChain(node);
    if (chain.receiver !== "Route") return;

    let mainIndex = -1;
    for (let i = 0; i < chain.calls.length; i++) {
      const name = chain.calls[i]!.name;
      if (VERBS.has(name) || name === "group" || name === "resource" || name === "apiResource") {
        mainIndex = i;
        break;
      }
    }
    if (mainIndex === -1) return;

    const localCtx: GroupContext = { ...ctx };
    for (let i = 0; i < mainIndex; i++) {
      applyChainModifier(chain.calls[i]!, localCtx);
    }
    const main = chain.calls[mainIndex]!;
    const postModifiers = chain.calls.slice(mainIndex + 1);

    if (main.name === "group") {
      handleGroup(main.args, file, useMap, namespace, localCtx, out);
    } else if (VERBS.has(main.name)) {
      handleVerb(main.name, main.args, postModifiers, file, useMap, namespace, localCtx, out);
    } else if (main.name === "resource" || main.name === "apiResource") {
      handleResource(main.name, main.args, file, useMap, namespace, localCtx, out);
    }
  });
}

async function scanIncludedFile(
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext,
  out: RouteDefinition[]
): Promise<void> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return;
  const ast = parsePhp(source, file);
  if (!ast) return;
  const fileUseMap = extractUseMap(ast);
  const fileNamespace = getNamespace({ root: ast.root, source, filename: file });
  const mergedUseMap = new Map([...useMap, ...fileUseMap]);
  collectRoutes(ast, file, mergedUseMap, fileNamespace || namespace, ctx, out);
}

function handleResource(
  type: "resource" | "apiResource",
  args: unknown[],
  file: string,
  useMap: Map<string, string>,
  namespace: string,
  ctx: GroupContext,
  out: RouteDefinition[]
): void {
  const uri = stringValue(args[0]);
  const controllerNode = args[1];
  // Controller can be a string or Class::class
  let controllerStr = stringValue(controllerNode);
  if (!controllerStr) {
    controllerStr = classConstName(controllerNode);
  }
  if (!uri || !controllerStr) return;
  const fullUri = joinUri(ctx.prefix, uri);
  const controller = resolveControllerRef(controllerStr, useMap, namespace, ctx);

  const line = getLine(controllerNode);
  const methods: Record<string, string> = type === "apiResource"
    ? { GET: "index", POST: "store", GET_SHOW: "show", PUT: "update", DELETE: "destroy" }
    : { GET: "index", GET_CREATE: "create", POST: "store", GET_SHOW: "show", GET_EDIT: "edit", PUT: "update", DELETE: "destroy" };

  const baseMiddlewares = [...ctx.middlewares];
  const make = (method: string, suffix: string, action: string): RouteDefinition => ({
    method,
    uri: suffix ? `${fullUri}/${suffix}` : fullUri,
    controller,
    action,
    middlewares: baseMiddlewares,
    name: undefined,
    file,
    line,
    isClosure: false,
  });
  out.push(make("GET", "", methods.GET!));
  if (methods.GET_CREATE) out.push(make("GET", "create", methods.GET_CREATE));
  out.push(make("POST", "", methods.POST!));
  out.push(make("GET", "{id}", methods.GET_SHOW!));
  if (methods.GET_EDIT) out.push(make("GET", "{id}/edit", methods.GET_EDIT));
  out.push(make("PUT", "{id}", methods.PUT!));
  out.push(make("DELETE", "{id}", methods.DELETE!));
}

function joinUri(prefix: string, uri: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const u = uri.replace(/^\/+|\/+$/g, "");
  const joined = [p, u].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
}

function getLine(node: unknown): number {
  if (node && typeof node === "object") {
    const loc = (node as { loc?: { start?: { line?: number } } }).loc;
    return loc?.start?.line ?? 0;
  }
  return 0;
}
