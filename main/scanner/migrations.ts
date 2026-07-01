/**
 * MigrationAnalyzer — parses `database/migrations/*.php` to extract each
 * table's column schema from Blueprint calls (`$table->string('name')`, etc.).
 *
 * The model analyzer only reads `$fillable`/`$guarded`/`$casts` from the model
 * class, which is empty for many projects. The authoritative column list lives
 * in migrations, so this module builds a `Map<tableName, MigrationColumn[]>`
 * that the model analyzer joins onto each model (by its resolved table name).
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  parsePhp,
  walkAst,
  stringValue,
  isCall,
  callKind,
  callMethod,
  callArgs,
} from "./php";
import type { MigrationColumn } from "./types";

/** Blueprint column-type methods → a short DB type label for the ER card. */
const COLUMN_TYPES: Record<string, string> = {
  bigInteger: "bigint",
  binary: "binary",
  boolean: "boolean",
  char: "char",
  date: "date",
  dateTime: "datetime",
  dateTimeTz: "datetime",
  dateFormats: "date",
  decimal: "decimal",
  double: "double",
  enum: "enum",
  float: "float",
  id: "bigint",
  integer: "int",
  ipAddress: "varchar",
  json: "json",
  jsonb: "jsonb",
  longText: "longtext",
  macAddress: "varchar",
  mediumInteger: "mediumint",
  mediumText: "mediumtext",
  set: "set",
  smallInteger: "smallint",
  string: "varchar",
  text: "text",
  time: "time",
  timeTz: "time",
  timestamp: "timestamp",
  timestampTz: "timestamp",
  tinyInteger: "tinyint",
  tinyText: "tinytext",
  ulid: "ulid",
  ulidMorphs: "ulid",
  uuid: "uuid",
  year: "year",
};

/** Methods that create an auto-incrementing primary key column. */
const PK_AUTO_METHODS = new Set([
  "bigIncrements",
  "increments",
  "mediumIncrements",
  "smallIncrements",
  "tinyIncrements",
  "id",
]);

/** Methods that expand to multiple columns. */
const MORPH_METHODS = new Set([
  "morphs",
  "nullableMorphs",
  "uuidMorphs",
  "nullableUuidMorphs",
  "ulidMorphs",
  "nullableUlidMorphs",
]);

/**
 * Discover and parse all migration files, returning a table → columns map.
 *
 * Files are processed in filename order (migrations are timestamp-prefixed, so
 * chronological order keeps `Schema::create` ahead of later `Schema::table`
 * alterations). `Schema::create` replaces a table's columns; `Schema::table`
 * mutates the existing list (adds new columns, applies `dropColumn`, etc.).
 */
