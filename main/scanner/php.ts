/**
 * PHP AST parsing helpers built on glayzzle/php-parser.
 * Provides a small, defensive API over the AST so analyzers do not need to
 * know the exact node shapes of the underlying parser.
 */
import path from "node:path";
import { Engine } from "php-parser";

export interface PhpAst {
  root: unknown;
  source: string;
  filename: string;
}

export interface PhpClass {
  name: string;
  fqcn: string;
  isAbstract: boolean;
  isInterface: boolean;
  isTrait: boolean;
  isEnum: boolean;
  extends?: string;
  implements: string[];
  traits: string[];
  methods: PhpMethod[];
  properties: PhpProperty[];
  constants: { name: string; value?: unknown }[];
  node: unknown;
}

export interface PhpMethod {
  name: string;
  visibility: string;
  isStatic: boolean;
  isFinal: boolean;
  isAbstract: boolean;
  parameters: { name: string; type?: string; nullable?: boolean }[];
  returnType?: string;
  body?: unknown;
  node: unknown;
  loc?: { start: { line: number }; end: { line: number } };
}

export interface PhpProperty {
  name: string;
  visibility: string;
  isStatic: boolean;
  value?: unknown;
  node: unknown;
}

const engine = new Engine({
  parser: {
    extractDoc: true,
    locations: true,
    suppressErrors: true,
  },
  ast: {
    withPositions: true,
    withSource: true,
  },
});

/** Parse PHP source into an AST. Returns null-safe result on parse errors. */
export function parsePhp(source: string, filename: string): PhpAst | null {
  try {
    const root = engine.parseCode(source, filename);
    return { root, source, filename };
  } catch {
    return null;
  }
}

/** Recursively find the namespace node's name. */
function getNamespaceName(root: unknown): string {
  const children = (root as { children?: unknown[] })?.children;
  if (!Array.isArray(children)) return "";
  for (const child of children) {
    const kind = (child as { kind?: string })?.kind;
    if (kind === "namespace") {
      const nameNode = (child as { name?: unknown }).name;
      // name can be a string or an identifier node
      if (typeof nameNode === "string") return nameNode;
      if (nameNode && typeof nameNode === "object") {
        return (nameNode as { name?: string }).name ?? resolveName(nameNode);
      }
      return resolveName(nameNode);
    }
  }
  return "";
}

function resolveName(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string; kind?: string; resolution?: string };
    if (typeof n.name === "string") return n.name;
  }
  return "";
}

/**
 * Extract a name from a node that may be a string, an Identifier, or a Name.
 * Handles glayzzle's `{ kind: 'identifier', name: 'Foo' }` and `{ kind: 'name', name: 'Foo' }`
 * as well as plain strings.
 */
function nameOf(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string };
    if (typeof n.name === "string") return n.name;
  }
  return "";
}

/** Extract the use/import map: alias (short name) => fully-qualified FQCN. */
export function extractUseMap(ast: PhpAst): Map<string, string> {
  const map = new Map<string, string>();
  const children = (ast.root as { children?: unknown[] })?.children;
  if (!Array.isArray(children)) return map;

  const visit = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const kind = (node as { kind?: string }).kind;
      if (kind === "use" || kind === "usegroup") {
        const items = (node as { items?: unknown[] }).items;
        if (Array.isArray(items)) {
          for (const item of items) {
            const i = item as { name?: unknown; alias?: unknown };
            const fqcn = resolveName(i.name).replace(/^\\/, "");
            if (!fqcn) continue;
            const aliasNode = i.alias;
            const alias =
              typeof aliasNode === "string"
                ? aliasNode
                : resolveName(aliasNode) || fqcn.split("\\").pop() || fqcn;
            map.set(alias, fqcn);
          }
        }
      }
      // also walk into namespace children for grouped/inner uses
      if (kind === "namespace") {
        const inner = (node as { children?: unknown[] }).children;
        if (Array.isArray(inner)) visit(inner);
      }
    }
  };
  visit(children);
  return map;
}

function visibilityOf(node: unknown): string {
  const flags = (node as { flags?: number | string[] })?.flags;
  if (Array.isArray(flags)) {
    if (flags.includes("public")) return "public";
    if (flags.includes("protected")) return "protected";
    if (flags.includes("private")) return "private";
  }
  // glayzzle may use numeric flags; fallback to visibility array if present
  const vis = (node as { visibility?: string[] })?.visibility;
  if (Array.isArray(vis) && vis.length > 0) return vis[0]!;
  return "public";
}

function isFlag(node: unknown, flag: string): boolean {
  const flags = (node as { flags?: number | string[] })?.flags;
  if (Array.isArray(flags)) return flags.includes(flag);
  return false;
}

