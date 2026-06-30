/**
 * ModelAnalyzer â€” discovers Eloquent models and extracts relationships,
 * fillable, guarded, casts, table, and SoftDeletes usage.
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { existsSync } from "node:fs";
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
  callMethod,
  callReceiver,
  callArgs,
  classConstName,
} from "./php";
import { resolveFqcn } from "./psr4";
import type { ModelDefinition, ModelRelationship, Psr4Map } from "./types";

const RELATIONSHIP_METHODS = new Set([
  "hasMany",
  "hasManyThrough",
  "hasOneThrough",
  "hasOne",
  "belongsTo",
  "belongsToMany",
  "hasOneOfMany",
  "morphTo",
  "morphMany",
  "morphOne",
  "morphToMany",
  "morphedByMany",
  "morphPivot",
]);

const ELOQUENT_BASES = new Set([
  "Model",
  "Illuminate\\Database\\Eloquent\\Model",
  "Illuminate\\Database\\Eloquent\\Pivot",
  "Illuminate\\Foundation\\Auth\\User",
  "Authenticatable",
  "Illuminate\\Foundation\\Auth\\Authenticatable",
  "Laravel\\Sanctum\\HasApiTokens",
]);

export async function discoverModels(
  projectRoot: string,
  psr4: Psr4Map
): Promise<{ fqcn: string; file: string }[]> {
  // Prefer app/Models, fallback to all PSR-4 roots.
  const modelGlobs = ["app/Models/**/*.php"];
  let files = await fg(modelGlobs, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });

  if (files.length === 0) {
    const allRoots = Object.values(psr4).flat();
    files = await fg(
      allRoots.map((r) => `${r.replace(/\\/g, "/")}/**/*.php`),
      { onlyFiles: true, ignore: ["**/vendor/**", "**/node_modules/**"] }
    );
  }

  const models: { fqcn: string; file: string }[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const classes = extractClasses(ast, file);
    for (const cls of classes) {
      if (!cls.extends) continue;
      if (isEloquentModel(cls.extends)) {
        models.push({ fqcn: cls.fqcn, file });
      }
    }
  }
  return models;
}

function isEloquentModel(extendsName: string): boolean {
  const clean = extendsName.replace(/^\\/, "");
  return (
    ELOQUENT_BASES.has(clean) ||
    ELOQUENT_BASES.has(`Illuminate\\Database\\Eloquent\\${clean}`) ||
    clean === "Model" ||
    clean.endsWith("\\Model")
  );
}

export async function analyzeModels(
  projectRoot: string,
  psr4: Psr4Map,
  devPsr4: Psr4Map = {},
  extraFqcns: string[] = []
): Promise<Map<string, ModelDefinition>> {
  const discovered = await discoverModels(projectRoot, psr4);
  const fqcnSet = new Set<string>(discovered.map((m) => m.fqcn));
  for (const f of extraFqcns) fqcnSet.add(f);

  const out = new Map<string, ModelDefinition>();
  for (const { fqcn, file } of discovered) {
    const def = await analyzeModelFile(fqcn, file, psr4, devPsr4);
    if (def) out.set(fqcn, def);
  }
  // Analyze extra FQCNs from the call chain that weren't discovered.
  for (const fqcn of extraFqcns) {
    if (out.has(fqcn)) continue;
    const file = resolveFqcn(fqcn, psr4, devPsr4);
    if (!file || !existsSync(file)) continue;
    const def = await analyzeModelFile(fqcn, file, psr4, devPsr4);
    if (def) out.set(fqcn, def);
  }
  return out;
}

