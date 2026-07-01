"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Key } from "lucide-react";
import { ACCENT_COLORS, withAlpha } from "@/lib/graph";
import type { GraphNode, MigrationColumn, NodeType } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * ER-style node card for the Models view. Renders the model class as an entity
 * header with its table name, followed by one row per attribute: the primary
 * key (marked with a key icon), every fillable column (annotated with its cast
 * type when known), and the timestamp / soft-delete columns Laravel manages.
 *
 * The scanner already places `fillable`, `casts`, `primaryKey`, `table`,
 * `usesSoftDeletes`, and `timestamps` on each model node's data (see
 * `main/scanner/graph-builder.ts` `addModels()`). Placeholder nodes — related
 * classes the scanner could not resolve to a file — only carry `fqcn` and get a
 * compact "unresolved reference" body.
 *
 * Rendered heights are deterministic so the tree layout can reserve the right
 * amount of vertical space (see `modelNodeHeight`).
 */

export const MODEL_CARD_WIDTH = 244;
export const MODEL_HEADER_H = 40;
export const MODEL_ROW_H = 22;
export const MODEL_FOOTER_H = 8;

export type ModelAttributeKind = "pk" | "fillable" | "column" | "timestamp" | "softdelete" | "note";

export interface ModelAttributeRow {
  name: string;
  type?: string;
  kind: ModelAttributeKind;
  nullable?: boolean;
}

/**
 * The attribute rows to render for a model node's data. Pure function shared by
 * the card (to render) and `modelNodeHeight` (to size the layout slot), so the
 * reserved height always matches the painted height.
 *
 * Prefers migration columns (the real table schema) when present. Falls back to
 * the model's `$fillable` + `$casts` when no migration was found — and to a
 * compact "unresolved reference" body for placeholder nodes (related classes
 * the scanner couldn't resolve to a file).
 */
export function modelAttributeRows(data: Record<string, unknown>): ModelAttributeRow[] {
  // Migration columns — authoritative schema from database/migrations.
  const rawColumns = data.columns;
  if (Array.isArray(rawColumns) && rawColumns.length > 0) {
    return (rawColumns as unknown[]).map((c): ModelAttributeRow => {
      const col = c as MigrationColumn;
      return {
        name: col.name,
        type: col.type,
        kind: col.primary ? "pk" : "column",
        nullable: col.nullable === true ? true : undefined,
      };
    });
  }

  const fillable = Array.isArray(data.fillable)
    ? (data.fillable as unknown[]).filter((v): v is string => typeof v === "string")
    : null;

  // Placeholder node (unresolved related class) — no fillable metadata.
  if (fillable === null) {
    return [{ name: "unresolved reference", kind: "note" }];
  }

  const casts =
    data.casts && typeof data.casts === "object" && !Array.isArray(data.casts)
      ? (data.casts as Record<string, string>)
      : {};
  const castType = (column: string): string | undefined => {
    const value = casts[column];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const rows: ModelAttributeRow[] = [];
  const pk = typeof data.primaryKey === "string" && data.primaryKey.length > 0 ? data.primaryKey : "id";
  rows.push({ name: pk, type: castType(pk), kind: "pk" });

  for (const column of fillable) {
    if (column === pk) continue; // already listed as the primary key
    rows.push({ name: column, type: castType(column), kind: "fillable" });
  }

  if (data.timestamps !== false) {
    rows.push({ name: "created_at", type: castType("created_at") ?? "datetime", kind: "timestamp" });
    rows.push({ name: "updated_at", type: castType("updated_at") ?? "datetime", kind: "timestamp" });
  }

  if (data.usesSoftDeletes === true) {
    rows.push({ name: "deleted_at", type: castType("deleted_at") ?? "datetime", kind: "softdelete" });
  }

  return rows;
}

/** Painted height of a model node — must match the card's rendered DOM height. */
export function modelNodeHeight(node: GraphNode): number {
  const rows = modelAttributeRows(node.data);
  return MODEL_HEADER_H + rows.length * MODEL_ROW_H + MODEL_FOOTER_H;
}

interface ModelNodeData {
  label: string;
  nodeType: NodeType;
  fqcn?: string;
  table?: string | null;
  fillable?: unknown;
  casts?: unknown;
  primaryKey?: unknown;
  timestamps?: unknown;
  usesSoftDeletes?: unknown;
  file?: unknown;
  accent?: string;
  [key: string]: unknown;
}

function ModelNodeCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ModelNodeData;
  const accent = d.accent ?? ACCENT_COLORS.model ?? "#B85C5C";
  const rows = modelAttributeRows(data as Record<string, unknown>);
  const table = typeof d.table === "string" && d.table.length > 0 ? d.table : null;

  return (
    <div
      className="relative rounded-lg border bg-[var(--optic)] shadow-md"
      style={{
        width: MODEL_CARD_WIDTH,
        borderColor: selected ? accent : withAlpha(accent, 0.25),
        boxShadow: selected
          ? `0 0 0 1.5px ${accent}, 0 0 12px ${withAlpha(accent, 0.25)}`
          : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />

      {/* Header — entity name + table badge */}
      <div
        className="flex items-center gap-2 rounded-t-lg px-3"
        style={{
          height: MODEL_HEADER_H,
          background: withAlpha(accent, 0.16),
          borderBottom: `1px solid ${withAlpha(accent, 0.28)}`,
        }}
        title={typeof d.fqcn === "string" ? d.fqcn : undefined}
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent, boxShadow: `0 0 5px ${withAlpha(accent, 0.5)}` }}
        />
        <span className="truncate font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-[-0.01em] text-[var(--flare)]">
          {d.label}
        </span>
        {table ? (
          <span
            className="ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] text-[var(--etch)]"
            style={{ borderColor: withAlpha(accent, 0.3) }}
          >
            {table}
          </span>
        ) : null}
      </div>

      {/* Attribute rows */}
      <div>
        {rows.map((row, index) => {
          const isLast = index === rows.length - 1;
          return (
            <div
              key={`${row.kind}:${row.name}:${index}`}
              className="flex items-center gap-2 px-3"
              style={{
                height: MODEL_ROW_H,
                borderBottom: isLast ? undefined : `1px solid ${withAlpha(accent, 0.08)}`,
              }}
            >
              {row.kind === "pk" ? (
                <Key
                  className="h-3 w-3 shrink-0"
                  style={{ color: accent }}
                  aria-label="primary key"
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span
                className={cn(
                  "truncate font-mono text-[11px]",
                  row.kind === "pk" && "font-semibold text-[var(--flare)]",
                  row.kind === "note" && "italic text-[var(--etch)]",
                  (row.kind === "column" ||
                    row.kind === "fillable" ||
                    row.kind === "timestamp" ||
                    row.kind === "softdelete") &&
                    "text-[var(--flare)]/90",
                  row.nullable && "text-[var(--flare)]/70"
                )}
              >
                {row.name}
              </span>
              {row.nullable ? (
                <span
                  className="shrink-0 font-mono text-[9px] italic text-[var(--etch)]"
                  title="nullable"
                >
                  ?
                </span>
              ) : null}
              {row.type ? (
                <span
                  className={cn(
                    "ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--etch)]",
                    row.kind === "pk" && "not-italic"
                  )}
                >
                  {row.type}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Bottom padding so the last row's divider breathes inside the border */}
      <div style={{ height: MODEL_FOOTER_H }} />
    </div>
  );
}

export const ModelNodeCard = memo(ModelNodeCardComponent);