function typeOf(node: unknown): string | undefined {
  if (!node) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string; kind?: string };
    if (typeof n.name === "string") return n.name;
    // nullable type
    if (n.kind === "nullable" && (node as { what?: unknown }).what) {
      return typeOf((node as { what?: unknown }).what);
    }
    // union/intersection types
    if (n.kind === "union" || n.kind === "intersection") {
      const list = (node as { body?: unknown[] } & { elements?: unknown[] }).elements;
      if (Array.isArray(list)) return list.map(typeOf).filter(Boolean).join("|");
    }
  }
  return undefined;
}

/** Extract all classes/interfaces/traits/enums declared in the AST. */
export function extractClasses(
  ast: PhpAst,
  filename: string
): PhpClass[] {
  const namespace = getNamespaceName(ast.root);
  const out: PhpClass[] = [];

  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const kind = (node as { kind?: string }).kind;
      if (kind === "namespace") {
        const inner = (node as { children?: unknown[] }).children;
        if (Array.isArray(inner)) walk(inner);
        continue;
      }
      if (
        kind === "class" ||
        kind === "interface" ||
        kind === "trait" ||
        kind === "enum"
      ) {
        out.push(buildClass(node, namespace, filename));
      }
    }
  };

  const children = (ast.root as { children?: unknown[] })?.children;
  if (Array.isArray(children)) walk(children);
  return out;
}

function buildClass(node: unknown, namespace: string, filename: string): PhpClass {
  const n = node as {
    name?: string;
    extends?: unknown;
    implements?: unknown[];
    body?: unknown[];
    flags?: number | string[];
    isAbstract?: boolean;
    isFinal?: boolean;
  };
  const name = nameOf(n.name);
  const fqcn = namespace ? `${namespace}\\${name}` : name;

  const traits: string[] = [];
  const methods: PhpMethod[] = [];
  const properties: PhpProperty[] = [];
  const constants: { name: string; value?: unknown }[] = [];

  const body = Array.isArray(n.body) ? n.body : [];
  for (const member of body) {
    const m = member as { kind?: string };
    if (!m || typeof member !== "object") continue;
    if (m.kind === "use") {
      // trait use
      const items = (member as { items?: unknown[] }).items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const t = resolveName((item as { name?: unknown }).name);
          if (t) traits.push(t.replace(/^\\/, ""));
        }
      }
      // trait adaptations can have a body with adaptations
      const adaptations = (member as { adaptations?: unknown[] }).adaptations;
      if (Array.isArray(adaptations)) {
        for (const a of adaptations) {
          const am = a as { kind?: string };
          if (am.kind === "alias" || am.kind === "precedence") {
            const t = resolveName((a as { origin?: unknown }).origin);
            if (t) traits.push(t.replace(/^\\/, ""));
          }
        }
      }
    } else if (m.kind === "method") {
      methods.push(buildMethod(member, fqcn));
    } else if (m.kind === "property") {
      properties.push(buildProperty(member));
    } else if (m.kind === "classconstant") {
      const cn = member as { name?: string; value?: unknown };
      constants.push({ name: String(cn.name ?? ""), value: cn.value });
    }
  }

  const extendsName = n.extends ? resolveName(n.extends).replace(/^\\/, "") : undefined;
  const implementsList = Array.isArray(n.implements)
    ? n.implements.map((i) => resolveName(i).replace(/^\\/, "")).filter(Boolean)
    : [];

  return {
    name,
    fqcn,
    isAbstract: isFlag(node, "abstract") || !!n.isAbstract,
    isInterface: (node as { kind?: string }).kind === "interface",
    isTrait: (node as { kind?: string }).kind === "trait",
    isEnum: (node as { kind?: string }).kind === "enum",
    extends: extendsName,
    implements: implementsList,
    traits,
    methods,
    properties,
    constants,
    node,
  };
}

function buildMethod(node: unknown, declaringFqcn: string): PhpMethod {
  const m = node as {
    name?: string | { name?: string };
    visibility?: string[];
    flags?: number | string[];
    byref?: boolean;
    arguments?: unknown[];
    nullable?: boolean;
    type?: unknown;
    body?: unknown;
    loc?: { start: { line: number }; end: { line: number } };
  };
  const name = nameOf(m.name);
  const parameters = Array.isArray(m.arguments)
    ? m.arguments.map((p) => {
        const param = p as { name?: unknown; type?: unknown; nullable?: boolean };
        return {
          name: nameOf(param.name).replace(/^\$/, ""),
          type: typeOf(param.type),
          nullable: param.nullable,
        };
      })
    : [];
  return {
    name,
    visibility: visibilityOf(node),
    isStatic: isFlag(node, "static"),
    isFinal: isFlag(node, "final"),
    isAbstract: isFlag(node, "abstract"),
    parameters,
    returnType: typeOf(m.type),
    body: m.body,
    node,
    loc: m.loc,
  };
}