async function analyzeModelFile(
  fqcn: string,
  file: string,
  psr4: Psr4Map,
  _devPsr4: Psr4Map
): Promise<ModelDefinition | null> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return null;
  const ast = parsePhp(source, file);
  if (!ast) return null;
  const useMap = extractUseMap(ast);
  const namespace = getNamespace(ast);
  const classes = extractClasses(ast, file);
  const cls = classes.find((c) => c.fqcn === fqcn || c.name === fqcn.split("\\").pop());
  if (!cls) return null;

  const relationships: ModelRelationship[] = [];

  for (const method of cls.methods) {
    if (method.isStatic || !method.body) continue;
    walkAst(method.body, (node) => {
      // In glayzzle, method calls are `kind:'call'` with `what.kind='propertylookup'`.
      if (!isCall(node)) return;
      if (callKind(node) !== "method") return;
      const name = callMethod(node);
      if (!RELATIONSHIP_METHODS.has(name)) return;
      // Confirm the receiver chain starts with $this.
      const receiver = callReceiver(node);
      if (receiver !== "$this") return;
      const args = callArgs(node);
      const related = firstClassArg(args, useMap, namespace);
      relationships.push({
        type: name,
        related: related ?? "",
        name: method.name,
      });
    });
  }

  const fillable = readStringArrayProperty(cls, "fillable");
  const guarded = readStringArrayProperty(cls, "guarded");
  const casts = readCasts(cls);
  const table = readStringProperty(cls, "table");
  const primaryKey = readStringProperty(cls, "primaryKey");
  const usesSoftDeletes = cls.traits.some((t) => t === "SoftDeletes" || t.endsWith("\\SoftDeletes"));
  const timestamps = readBoolProperty(cls, "timestamps", true);

  return {
    fqcn,
    file,
    relationships,
    fillable,
    guarded,
    casts,
    table,
    primaryKey,
    usesSoftDeletes,
    timestamps,
  };
}

function firstClassArg(
  args: unknown[] | undefined,
  useMap: Map<string, string>,
  namespace: string
): string | null {
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0]!;
  // `RelatedModel::class` → staticlookup in glayzzle
  const classRef = classConstName(first);
  if (classRef) return resolveClassRef(classRef, useMap, namespace);
  // string literal
  const s = stringValue(first);
  if (s) return s.includes("\\") ? s.replace(/^\\/, "") : `${namespace}\\${s}`;
  return null;
}

function readStringArrayProperty(cls: { properties: { name: string; value?: unknown }[] }, propName: string): string[] {
  const prop = cls.properties.find((p) => p.name === propName);
  if (!prop || !prop.value || typeof prop.value !== "object") return [];
  if ((prop.value as { kind?: string }).kind !== "array") return [];
  const items = (prop.value as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const item = it as { value?: unknown };
    const val = item?.value ?? it;
    if (val && typeof val === "object" && (val as { kind?: string }).kind === "string") {
      const v = (val as { value?: unknown }).value;
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

function readStringProperty(cls: { properties: { name: string; value?: unknown }[] }, propName: string): string | undefined {
  const prop = cls.properties.find((p) => p.name === propName);
  if (!prop || !prop.value || typeof prop.value !== "object") return undefined;
  if ((prop.value as { kind?: string }).kind === "string") {
    const v = (prop.value as { value?: unknown }).value;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function readBoolProperty(cls: { properties: { name: string; value?: unknown }[] }, propName: string, defaultValue: boolean): boolean {
  const prop = cls.properties.find((p) => p.name === propName);
  if (!prop || !prop.value) return defaultValue;
  const v = prop.value;
  if (typeof v === "object" && v !== null && (v as { kind?: string }).kind === "boolean") {
    const b = (v as { value?: unknown }).value;
    return typeof b === "boolean" ? b : defaultValue;
  }
  return defaultValue;
}

function readCasts(cls: { properties: { name: string; value?: unknown }[] }): Record<string, string> {
  const prop = cls.properties.find((p) => p.name === "casts");
  if (!prop || !prop.value || typeof prop.value !== "object") return {};
  if ((prop.value as { kind?: string }).kind !== "array") return {};
  const items = (prop.value as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return {};
  const casts: Record<string, string> = {};
  for (const it of items) {
    const item = it as { key?: unknown; value?: unknown };
    const key = item.key && typeof item.key === "object" ? (item.key as { value?: unknown }).value : null;
    const value = item.value && typeof item.value === "object" ? (item.value as { value?: unknown }).value : null;
    if (typeof key === "string" && typeof value === "string") {
      casts[key] = value;
    }
  }
  return casts;
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
