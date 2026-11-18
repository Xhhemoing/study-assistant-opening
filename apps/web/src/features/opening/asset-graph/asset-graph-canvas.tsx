"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  Compass,
  Expand,
  FileSearch,
  GitBranch,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type {
  AssetGraphContext,
  AssetGraphEdge,
  AssetGraphNode,
  AssetGraphNodeId,
  AssetGraphNodeKind,
} from "@aistudy/contracts";
import { ui, tone } from "../design/ui";
import {
  ASSISTANCE_LABELS,
  EDGE_BASIS_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  NODE_KIND_LABELS,
  RELATION_LABELS,
  REQUIREMENT_STATUS_LABELS,
  type AssetGraphDirection,
  type ExpandedCenterState,
} from "./asset-graph-model";

export type ZoomLevel = 0.75 | 1 | 1.25;

const ZOOM_OPTIONS: readonly { value: ZoomLevel; label: string }[] = [
  { value: 0.75, label: "75%" },
  { value: 1, label: "100%" },
  { value: 1.25, label: "125%" },
];

const NODE_W = 224;
const NODE_H = 88;
const COL_GAP = 132;
const ROW_GAP = 26;
const PAD_X = 32;
const PAD_Y = 28;

const KIND_BASE_RANK: Record<AssetGraphNodeKind, number> = {
  course: 0,
  goal: 0,
  exploration: 0,
  requirement: 1,
  document: 1,
  knowledge: 2,
  source: 3,
  observation: 3,
};

const KIND_ACCENT_BAR: Record<AssetGraphNodeKind, string> = {
  course: "fill-obj-1",
  goal: "fill-obj-3",
  requirement: "fill-obj-2",
  knowledge: "fill-obj-4",
  source: "fill-obj-1",
  document: "fill-obj-3",
  exploration: "fill-obj-4",
  observation: "fill-obj-2",
};

const KIND_BADGE_TONE: Record<AssetGraphNodeKind, string> = {
  course: "bg-surface-2 text-obj-1",
  goal: "bg-accent-soft text-accent",
  requirement: "bg-warn-soft text-warn",
  knowledge: "bg-surface-2 text-obj-4",
  source: "bg-surface-2 text-obj-1",
  document: "bg-accent-soft text-accent",
  exploration: "bg-surface-2 text-obj-4",
  observation: "bg-warn-soft text-warn",
};

export type NodePosition = {
  x: number;
  y: number;
  column: number;
};

export type GraphLayout = {
  width: number;
  height: number;
  positions: Record<string, NodePosition>;
};

