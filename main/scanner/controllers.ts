/**
 * ControllerAnalyzer â€” resolves controller FQCNs from routes to files via
 * PSR-4, then parses each class for constructor DI deps + public methods.
 */
import fs from "node:fs/promises";
import { parsePhp, extractUseMap, extractClasses, resolveClassRef, type PhpClass, type PhpMethod } from "./php";
import { resolveFqcn } from "./psr4";
import type { ControllerDefinition, MethodDefinition, Psr4Map, RouteDefinition } from "./types";

export async function analyzeControllers(
  routes: RouteDefinition[],
  psr4: Psr4Map,
  devPsr4: Psr4Map = {}
): Promise<Map<string, ControllerDefinition>> {
  const out = new Map<string, ControllerDefinition>();
  const seen = new Set<string>();

  for (const r of routes) {
    if (!r.controller || seen.has(r.controller)) continue;
    seen.add(r.controller);

    const file = resolveFqcn(r.controller, psr4, devPsr4);
    if (!file) continue;
    const def = await analyzeControllerFile(r.controller, file, psr4, devPsr4);
    if (def) out.set(r.controller, def);
  }
  return out;
}

async function analyzeControllerFile(
  fqcn: string,
  file: string,
  psr4: Psr4Map,
  devPsr4: Psr4Map
): Promise<ControllerDefinition | null> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return null;
  const ast = parsePhp(source, file);
  if (!ast) return null;
  const useMap = extractUseMap(ast);
  const classes = extractClasses(ast, file);
  const cls = classes.find((c) => c.fqcn === fqcn || c.name === fqcn.split("\\").pop());
  if (!cls) return null;

  const constructorDeps = extractConstructorDeps(cls, useMap);
  const methods: MethodDefinition[] = cls.methods
    .filter((m) => !m.isStatic)
    .map((m) => toMethodDef(m, fqcn));

  const parent = cls.extends ? resolveClassRef(cls.extends, useMap, parentNamespace(fqcn)) : undefined;

  // Pragmatic ancestor gathering: just record the immediate parent FQCN.
  const ancestorFqcns: string[] = [];
  if (parent) ancestorFqcns.push(parent);

  return { fqcn, file, constructorDeps, methods, parent, ancestorFqcns };
}

function extractConstructorDeps(
  cls: PhpClass,
  useMap: Map<string, string>
): { name: string; type: string }[] {
  const ctor = cls.methods.find((m) => m.name === "__construct");
  if (!ctor) return [];
  const deps: { name: string; type: string }[] = [];
  for (const param of ctor.parameters) {
    if (!param.type) continue;
    // Skip built-in types.
    if (isBuiltinType(param.type)) continue;
    const resolved = resolveClassRef(param.type, useMap, "");
    deps.push({ name: param.name, type: resolved });
  }
  return deps;
}

function toMethodDef(m: PhpMethod, declaringFqcn: string): MethodDefinition {
  return {
    name: m.name,
    visibility: m.visibility,
    parameters: m.parameters.map((p) => ({ name: p.name, type: p.type })),
    returnType: m.returnType,
    body: m.body,
    declaringFqcn,
    loc: m.loc,
  };
}

function parentNamespace(fqcn: string): string {
  const idx = fqcn.lastIndexOf("\\");
  return idx > 0 ? fqcn.slice(0, idx) : "";
}

function isBuiltinType(type: string): boolean {
  const builtins = new Set([
    "string", "int", "integer", "float", "double", "bool", "boolean", "array",
    "object", "callable", "mixed", "void", "null", "self", "static", "iterable",
    "never", "true", "false",
  ]);
  return builtins.has(type.toLowerCase());
}