export async function analyzeMigrations(
  projectRoot: string
): Promise<Map<string, MigrationColumn[]>> {
  const files = await fg(["database/migrations/**/*.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });

  const sorted = files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const tables = new Map<string, MigrationColumn[]>();

  for (const file of sorted) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;

    walkAst(ast.root, (node) => {
      const info = schemaCallInfo(node);
      if (!info) return;
      if (info.method === "create") {
        const { table, columns } = parseCreateCall(info.args);
        if (table) tables.set(table, columns);
      } else if (info.method === "table") {
        const { table, mutations } = parseTableCall(info.args);
        if (!table) return;
        const existing = tables.get(table) ?? [];
        tables.set(table, applyMutations(existing, mutations));
      }
    });
  }

  return tables;
}

interface SchemaCallInfo {
  method: string;
  args: unknown[];
}

/**
 * Recognize a `Schema::create(...)` / `Schema::table(...)` call, including the
 * chained `Schema::connection('foo')->create(...)` form. Returns the outermost
 * method name and its arguments so callers can route on create vs. table.
 */
function schemaCallInfo(node: unknown): SchemaCallInfo | null {
  if (!isCall(node)) return null;
  const method = callMethod(node);
  if (method !== "create" && method !== "table") return null;
  const args = callArgs(node);

  // Walk down the call chain until we bottom out at a static Schema base.
  let cur: unknown = node;
  while (isCall(cur)) {
    const what = (cur as { what?: unknown }).what;
    const whatKind = (what as { kind?: string })?.kind;
    if (whatKind === "staticlookup") {
      const receiver = (what as { what?: { name?: unknown }; whatName?: unknown }).what;
      const receiverName = nameOfNode(receiver);
      if (receiverName === "Schema" || receiverName === "\\Schema" || receiverName === "\\Illuminate\\Support\\Facades\\Schema") {
        return { method, args };
      }
      return null;
    }
    if (whatKind === "propertylookup") {
      cur = (what as { what?: unknown }).what;
      continue;
    }
    return null;
  }
  return null;
}

interface TableMutation {
  kind: "add" | "drop" | "dropMany";
  columns?: MigrationColumn[];
  names?: string[];
}

function parseCreateCall(args: unknown[]): { table: string | null; columns: MigrationColumn[] } {
  const tableName = stringValue(args[0]);
  if (!tableName) return { table: null, columns: [] };
  const closure = args[1];
  const columns = closure ? parseClosureColumns(closure) : [];
  return { table: tableName, columns };
}

function parseTableCall(args: unknown[]): { table: string | null; mutations: TableMutation[] } {
  const tableName = stringValue(args[0]);
  if (!tableName) return { table: null, mutations: [] };
  const closure = args[1];
  const mutations = closure ? parseClosureMutations(closure) : [];
  return { table: tableName, mutations };
}

function applyMutations(existing: MigrationColumn[], mutations: TableMutation[]): MigrationColumn[] {
  const out = [...existing];
  for (const m of mutations) {
    if (m.kind === "add" && m.columns) {
      out.push(...m.columns);
    } else if (m.kind === "drop" && m.names) {
      for (const name of m.names) {
        const idx = out.findIndex((c) => c.name === name);
        if (idx >= 0) out.splice(idx, 1);
      }
    } else if (m.kind === "dropMany" && m.names) {
      const drop = new Set(m.names);
      for (let i = out.length - 1; i >= 0; i--) {
        if (drop.has(out[i]!.name)) out.splice(i, 1);
      }
    }
  }
  return out;
}

/**
 * Parse a Schema::create closure body into an ordered column list. Each
 * top-level statement is a `$table->method(args)->modifier()` chain; the base
 * call defines a column (or expands to several) and the trailing calls are
 * modifiers (nullable, default, primary, ...).
 */
function parseClosureColumns(closureNode: unknown): MigrationColumn[] {
  const blueprintVar = closureParamName(closureNode) ?? "table";
  const children = closureBodyChildren(closureNode);
  const columns: MigrationColumn[] = [];

  for (const stmt of children) {
    const expr = expressionOf(stmt);
    const chain = flattenChain(expr, blueprintVar);
    if (!chain) continue;
    columns.push(...chainToColumns(chain));
  }

  return columns;
}

/**
 * Parse a Schema::table closure body into ordered mutations (add/drop). Adds
 * come from column-defining chains just like in create; drops come from
 * `dropColumn` / `dropTimestamps` / `dropSoftDeletes` / `dropMorphs` /
 * `dropRememberToken`.
 */
function parseClosureMutations(closureNode: unknown): TableMutation[] {
  const blueprintVar = closureParamName(closureNode) ?? "table";
  const children = closureBodyChildren(closureNode);
  const mutations: TableMutation[] = [];

  for (const stmt of children) {
    const expr = expressionOf(stmt);
    const chain = flattenChain(expr, blueprintVar);
    if (!chain) continue;

    const drop = dropMutation(chain.baseMethod, chain.baseArgs);
    if (drop) {
      mutations.push(drop);
      continue;
    }

    const cols = chainToColumns(chain);
    if (cols.length > 0) {
      mutations.push({ kind: "add", columns: cols });
    }
  }

  return mutations;
}

interface ColumnChain {
  baseMethod: string;
  baseArgs: unknown[];
  modifiers: string[];
  modifierArgs: Map<string, unknown[]>;
}

/**
 * Flatten a `$table->m1()->m2()->...()->base(args)` chain. Returns the base
 * column method + args plus the trailing modifier method names. Only chains
 * that bottom out at a direct call on the blueprint variable are recognized.
 */
function flattenChain(node: unknown, blueprintVar: string): ColumnChain | null {
  if (!isCall(node) || callKind(node) !== "method") return null;

  const modifiers: string[] = [];
  const modifierArgs = new Map<string, unknown[]>();

  let cur: unknown = node;
  while (isCall(cur) && callKind(cur) === "method") {
    const what = (cur as { what?: unknown }).what;
    const base = (what as { what?: unknown }).what;
    const methodName = callMethod(cur);
    const methodArgs = callArgs(cur);

    if (
      base &&
      typeof base === "object" &&
      (base as { kind?: string }).kind === "variable" &&
      nameOfNode((base as { name?: unknown }).name) === blueprintVar
    ) {
      // Reached the blueprint base — this call is the column definition.
      return { baseMethod: methodName, baseArgs: methodArgs, modifiers, modifierArgs };
    }

    if (base && typeof base === "object" && (base as { kind?: string }).kind === "call") {
      // Trailing modifier (outer to inner). Record and descend.
      modifiers.push(methodName);
      modifierArgs.set(methodName, methodArgs);
      cur = base;
      continue;
    }

    return null;
  }
  return null;
}

/** Convert a parsed chain into zero or more concrete columns. */
function chainToColumns(chain: ColumnChain): MigrationColumn[] {
  const { baseMethod, baseArgs, modifiers, modifierArgs } = chain;
  const nullable = modifiers.includes("nullable");
  const primary =
    modifiers.includes("primary") || PK_AUTO_METHODS.has(baseMethod);
  const autoIncrement = PK_AUTO_METHODS.has(baseMethod);
  const defaultExpr = modifierArgs.get("default")?.[0];
  const defaultValue = defaultExpr ? expressionToDefault(defaultExpr) : undefined;

  const base: MigrationColumn = {
    name: "",
    type: "varchar",
    primary,
    nullable,
    autoIncrement,
    default: defaultValue,
  };

  // Special no-arg methods that expand to known columns.
  if (baseMethod === "timestamps" || baseMethod === "timestampsTz") {
    return [
      { name: "created_at", type: "datetime", nullable: true },
      { name: "updated_at", type: "datetime", nullable: true },
    ];
  }
  if (baseMethod === "softDeletes" || baseMethod === "softDeletesTz") {
    const col = stringValue(baseArgs[0]) ?? "deleted_at";
    return [{ name: col, type: "datetime", nullable: true }];
  }
  if (baseMethod === "rememberToken") {
    return [{ name: "remember_token", type: "varchar", nullable: true }];
  }
  if (baseMethod === "userStamps") {
    return [
      { name: "created_by", type: "bigint", nullable: true },
      { name: "updated_by", type: "bigint", nullable: true },
    ];
  }

  // Polymorphic relation helpers expand to two columns.
  if (MORPH_METHODS.has(baseMethod)) {
    const morphName = stringValue(baseArgs[0]);
    if (!morphName) return [];
    const idType = baseMethod.startsWith("uuid") ? "uuid" : baseMethod.startsWith("ulid") ? "ulid" : "bigint";
    const morphNullable = baseMethod.startsWith("nullable");
    return [
      { name: `${morphName}_id`, type: idType, nullable: morphNullable },
      { name: `${morphName}_type`, type: "varchar", nullable: morphNullable },
    ];
  }

  // Explicit foreign-id helpers (single column).
  if (baseMethod === "foreignId" || baseMethod === "foreignUlid" || baseMethod === "foreignUuid") {
    const name = stringValue(baseArgs[0]);
    if (!name) return [];
    const type = baseMethod === "foreignUuid" ? "uuid" : baseMethod === "foreignUlid" ? "ulid" : "bigint";
    return [{ ...base, name, type }];
  }

  // `id()` with no arg defaults to "id" (Laravel 9+).
  if (baseMethod === "id") {
    const name = stringValue(baseArgs[0]) ?? "id";
    return [{ ...base, name, type: "bigint", primary: true, autoIncrement: true }];
  }

  // Generic column methods: first arg is the column name.
  const type = COLUMN_TYPES[baseMethod];
  if (!type) return [];
  const name = stringValue(baseArgs[0]);
  if (!name) return [];
  return [{ ...base, name, type }];
}

/** Recognize drop-family methods and translate them to a drop mutation. */
function dropMutation(method: string, args: unknown[]): TableMutation | null {
  if (method === "dropColumn") {
    const first = args[0];
    if (first && typeof first === "object" && (first as { kind?: string }).kind === "array") {
      const names = stringArrayValues(first);
      return { kind: "dropMany", names };
    }
    const name = stringValue(first);
    return name ? { kind: "drop", names: [name] } : null;
  }
  if (method === "dropTimestamps" || method === "dropTimestampsTz") {
    return { kind: "dropMany", names: ["created_at", "updated_at"] };
  }
  if (method === "dropSoftDeletes" || method === "dropSoftDeletesTz") {
    const col = stringValue(args[0]) ?? "deleted_at";
    return { kind: "drop", names: [col] };
  }
  if (method === "dropRememberToken") {
    return { kind: "drop", names: ["remember_token"] };
  }
  if (method === "dropMorphs") {
    const morphName = stringValue(args[0]);
    if (!morphName) return null;
    return { kind: "dropMany", names: [`${morphName}_id`, `${morphName}_type`] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Closure / AST shape helpers
// ---------------------------------------------------------------------------

function closureParamName(closureNode: unknown): string | null {
  if (!closureNode || typeof closureNode !== "object") return null;
  const args = (closureNode as { arguments?: unknown[] }).arguments;
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0] as { name?: unknown };
  const name = nameOfNode(first?.name);
  return name ? name.replace(/^\$/, "") : null;
}

function closureBodyChildren(closureNode: unknown): unknown[] {
  if (!closureNode || typeof closureNode !== "object") return [];
  const body = (closureNode as { body?: unknown }).body;
  if (!body || typeof body !== "object") return [];
  const children = (body as { children?: unknown[] }).children;
  return Array.isArray(children) ? children : [];
}

function expressionOf(stmt: unknown): unknown {
  if (!stmt || typeof stmt !== "object") return stmt;
  const kind = (stmt as { kind?: string }).kind;
  if (kind === "expressionstatement" || kind === "expression") {
    return (stmt as { expression?: unknown }).expression ?? stmt;
  }
  return stmt;
}

function nameOfNode(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string | { name?: string } };
    if (typeof n.name === "string") return n.name;
    if (n.name && typeof n.name === "object" && typeof (n.name as { name?: string }).name === "string") {
      return (n.name as { name?: string }).name ?? "";
    }
  }
  return "";
}

function stringArrayValues(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const items = (node as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const item = it as { value?: unknown };
    const val = item?.value ?? it;
    const s = stringValue(val);
    if (s) out.push(s);
  }
  return out;
}

function expressionToDefault(node: unknown): string | undefined {
  const s = stringValue(node);
  if (s !== null) return s;
  if (node && typeof node === "object") {
    const kind = (node as { kind?: string }).kind;
    if (kind === "constref" || kind === "identifier" || kind === "name") {
      return nameOfNode(node);
    }
    if (kind === "boolean") {
      const v = (node as { value?: unknown }).value;
      return typeof v === "boolean" ? String(v) : undefined;
    }
    if (kind === "number") {
      const v = (node as { value?: unknown }).value;
      return typeof v === "number" ? String(v) : typeof v === "string" ? v : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Laravel table-name convention: Str::snake(Str::pluralStudly(Class))
// ---------------------------------------------------------------------------

const IRREGULAR_PLURALS: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  mouse: "mice",
  goose: "geese",
  tooth: "teeth",
  foot: "feet",
  ox: "oxen",
  cactus: "cacti",
  nucleus: "nuclei",
  syllabus: "syllabi",
  fungus: "fungi",
  criterion: "criteria",
  phenomenon: "phenomena",
  datum: "data",
  medium: "media",
  analysis: "analyses",
  basis: "bases",
  crisis: "crises",
  diagnosis: "diagnoses",
  hypothesis: "hypotheses",
  oasis: "oases",
  parenthesis: "parentheses",
  prognosis: "prognoses",
  synopsis: "synopses",
  thesis: "theses",
};

const UNCOUNTABLE = new Set([
  "sheep",
  "deer",
  "fish",
  "series",
  "species",
  "news",
  "information",
  "equipment",
  "rice",
  "money",
  "jeans",
  "moose",
]);

/** Pluralize an English word using Laravel's Str::plural heuristic. */
export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return lower;
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower]!;
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  if (/[a-z]o$/i.test(word) && !/(ao|eo|io|oo|uo)$/i.test(word)) return word + "es";
  return word + "s";
}

/** Convert a StudlyCaps class name to snake_case. */
export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Resolve a model class short name to its default Eloquent table name:
 * `Str::snake(Str::pluralStudly(Class))`. Pluralizes only the last segment of
 * the snake-cased name, matching Laravel's behavior for multi-word models.
 */
export function laravelTableName(className: string): string {
  const snake = snakeCase(className);
  const parts = snake.split("_");
  if (parts.length === 0) return snake;
  const last = parts.pop()!;
  parts.push(pluralize(last));
  return parts.join("_");
}