function buildProperty(node: unknown): PhpProperty {
  const p = node as {
    name?: string | { name?: string };
    visibility?: string[];
    flags?: number | string[];
    value?: unknown;
  };
  const name = nameOf(p.name);
  return {
    name: name.replace(/^\$/, ""),
    visibility: visibilityOf(node),
    isStatic: isFlag(node, "static"),
    value: p.value,
    node,
  };
}

/** Resolve a short class reference to an FQCN using a use map + current namespace. */
export function resolveClassRef(
  ref: string,
  useMap: Map<string, string>,
  namespace: string
): string {
  if (!ref) return "";
  const clean = ref.replace(/^\\/, "");
  if (clean.startsWith("\\")) return clean.replace(/^\\/, "");
  // leading backslash = fully qualified
  if (ref.startsWith("\\")) return clean;
  const head = clean.split("\\")[0]!;
  if (useMap.has(head)) {
    const fqcn = useMap.get(head)!;
    return clean.includes("\\") ? fqcn + clean.slice(head.length) : fqcn;
  }
  // unqualified in current namespace
  return namespace ? `${namespace}\\${clean}` : clean;
}

/** Walk every descendant node of `node`, invoking `fn`. */
export function walkAst(node: unknown, fn: (n: unknown) => void): void {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (key === "loc" || key === "source" || key === "kind") continue;
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) walkAst(c, fn);
    } else if (child && typeof child === "object") {
      walkAst(child, fn);
    }
  }
}

/** Get the textual name of a call target (identifier or property lookup). */
export function callName(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const n = node as { name?: string; kind?: string; offset?: unknown; what?: unknown };
    if (typeof n.name === "string") return n.name;
    if (n.kind === "identifier") return n.name ?? "";
    if (n.offset) return callName(n.offset);
    if (n.what) return callName(n.what);
  }
  return "";
}

/** Extract a string literal value from a PHP AST `string` node. Returns null otherwise. */
export function stringValue(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") {
    const n = node as { kind?: string; value?: unknown };
    if (n.kind === "string") {
      const v = n.value;
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// glayzzle/php-parser v3 call helpers
// In this parser, ALL calls are `kind: 'call'`. The receiver type is
// determined by `call.what`:
//   - `staticlookup`  → Class::method()
//   - `propertylookup` → $obj->method()
//   - `name`          → function()
// ---------------------------------------------------------------------------

/** Is this node a call (any kind: function, method, or static)? */
export function isCall(node: unknown): boolean {
  return (node as { kind?: string })?.kind === "call";
}

/** Get the call kind: 'static' | 'method' | 'function' | null */
export function callKind(node: unknown): "static" | "method" | "function" | null {
  if (!isCall(node)) return null;
  const what = (node as { what?: unknown }).what;
  const whatKind = (what as { kind?: string })?.kind;
  if (whatKind === "staticlookup") return "static";
  if (whatKind === "propertylookup") return "method";
  if (whatKind === "name" || whatKind === "identifier") return "function";
  return null;
}

/** Get the receiver name of a call. For static calls, returns the class name.
 *  For function calls, returns the function name. For method calls, returns
 *  a best-effort base receiver identifier (e.g. "$this", "$dep", or a class name). */
export function callReceiver(node: unknown): string {
  if (!isCall(node)) return "";
  const what = (node as { what?: unknown }).what;
  const whatKind = (what as { kind?: string })?.kind;
  if (whatKind === "staticlookup") {
    return nameOf((what as { what?: unknown }).what);
  }
  if (whatKind === "name") {
    return nameOf(what);
  }
  if (whatKind === "propertylookup") {
    // Walk down the chain to find the base receiver.
    let base = (what as { what?: unknown }).what;
    // Unwrap intermediate calls in a method chain: $a->b()->c() has base $a.
    while (base && typeof base === "object") {
      const bk = (base as { kind?: string }).kind;
      if (bk === "call") {
        base = (base as { what?: unknown }).what;
        continue;
      }
      if (bk === "propertylookup") {
        base = (base as { what?: unknown }).what;
        continue;
      }
      break;
    }
    if (base && typeof base === "object") {
      const bk = (base as { kind?: string }).kind;
      if (bk === "variable") return "$" + nameOf((base as { name?: unknown }).name);
      if (bk === "name") return nameOf(base);
      if (bk === "staticlookup") return nameOf((base as { what?: unknown }).what);
    }
    return "";
  }
  return "";
}

/** Get the method/function name of a call. */
export function callMethod(node: unknown): string {
  if (!isCall(node)) return "";
  const what = (node as { what?: unknown }).what;
  const whatKind = (what as { kind?: string })?.kind;
  if (whatKind === "staticlookup" || whatKind === "propertylookup") {
    return nameOf((what as { offset?: unknown }).offset);
  }
  if (whatKind === "name") {
    return nameOf(what);
  }
  return "";
}

/** Get the arguments of a call node. */
export function callArgs(node: unknown): unknown[] {
  if (!isCall(node)) return [];
  return (node as { arguments?: unknown[] }).arguments ?? [];
}

/** Extract class name from a `Class::class` staticlookup node. Returns null if not a class const fetch. */
export function classConstName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as { kind?: string; offset?: unknown; what?: unknown };
  if (n.kind === "staticlookup") {
    const offsetName = nameOf(n.offset);
    if (offsetName === "class") {
      return nameOf(n.what);
    }
  }
  return null;
}

/** Extract class name from a `new Class()` node. */
export function newClassName(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ((node as { kind?: string }).kind !== "new") return "";
  return nameOf((node as { what?: unknown }).what);
}

/**
 * Unwrap a named argument (`kind: 'namedargument'`, PHP 8 named args) to its
 * value expression. If the node is not a named argument, returns it unchanged.
 */
export function unwrapNamedArg(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  if ((node as { kind?: string }).kind === "namedargument") {
    return (node as { value?: unknown }).value ?? null;
  }
  return node;
}

/** Get the name of a named argument, or null if the node isn't a named argument. */
export function namedArgName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as { kind?: string; name?: string };
  if (n.kind === "namedargument" && typeof n.name === "string") return n.name;
  return null;
}

