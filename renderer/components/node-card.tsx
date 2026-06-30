"use client";

import { memo, type MouseEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ACCENT_COLORS, TYPE_LABELS, withAlpha } from "@/lib/graph";
import type { NodeType } from "@/lib/types";

export interface LaraLensNodeData {
  label: string;
  nodeType: NodeType;
  subtitle?: string;
  accent?: string;
  [key: string]: unknown;
}

function NodeCardComponent({ data, selected }: NodeProps) {
  const d = data as unknown as LaraLensNodeData;
  const accent = d.accent ?? ACCENT_COLORS[d.nodeType] ?? "#7A7E85";
  const typeLabel = TYPE_LABELS[d.nodeType] ?? d.nodeType;
  const extendsText = typeof d.extends === "string" ? d.extends : "";
  const extendsTargetId = typeof d.extendsTargetId === "string" ? d.extendsTargetId : "";

  const selectExtendsTarget = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!extendsTargetId) return;
    window.dispatchEvent(new CustomEvent("laralens:select-node", { detail: extendsTargetId }));
  };

  return (
    <div
      className="group relative rounded-lg border bg-[var(--optic)] px-4 py-3 shadow-md transition-shadow"
      style={{
        borderColor: selected ? accent : withAlpha(accent, 0.2),
        boxShadow: selected ? `0 0 0 1.5px ${accent}, 0 0 12px ${withAlpha(accent, 0.25)}` : undefined,
        width: 260,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />
      <div className="flex items-center gap-2.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent, boxShadow: `0 0 5px ${withAlpha(accent, 0.5)}` }}
        />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--etch)]">
          {typeLabel}
        </span>
        {extendsText ? (
          <button
            type="button"
            onClick={selectExtendsTarget}
            title={`Extends ${extendsText}${extendsTargetId ? " — click to inspect" : ""}`}
            className="ml-auto rounded border border-[var(--chassis)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--etch)] transition-colors hover:border-[var(--accent)] hover:text-[var(--flare)]"
          >
            extends
          </button>
        ) : null}
      </div>
      <div className="mt-2 truncate font-[family-name:var(--font-display)] text-[15px] font-medium tracking-[-0.01em] text-[var(--flare)]">
        {d.label}
      </div>
      {d.subtitle ? (
        <div className="mt-1 truncate font-mono text-[11px] text-[var(--etch)]">
          {d.subtitle}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />
    </div>
  );
}

export const NodeCard = memo(NodeCardComponent);
