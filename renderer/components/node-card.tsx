"use client";

import { memo } from "react";
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
  const accent = d.accent ?? ACCENT_COLORS[d.nodeType] ?? "#94a3b8";
  const typeLabel = TYPE_LABELS[d.nodeType] ?? d.nodeType;

  return (
    <div
      className="group relative rounded-lg border bg-card px-4 py-3 shadow-md transition-shadow"
      style={{
        borderColor: selected ? accent : withAlpha(accent, 0.25),
        boxShadow: selected ? `0 0 0 1.5px ${accent}` : undefined,
        width: 260,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !border-0"
        style={{ background: accent }}
      />
      <div className="flex items-center gap-2.5">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {typeLabel}
        </span>
      </div>
      <div className="mt-2 truncate text-base font-semibold text-foreground">
        {d.label}
      </div>
      {d.subtitle ? (
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {d.subtitle}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !border-0"
        style={{ background: accent }}
      />
    </div>
  );
}

export const NodeCard = memo(NodeCardComponent);