export function computeLayeredGraphLayout(
  nodes: readonly AssetGraphNode[],
  edges: readonly AssetGraphEdge[],
  rootIds: readonly string[],
): GraphLayout {
  if (nodes.length === 0) {
    return { width: 760, height: 360, positions: {} };
  }

  const rankById = new Map<string, number>();
  for (const node of nodes) {
    rankById.set(node.id, KIND_BASE_RANK[node.kind]);
  }

  // Refine column rank using directed edges while bounding iterations against cycles.
  const maxPasses = Math.min(nodes.length, 6);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (edge.from === edge.to) continue;
      const fromRank = rankById.get(edge.from);
      const toRank = rankById.get(edge.to);
      if (fromRank === undefined || toRank === undefined) continue;
      if (toRank <= fromRank && fromRank < 5) {
        rankById.set(edge.to, fromRank + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const occupiedRanks = [...new Set(rankById.values())].sort((a, b) => a - b);
  const compactIndex = new Map(occupiedRanks.map((rank, index) => [rank, index]));
  const rootOrder = new Map(rootIds.map((id, index) => [id, index]));

  const columns = new Map<number, AssetGraphNode[]>();
  for (const node of nodes) {
    const col = compactIndex.get(rankById.get(node.id) ?? 0) ?? 0;
    const list = columns.get(col) ?? [];
    list.push(node);
    columns.set(col, list);
  }

  let maxRows = 1;
  for (const list of columns.values()) {
    list.sort((a, b) => {
      const ra = rootOrder.get(a.id);
      const rb = rootOrder.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.label.localeCompare(b.label, "zh-CN") || a.id.localeCompare(b.id);
    });
    if (list.length > maxRows) maxRows = list.length;
  }

  const colCount = Math.max(occupiedRanks.length, 1);
  const contentHeight = maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;
  const width = Math.max(760, PAD_X * 2 + colCount * NODE_W + Math.max(0, colCount - 1) * COL_GAP);
  const height = Math.max(360, PAD_Y * 2 + contentHeight);

  const positions: Record<string, NodePosition> = {};
  for (const [col, list] of columns.entries()) {
    const colHeight = list.length * NODE_H + Math.max(0, list.length - 1) * ROW_GAP;
    const offsetY = PAD_Y + (contentHeight - colHeight) / 2;
    const x = PAD_X + col * (NODE_W + COL_GAP);
    for (let row = 0; row < list.length; row += 1) {
      const node = list[row]!;
      positions[node.id] = {
        x,
        y: offsetY + row * (NODE_H + ROW_GAP),
        column: col,
      };
    }
  }

  return { width, height, positions };
}

function edgeGeometry(
  fromPos: NodePosition,
  toPos: NodePosition,
  parallelIndex: number,
  parallelCount: number,
): { d: string; labelX: number; labelY: number } {
  const spread = (parallelIndex - (parallelCount - 1) / 2) * 28;
  const startY = fromPos.y + NODE_H / 2 + spread * 0.25;
  const endY = toPos.y + NODE_H / 2 + spread * 0.25;

  if (fromPos.x < toPos.x) {
    const startX = fromPos.x + NODE_W;
    const endX = toPos.x;
    const dx = Math.max(48, (endX - startX) * 0.48);
    const c1x = startX + dx;
    const c1y = startY + spread * 0.6;
    const c2x = endX - dx;
    const c2y = endY + spread * 0.6;
    return {
      d: `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: 0.125 * startY + 0.375 * c1y + 0.375 * c2y + 0.125 * endY - 8,
    };
  }

  if (fromPos.x === toPos.x && fromPos.y === toPos.y) {
    const x = fromPos.x + NODE_W / 2;
    const y = fromPos.y;
    const loopH = 44 + parallelIndex * 18;
    return {
      d: `M ${x - 24} ${y} C ${x - 24} ${y - loopH}, ${x + 24} ${y - loopH}, ${x + 24} ${y}`,
      labelX: x,
      labelY: y - loopH + 10,
    };
  }

  // Same-column or backward edge: draw clean side/vertical curve.
  const startX = fromPos.x + NODE_W / 2;
  const endX = toPos.x + NODE_W / 2;
  const arcOffset = (fromPos.x === toPos.x ? 78 : 56) + spread;
  const cx = Math.max(startX, endX) + arcOffset;
  const cy = (startY + endY) / 2;
  const sy = fromPos.y + (toPos.y >= fromPos.y ? NODE_H : 0);
  const ey = toPos.y + (toPos.y >= fromPos.y ? 0 : NODE_H);
  return {
    d: `M ${startX} ${sy} Q ${cx} ${cy} ${endX} ${ey}`,
    labelX: 0.25 * startX + 0.5 * cx + 0.25 * endX,
    labelY: 0.25 * sy + 0.5 * cy + 0.25 * ey - 6,
  };
}

function truncateSvgLabel(label: string, maxChars = 15): [string, string | null] {
  const chars = Array.from(label);
  if (chars.length <= maxChars) return [label, null];
  const first = chars.slice(0, maxChars).join("");
  const rest = chars.slice(maxChars);
  if (rest.length <= maxChars) return [first, rest.join("")];
  return [first, `${rest.slice(0, maxChars - 1).join("")}…`];
}

function formatMetaTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type AssetGraphCanvasProps = {
  nodes: readonly AssetGraphNode[];
  edges: readonly AssetGraphEdge[];
  rootIds: readonly string[];
  selectedNodeId: string | null;
  context: AssetGraphContext;
  expandedCenters: Record<string, ExpandedCenterState>;
  expandingNodeId: string | null;
  loadingDetailNodeId: string | null;
  onSelectNode: (nodeId: AssetGraphNodeId) => void;
  onExpandNode: (nodeId: AssetGraphNodeId, direction: AssetGraphDirection) => void;
  onLoadMoreNeighbors: (nodeId: AssetGraphNodeId) => void;
  onLoadDetail: (nodeId: AssetGraphNodeId) => void;
  onEnterContext: (context: AssetGraphContext, focusId?: string) => void;
};

export function AssetGraphCanvas({
  nodes,
  edges,
  rootIds,
  selectedNodeId,
  context,
  expandedCenters,
  expandingNodeId,
  loadingDetailNodeId,
  onSelectNode,
  onExpandNode,
  onLoadMoreNeighbors,
  onLoadDetail,
  onEnterContext,
}: AssetGraphCanvasProps) {
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const markerPrefix = useId().replace(/:/g, "");
  const defaultMarkerId = `${markerPrefix}-arrow`;
  const activeMarkerId = `${markerPrefix}-arrow-active`;

  const layout = computeLayeredGraphLayout(nodes, edges, rootIds);
  const viewWidth = Math.round(layout.width / zoom);
  const viewHeight = Math.round(layout.height / zoom);
  const viewX = Math.round(pan.x + (layout.width - viewWidth) / 2);
  const viewY = Math.round(pan.y + (layout.height - viewHeight) / 2);

  // Group parallel edges between the same endpoints so each renders on its own lane.
  const parallelGroups = new Map<string, AssetGraphEdge[]>();
  for (const edge of edges) {
    const key = `${edge.from}=>${edge.to}`;
    const list = parallelGroups.get(key) ?? [];
    list.push(edge);
    parallelGroups.set(key, list);
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if ((event.target as Element | null)?.closest("[data-graph-node]")) return;
    dragOrigin.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!dragOrigin.current) return;
    const dx = (event.clientX - dragOrigin.current.x) / zoom;
    const dy = (event.clientY - dragOrigin.current.y) / zoom;
    setPan({
      x: Math.round(dragOrigin.current.panX - dx),
      y: Math.round(dragOrigin.current.panY - dy),
    });
  }

  function handlePointerEnd() {
    dragOrigin.current = null;
  }

  function handleNodeKeyDown(event: KeyboardEvent<SVGGElement>, nodeId: AssetGraphNodeId) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNode(nodeId);
    }
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-2">
          <div className="flex items-center gap-2 text-meta text-text-2">
            <GitBranch size={14} aria-hidden="true" className="text-accent" />
            <span>
              当前画布：{nodes.length} 个节点 · {edges.length} 条关系
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="画布缩放与视角控制">
            <span className="inline-flex items-center gap-1 text-meta text-text-3">
              <ZoomOut size={13} aria-hidden="true" />
              缩放
              <ZoomIn size={13} aria-hidden="true" />
            </span>
            {ZOOM_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                className={ui.secondary}
                aria-pressed={zoom === option.value}
                onClick={() => setZoom(option.value)}
              >
                {option.label}
              </button>
            ))}
            <button type="button" className={ui.quiet} onClick={resetView}>
              <RotateCcw size={14} aria-hidden="true" />
              重置视角
            </button>
          </div>
        </div>

        <div className="relative overflow-x-auto bg-bg/50">
          <svg
            viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`}
            role="img"
            aria-label={`个人知识资产拓扑画布，共 ${nodes.length} 个节点与 ${edges.length} 条有向关联`}
            className="block h-[420px] w-full min-w-[540px] touch-pan-y select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={handlePointerEnd}
          >
            <defs>
              <marker
                id={defaultMarkerId}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" className="fill-text-3" />
              </marker>
              <marker
                id={activeMarkerId}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" className="fill-accent" />
              </marker>
            </defs>

            <g aria-label="关联边">
              {edges.map(edge => {
                const fromPos = layout.positions[edge.from];
                const toPos = layout.positions[edge.to];
                if (!fromPos || !toPos) return null;
                const group = parallelGroups.get(`${edge.from}=>${edge.to}`) ?? [edge];
                const idx = group.indexOf(edge);
                const geom = edgeGeometry(fromPos, toPos, idx, group.length);
                const touchesSelected =
                  selectedNodeId !== null &&
                  (edge.from === selectedNodeId || edge.to === selectedNodeId);
                const edgeTitle =
                  edge.page !== undefined
                    ? `${RELATION_LABELS[edge.relation]}（第${edge.page}页）`
                    : RELATION_LABELS[edge.relation];

                return (
                  <g key={edge.id} data-edge-id={edge.id}>
                    <path
                      d={geom.d}
                      fill="none"
                      strokeWidth={touchesSelected ? 2.2 : 1.5}
                      strokeDasharray={edge.basis === "suggested" ? "5 4" : undefined}
                      markerEnd={`url(#${touchesSelected ? activeMarkerId : defaultMarkerId})`}
                      className={touchesSelected ? "stroke-accent" : "stroke-line-strong"}
                    />
                    <text
                      x={geom.labelX}
                      y={geom.labelY}
                      textAnchor="middle"
                      className={`text-[11px] font-medium ${touchesSelected ? "fill-accent" : "fill-text-2"}`}
                    >
                      {edgeTitle}
                    </text>
                  </g>
                );
              })}
            </g>

            <g aria-label="资产节点">
              {nodes.map(node => {
                const pos = layout.positions[node.id];
                if (!pos) return null;
                const isSelected = selectedNodeId === node.id;
                const isExpanded = Boolean(expandedCenters[node.id]);
                const [line1, line2] = truncateSvgLabel(node.label);
                const statusText = node.summary?.requirementStatus
                  ? REQUIREMENT_STATUS_LABELS[node.summary.requirementStatus]
                  : node.summary?.learnerState
                    ? LEARNER_STATE_LABELS[node.summary.learnerState]
                    : isExpanded
                      ? "已展开邻接"
                      : null;

                return (
                  <g
                    key={node.id}
                    data-graph-node={node.id}
                    transform={`translate(${pos.x}, ${pos.y})`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`${NODE_KIND_LABELS[node.kind]}：${node.label}`}
                    className="cursor-pointer focus:outline-none"
                    onClick={() => onSelectNode(node.id)}
                    onKeyDown={event => handleNodeKeyDown(event, node.id)}
                  >
                    <title>{node.label}</title>
                    <rect
                      x={0}
                      y={0}
                      width={NODE_W}
                      height={NODE_H}
                      rx={14}
                      strokeWidth={isSelected ? 2 : 1}
                      className={
                        isSelected
                          ? "fill-accent-soft stroke-accent"
                          : "fill-surface stroke-line-strong hover:stroke-accent"
                      }
                    />
                    <rect
                      x={0}
                      y={10}
                      width={4}
                      height={NODE_H - 20}
                      rx={2}
                      className={KIND_ACCENT_BAR[node.kind]}
                    />
                    <text x={14} y={22} className="fill-text-2 text-[11px] font-medium">
                      {NODE_KIND_LABELS[node.kind]}
                    </text>
                    <text x={14} y={42} className="fill-text text-[13px] font-semibold">
                      {line1}
                    </text>
                    {line2 ? (
                      <text x={14} y={59} className="fill-text text-[13px] font-semibold">
                        {line2}
                      </text>
                    ) : null}
                    {statusText ? (
                      <text x={14} y={77} className="fill-text-2 text-[11px]">
                        {statusText}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>

      <section aria-label="节点键盘操作清单" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">画布节点与关系展开</h2>
          <p className="text-meta text-text-3">
            点击任意节点聚焦，或使用入边、出边、双向展开逐步探索关联。
          </p>
        </div>
        <ul className="grid gap-3 md:grid-cols-2">
          {nodes.map(node => {
            const isSelected = selectedNodeId === node.id;
            const center = expandedCenters[node.id];
            const isExpanding = expandingNodeId === node.id;
            const isLoadingDetail = loadingDetailNodeId === node.id;
            const canEnterGoal =
              node.kind === "goal" &&
              !(context.kind === "goal" && context.id === node.id);
            const canEnterCourse =
              node.kind === "course" &&
              !(context.kind === "course" && context.id === node.id);

            return (
              <li
                key={node.id}
                data-node-card={node.id}
                className={`rounded-tile border p-3.5 transition-colors ${
                  isSelected
                    ? "border-accent bg-accent-soft/45"
                    : "border-line bg-surface hover:border-line-strong"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`${ui.badge} ${KIND_BADGE_TONE[node.kind]}`}>
                        {NODE_KIND_LABELS[node.kind]}
                      </span>
                      {center ? (
                        <span className={`${ui.badge} ${tone.neutral}`}>
                          已展开（{center.direction === "in" ? "入边" : center.direction === "out" ? "出边" : "双向"}）
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onSelectNode(node.id)}
                      className="block w-full text-left text-sm font-semibold text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {node.label}
                    </button>
                  </div>
                </div>

                {node.summary ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {node.summary.learnerState ? (
                      <span className={`${ui.badge} ${tone.neutral}`}>
                        练习状态：{LEARNER_STATE_LABELS[node.summary.learnerState]}
                      </span>
                    ) : null}
                    {node.summary.requirementStatus ? (
                      <span
                        className={`${ui.badge} ${
                          node.summary.requirementStatus === "verified"
                            ? tone.success
                            : node.summary.requirementStatus === "blocked" ||
                                node.summary.requirementStatus === "needs_correction"
                              ? tone.warning
                              : tone.neutral
                        }`}
                      >
                        课程要求：{REQUIREMENT_STATUS_LABELS[node.summary.requirementStatus]}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {node.meta ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-3">
                    {node.meta.occurredAt ? (
                      <span>发生时间：{formatMetaTimestamp(node.meta.occurredAt)}</span>
                    ) : null}
                    {node.meta.assistance ? (
                      <span>完成条件：{ASSISTANCE_LABELS[node.meta.assistance]}</span>
                    ) : null}
                    {node.meta.version !== undefined ? (
                      <span>版本：第 {node.meta.version} 版</span>
                    ) : null}
                    {node.meta.knowledgeStatus ? (
                      <span>整理状态：{KNOWLEDGE_STATUS_LABELS[node.meta.knowledgeStatus]}</span>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={isExpanding}
                    onClick={() => onExpandNode(node.id, "in")}
                  >
                    <ArrowDownLeft size={14} aria-hidden="true" />
                    入边探索
                  </button>
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={isExpanding}
                    onClick={() => onExpandNode(node.id, "out")}
                  >
                    <ArrowUpRight size={14} aria-hidden="true" />
                    出边展开
                  </button>
                  <button
                    type="button"
                    className={ui.quiet}
                    disabled={isExpanding}
                    onClick={() => onExpandNode(node.id, "both")}
                  >
                    <Expand size={14} aria-hidden="true" />
                    双向展开
                  </button>
                  <button
                    type="button"
                    className={ui.quiet}
                    disabled={isLoadingDetail}
                    onClick={() => onLoadDetail(node.id)}
                  >
                    <FileSearch size={14} aria-hidden="true" />
                    {isLoadingDetail ? "读取详情中…" : "查看详情"}
                  </button>
                  {canEnterGoal ? (
                    <button
                      type="button"
                      className={ui.secondary}
                      onClick={() => onEnterContext({ kind: "goal", id: node.id }, node.id)}
                    >
                      <Compass size={14} aria-hidden="true" />
                      进入目标范围
                    </button>
                  ) : null}
                  {canEnterCourse ? (
                    <button
                      type="button"
                      className={ui.secondary}
                      onClick={() => onEnterContext({ kind: "course", id: node.id }, node.id)}
                    >
                      <Compass size={14} aria-hidden="true" />
                      进入课程范围
                    </button>
                  ) : null}
                  {center?.nextCursor ? (
                    <button
                      type="button"
                      className={ui.secondary}
                      disabled={isExpanding}
                      onClick={() => onLoadMoreNeighbors(node.id)}
                    >
                      继续加载邻接
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {edges.some(edge => edge.basis === "suggested") ? (
          <p className="text-meta text-text-3">
            虚线边表示「{EDGE_BASIS_LABELS.suggested}」，仅作浏览参考，不代表已确认的课程要求关系。
          </p>
        ) : null}
      </section>
    </div>
  );
}
