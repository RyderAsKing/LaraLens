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
      className="group relative rounded-md border bg-card px-3 py-2 shadow-sm transition-shadow"
      style={{
        borderColor: selected ? accent : withAlpha(accent, 0.25),
        boxShadow: selected ? `0 0 0 1.5px ${accent}` : undefined,
        width: 200,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {typeLabel}
        </span>
      </div>
      <div className="mt-1 truncate text-sm font-medium text-foreground">
        {d.label}
      </div>
      {d.subtitle ? (
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {d.subtitle}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0"
        style={{ background: accent }}
      />
    </div>
  );
}

export const NodeCard = memo(NodeCardComponent);