/** Check if a node is an include/require statement. */
export function isInclude(node: unknown): boolean {
  const k = (node as { kind?: string })?.kind;
  return k === "include" || k === "require" || k === "includefile" || k === "requirefile";
}

/** Get the target expression of an include/require. */
export function includeTarget(node: unknown): unknown {
  return (node as { target?: unknown })?.target ?? null;
}

/** Resolve an include target to a file path, handling `__DIR__ . '/relative'` patterns. */
export function resolveIncludePath(target: unknown, currentFile: string): string | null {
  if (!target) return null;
  // Direct string literal
  const direct = stringValue(target);
  if (direct) return direct;

  // Binary expression: __DIR__ . '/path'  or  dirname(__FILE__) . '/path'
  const expr = target as { kind?: string; left?: unknown; right?: unknown };
  if (expr.kind === "bin") {
    const left = expr.left;
    const right = expr.right;
    // Check if left is __DIR__ magic constant
    const leftName = nameOf((left as { kind?: string; name?: unknown })?.kind === "magic" ? left : null);
    void leftName;
    const leftIsDir = left && typeof left === "object" && (left as { kind?: string }).kind === "magic" && nameOf((left as { name?: unknown }).name) === "__DIR__";
    if (leftIsDir) {
      const rightStr = stringValue(right);
      if (rightStr) {
        return path.join(path.dirname(currentFile), rightStr.replace(/^\.?\//, ""));
      }
    }
    // Also handle `dirname(__FILE__) . '/path'`
    if (left && typeof left === "object" && (left as { kind?: string }).kind === "call") {
      const fnName = callMethod(left);
      if (fnName === "dirname") {
        const rightStr = stringValue(right);
        if (rightStr) {
          return path.join(path.dirname(currentFile), rightStr.replace(/^\.?\//, ""));
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assignment helpers — for tracking `$var = new Class()` or `$var = Class::method()`
// ---------------------------------------------------------------------------

/** Is this node an assignment (`$var = expr`)? */
export function isAssign(node: unknown): boolean {
  return (node as { kind?: string })?.kind === "assign";
}

/** Get the variable name from an assignment's left side. Returns "" if not a variable. */
export function assignTarget(node: unknown): string {
  if (!isAssign(node)) return "";
  const left = (node as { left?: unknown }).left;
  if (!left || typeof left !== "object") return "";
  if ((left as { kind?: string }).kind === "variable") {
    return "$" + nameOf((left as { name?: unknown }).name);
  }
  return "";
}

/** Get the right-hand expression of an assignment. */
export function assignValue(node: unknown): unknown {
  if (!isAssign(node)) return null;
  return (node as { right?: unknown }).right ?? null;
}
