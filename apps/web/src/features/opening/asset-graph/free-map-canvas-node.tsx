"use client";

import type { KeyboardEvent } from "react";
import type { AssetGraphDetail, AssetGraphNode } from "@aistudy/contracts";
import {
  ASSISTANCE_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  NODE_KIND_LABELS,
  REQUIREMENT_STATUS_LABELS,
  resolveEffectiveNodeStates,
} from "./asset-graph-model";
import type { FreeMapLayout } from "./free-map-canvas-layout";

export const FREE_MAP_COLORS = [
  {
    stroke: "stroke-obj-1",
    fill: "fill-text",
    face: "fill-surface",
    dot: "fill-obj-1",
  },
  {
    stroke: "stroke-obj-3",
    fill: "fill-text",
    face: "fill-surface",
    dot: "fill-obj-3",
  },
  {
    stroke: "stroke-obj-4",
    fill: "fill-text",
    face: "fill-surface",
    dot: "fill-obj-4",
  },
];

const evidenceColor = {
  stroke: "stroke-obj-2",
  fill: "fill-text",
  face: "fill-surface-2",
  dot: "fill-obj-2",
};

export function freeMapNodeColor(node: AssetGraphNode, branch: number) {
  return node.kind === "observation" || node.kind === "source"
    ? evidenceColor
    : FREE_MAP_COLORS[branch % 3]!;
}

export function freeMapCaption(
  node: AssetGraphNode,
  mode: "exam" | "study",
  detail?: AssetGraphDetail | null,
): string {
  const effective = resolveEffectiveNodeStates(node, detail ?? null);
  if (mode === "exam") {
    const statuses = [
      effective.requirementStatus ? REQUIREMENT_STATUS_LABELS[effective.requirementStatus] : null,
      effective.learnerState ? LEARNER_STATE_LABELS[effective.learnerState] : null,
    ].filter(Boolean);
    if (statuses.length) return statuses.join(" · ");
    if (node.meta?.assistance) return ASSISTANCE_LABELS[node.meta.assistance];
  }
  if (node.meta?.knowledgeStatus) return KNOWLEDGE_STATUS_LABELS[node.meta.knowledgeStatus];
  if (node.meta?.version !== undefined) {
    return `第 ${node.meta.version} 版 · ${NODE_KIND_LABELS[node.kind]}`;
  }
  return NODE_KIND_LABELS[node.kind];
}

function labelLines(label: string) {
  const chars = Array.from(label);
  return chars.length <= 12
    ? [label]
    : [
        chars.slice(0, 12).join(""),
        `${chars.slice(12, 23).join("")}${chars.length > 23 ? "…" : ""}`,
      ];
}

export function FreeMapCanvasNode({
  node,
  layout,
  selected,
  selectedDetail,
  folded,
  hasChildren,
  mode,
  dimmed = false,
  onSelect,
  onToggle,
  onMove,
}: {
  node: AssetGraphNode;
  layout: FreeMapLayout;
  selected: boolean;
  selectedDetail?: AssetGraphDetail | null;
  folded: boolean;
  hasChildren: boolean;
  mode: "exam" | "study";
  dimmed?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMove: (key: string, alt: boolean, shift: boolean) => void;
}) {
  const point = layout.positions[node.id]!;
  const root = layout.parents[node.id] === null;
  const leaf = (layout.depths[node.id] ?? 0) > 1 && !hasChildren;
  const color = freeMapNodeColor(node, layout.branches[node.id] ?? 0);
  const lines = labelLines(node.label);
  const caption = freeMapCaption(node, mode, selected ? selectedDetail : null);

  function keyboard(event: KeyboardEvent<SVGGElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      onMove(event.key, event.altKey, event.shiftKey);
    }
  }

  return (
    <g data-free-map-focus-node={node.id} className={dimmed ? "opacity-45" : undefined}>
      <g
        transform={`translate(${point.x} ${point.y})`}
        data-free-map-node={node.id}
        data-graph-node={node.id}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${NODE_KIND_LABELS[node.kind]}：${node.label}，${caption}`}
        className="group cursor-grab outline-none active:cursor-grabbing"
        onKeyDown={keyboard}
        onClick={event => {
          if (event.detail === 0) onSelect();
        }}
      >
        <title>{`${node.label} · ${caption}。方向键移动分支，Alt 加方向键只移当前节点。`}</title>
        <rect
          x={-112}
          y={-48}
          width={224}
          height={96}
          rx={root ? 18 : 14}
          fill="none"
          strokeWidth={2}
          className={`${selected ? "stroke-accent opacity-100" : `${color.stroke} opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100`}`}
        />
        <rect
          x={-108}
          y={-44}
          width={216}
          height={88}
          rx={root ? 15 : 11}
          strokeWidth={root ? 2 : 1.25}
          className={
            root
              ? "fill-surface-2 stroke-accent"
              : leaf
                ? "fill-bg stroke-line"
                : `${color.face} stroke-line-strong`
          }
        />
        {!root && !leaf ? <circle cx={-95} cy={-31} r={3.5} className={color.dot} /> : null}
        {root ? <circle cx={-95} cy={-31} r={4} className="fill-accent" /> : null}
        {leaf ? <path d="M -94 39 H 94" strokeWidth={1.5} className={color.stroke} /> : null}
        <text
          textAnchor="middle"
          className={root ? "fill-text text-[18px] font-semibold" : `${color.fill} text-[15px] font-semibold`}
        >
          {lines.map((line, index) => (
            <tspan key={index} x={0} y={lines.length > 1 ? -10 + index * 22 : 1}>
              {line}
            </tspan>
          ))}
        </text>
        <text
          x={0}
          y={31}
          textAnchor="middle"
          className={root ? "fill-accent text-[11px] font-medium" : "fill-text-2 text-[11px]"}
        >
          {caption}
        </text>
      </g>
      {hasChildren ? (
        <g
          data-map-control="fold"
          role="button"
          tabIndex={0}
          aria-expanded={!folded}
          aria-label={`${folded ? "展开" : "收起"}${node.label}分支`}
          transform={`translate(${point.x + 108} ${point.y + 32})`}
          className={`group cursor-pointer outline-none ${color.stroke}`}
          onClick={event => {
            event.stopPropagation();
            onToggle();
          }}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onToggle();
            }
          }}
        >
          <circle r={20} className="fill-transparent stroke-transparent group-focus-visible:stroke-accent" />
          <circle r={11} className="fill-surface" strokeWidth={1.5} />
          <path d={folded ? "M -4 0 H 4 M 0 -4 V 4" : "M -4 0 H 4"} fill="none" strokeWidth={1.5} />
        </g>
      ) : null}
    </g>
  );
}
