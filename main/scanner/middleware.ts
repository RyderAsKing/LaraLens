/**
 * MiddlewareAnalyzer — extracts the middleware registry from either
 * app/Http/Kernel.php (Laravel <=10) or bootstrap/app.php (Laravel 11).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  parsePhp,
  extractUseMap,
  walkAst,
  resolveClassRef,
  callName,
  stringValue,
  isCall,
  callKind,
  callMethod,
  callArgs,
  classConstName,
  unwrapNamedArg,
  namedArgName,
} from "./php";
import type { MiddlewareRegistry } from "./types";

export async function analyzeMiddleware(projectRoot: string): Promise<MiddlewareRegistry> {
  const registry: MiddlewareRegistry = { global: [], groups: {}, aliases: {} };

  const kernelPath = path.join(projectRoot, "app/Http/Kernel.php");
  const bootstrapPath = path.join(projectRoot, "bootstrap/app.php");

  if (existsSync(kernelPath)) {
    await parseKernel(kernelPath, registry);
  } else if (existsSync(bootstrapPath)) {
    await parseBootstrap(bootstrapPath, registry);
  }
  return registry;
}

async function parseKernel(file: string, registry: MiddlewareRegistry): Promise<void> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return;
  const ast = parsePhp(source, file);
  if (!ast) return;
  const useMap = extractUseMap(ast);
  const namespace = getNamespace(ast);
  if (!namespace) return;

  // Find property declarations: $middleware, $middlewareGroups, $middlewareAliases, $routeMiddleware
  walkAst(ast.root, (node) => {
    if ((node as { kind?: string }).kind !== "property") return;
    const p = node as { name?: unknown; value?: unknown };
    const name = nameOf(p.name);
    if (!name) return;
    const fqcnProp = (raw: string) => resolveClassRef(raw, useMap, namespace);

    if (name === "middleware") {
      for (const v of arrayValues(p.value)) registry.global.push(fqcnProp(v));
    } else if (name === "middlewareGroups") {
      for (const entry of arrayEntries(p.value)) {
        if (!entry.key) continue;
        registry.groups[entry.key] = arrayValues(entry.value).map(fqcnProp);
      }
    } else if (name === "middlewareAliases" || name === "routeMiddleware") {
      for (const entry of arrayEntries(p.value)) {
        if (!entry.key) continue;
        const v = stringValue(entry.value);
        if (v) registry.aliases[entry.key] = fqcnProp(v);
      }
    }
  });
}

async function parseBootstrap(file: string, registry: MiddlewareRegistry): Promise<void> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return;
  const ast = parsePhp(source, file);
  if (!ast) return;
  const useMap = extractUseMap(ast);
  const namespace = getNamespace(ast);

  // Laravel 11/12: ->withMiddleware(function(Middleware $middleware) {
  //   $middleware->web(append: [Foo::class, ...]);
  //   $middleware->alias(['name' => Foo::class, ...]);
  //   $middleware->append(Foo::class);
  // })
  // In glayzzle, ALL calls are `kind:'call'`. Method calls have `what.kind='propertylookup'`.
  // Named arguments are `kind:'namedargument'` with {name, value}.
  walkAst(ast.root, (node) => {
    if (!isCall(node)) return;
    const kind = callKind(node);
    if (kind !== "method" && kind !== "static") return;

    const name = callMethod(node);
    const rawArgs = callArgs(node);

    // ->alias('name', Fqcn::class)  (Laravel 11 two-arg form)
    // ->alias(['name' => Fqcn::class, ...])  (Laravel 12 array form)
    if (name === "alias") {
      if (rawArgs.length === 1 && (rawArgs[0] as { kind?: string })?.kind === "array") {
        // L12 associative array form
        for (const entry of arrayEntries(rawArgs[0])) {
          if (!entry.key) continue;
          const classRef = classConstName(entry.value);
          if (classRef) {
            registry.aliases[entry.key] = resolveClassRef(classRef, useMap, namespace);
          }
        }
      } else {
        // L11 two-arg form
        const alias = stringValue(rawArgs[0]);
        const classRef = classConstName(rawArgs[1]);
        if (alias && classRef) {
          registry.aliases[alias] = resolveClassRef(classRef, useMap, namespace);
        }
      }
      return;
    }

    // ->append(Fqcn::class) / ->prepend(...) — global append (best-effort)
    if (name === "append" || name === "prepend") {
      // Could be a direct class const or a named argument
      const arg0 = unwrapNamedArg(rawArgs[0]);
      const classRef = classConstName(arg0);
      if (classRef) registry.global.push(resolveClassRef(classRef, useMap, namespace));
      return;
    }

    // ->api([Fqcn::class,...]) / ->web([...]) — group append
    // L12: ->web(append: [Fqcn::class,...]) — named argument
    // L11: ->web([Fqcn::class,...]) — positional array argument
    if (name === "api" || name === "web") {
      // Find the array argument (either positional or named)
      let arrayArg: unknown = null;
      for (const arg of rawArgs) {
        const argName = namedArgName(arg);
        const val = unwrapNamedArg(arg);
        // Accept any named arg (append/prepend) or a positional array
        if ((val as { kind?: string })?.kind === "array") {
          arrayArg = val;
          break;
        }
        void argName;
      }
      if (arrayArg) {
        const fqcns = arrayValues(arrayArg)
          .filter(Boolean)
          .map((c) => resolveClassRef(c, useMap, namespace));
        if (fqcns.length > 0) {
          const existing = registry.groups[name] ?? [];
          registry.groups[name] = [...existing, ...fqcns];
        }
      }
      return;
    }

    // ->remove(...) / ->redirectGuestTo(...) etc. — best-effort skip
  });
}

function nameOf(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string };
    if (typeof n.name === "string") return n.name;
  }
  return "";
}

function getNamespace(ast: { root: unknown }): string {
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

/** Extract class names or string values from an array node's items. */
function arrayValues(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  if ((node as { kind?: string }).kind !== "array") return [];
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const item = it as { value?: unknown };
    const val = item?.value ?? it;
    // Foo::class → staticlookup
    const classRef = classConstName(val);
    if (classRef) {
      out.push(classRef);
      continue;
    }
    const s = stringValue(val);
    if (s) out.push(s);
  }
  return out;
}

function arrayEntries(node: unknown): { key: string | null; value: unknown }[] {
  if (!node || typeof node !== "object") return [];
  if ((node as { kind?: string }).kind !== "array") return [];
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const item = it as { key?: unknown; value?: unknown };
    return { key: item.key ? stringValue(item.key) : null, value: item.value };
  });
}
