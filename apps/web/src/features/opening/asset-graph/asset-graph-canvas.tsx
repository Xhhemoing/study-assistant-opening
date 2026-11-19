"use client";

import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Compass,
  Expand,
  FileSearch,
  GitBranch,
  Minimize2,
  Pin,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  isSafeOpeningNavigateHref,
  type AssetGraphContext,
  type AssetGraphDetail,
  type AssetGraphEdge,
  type AssetGraphLens,
  type AssetGraphNode,
  type AssetGraphNodeId,
  type AssetGraphNodeKind,
  type AssetGraphRequirementStatus,
} from "@aistudy/contracts";
import { tone, ui } from "../design/ui";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import {
  ASSISTANCE_LABELS,
  EDGE_BASIS_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  NODE_KIND_LABELS,
  RELATION_LABELS,
  REQUIREMENT_STATUS_LABELS,
  describeZeroExpansion,
  getOwn,
  isZeroNeighborResult,
  resolveEffectiveNodeStates,
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
const COL_GAP = 136;
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

export const KIND_BADGE_TONE: Record<AssetGraphNodeKind, string> = {
  course: "bg-surface-2 text-obj-1",
  goal: "bg-accent-soft text-accent",
  requirement: "bg-warn-soft text-warn",
  knowledge: "bg-surface-2 text-obj-4",
  source: "bg-surface-2 text-obj-1",
  document: "bg-accent-soft text-accent",
  exploration: "bg-surface-2 text-obj-4",
  observation: "bg-warn-soft text-warn",
};

export function requirementStatusBadgeTone(status: AssetGraphRequirementStatus): string {
  switch (status) {
    case "verified":
      return tone.success;
    case "needs_correction":
      return tone.danger;
    case "blocked":
    case "assisted":
      return tone.warning;
    case "needs_verification":
    case "unobserved":
      return tone.neutral;
  }
}

export function SharedEdgeAttribution({
  attribution,
}: {
  attribution: NonNullable<AssetGraphEdge["sharedAttribution"]>;
}) {
  const sourceCourseHref = `/opening/courses/${attribution.sourceCourseId}`;
  return (
    <div className="mt-1.5 space-y-1 rounded-ctl border border-line bg-surface px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${ui.badge} ${tone.neutral}`}>跨课共享证据</span>
        <span className="text-xs text-text-2">
          {`跨课共享自「${attribution.sourceCourseTitle} · ${attribution.sourceRequirementTitle}」（第 ${attribution.sourceRequirementRevision} 版）`}
        </span>
      </div>
      {isSafeOpeningNavigateHref(sourceCourseHref) ? (
        <Link
          href={sourceCourseHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          <span>查看来源课程</span>
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

export function ConnectedEdgeItem({
  edge,
  direction,
  endpointNode,
  onFocusNode,
}: {
  edge: AssetGraphEdge;
  direction: "in" | "out";
  endpointNode: AssetGraphNode | undefined;
  onFocusNode: (nodeId: string) => void;
}) {
  const basisText =
    direction === "out"
      ? ` · ${EDGE_BASIS_LABELS[edge.basis]}`
      : `（入边 · ${EDGE_BASIS_LABELS[edge.basis]}）`;

  return (
    <li className="rounded-ctl bg-surface-2/60 p-2">
      <span className="font-medium text-text">{RELATION_LABELS[edge.relation]}</span>
      <span>{basisText}</span>
      {edge.sourceVersion !== undefined ? (
        <span> · 资料第 {edge.sourceVersion} 版</span>
      ) : null}
      {edge.page !== undefined ? <span> · 第 {edge.page} 页</span> : null}
      {endpointNode ? (
        <button
          type="button"
          className="mt-1 block text-left text-accent hover:underline"
          onClick={() => onFocusNode(endpointNode.id)}
        >
          {direction === "out" ? `指向：${endpointNode.label}` : `来自：${endpointNode.label}`}
        </button>
      ) : null}
      {edge.sharedAttribution ? (
        <SharedEdgeAttribution attribution={edge.sharedAttribution} />
      ) : null}
    </li>
  );
}

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

export type BundledCanvasEdge = {
  key: string;
  primary: AssetGraphEdge;
  edges: AssetGraphEdge[];
  pages: number[];
};

export function bundleCanvasEdges(edges: readonly AssetGraphEdge[]): BundledCanvasEdge[] {
  const byKey = new Map<string, BundledCanvasEdge>();
  for (const edge of edges) {
    const key = [
      edge.from,
      edge.to,
      edge.relation,
      edge.basis,
      edge.sourceVersion ?? "",
      edge.sharedAttribution?.linkId ?? "",
    ].join("=>");
    const existing = byKey.get(key);
    if (existing) {
      existing.edges.push(edge);
      if (edge.page !== undefined && !existing.pages.includes(edge.page)) {
        existing.pages.push(edge.page);
        existing.pages.sort((a, b) => a - b);
      }
    } else {
      byKey.set(key, {
        key,
        primary: edge,
        edges: [edge],
        pages: edge.page !== undefined ? [edge.page] : [],
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Highlight direct 1-hop neighbors plus up to 3 upstream foundation/provenance hops
 * (`prerequisite`, `appliesTo`, `promotedTo`, `contains`) seeded from the selected item
 * and its direct `mappedTo` / `linkedTo` anchors.
 */
export function computeHighlightedLineage(
  selectedNodeId: string | null,
  edges: readonly AssetGraphEdge[],
): {
  nodeSet: Set<string>;
  edgeSet: Set<string>;
} {
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();
  if (!selectedNodeId) return { nodeSet, edgeSet };

  nodeSet.add(selectedNodeId);
  for (const edge of edges) {
    if (edge.from === selectedNodeId) {
      nodeSet.add(edge.to);
      edgeSet.add(edge.id);
    }
    if (edge.to === selectedNodeId) {
      nodeSet.add(edge.from);
      edgeSet.add(edge.id);
    }
  }

  let frontier = new Set<string>([selectedNodeId]);
  const visitedUpstream = new Set<string>([selectedNodeId]);
  for (const edge of edges) {
    if (edge.from === selectedNodeId && edge.relation === "mappedTo") {
      frontier.add(edge.to);
      visitedUpstream.add(edge.to);
    }
    if (edge.to === selectedNodeId && edge.relation === "linkedTo") {
      frontier.add(edge.from);
      visitedUpstream.add(edge.from);
    }
  }

  for (let hop = 0; hop < 3 && frontier.size > 0; hop += 1) {
    const nextFrontier = new Set<string>();
    for (const edge of edges) {
      const isUpstreamFoundation =
        (edge.relation === "prerequisite" ||
          edge.relation === "appliesTo" ||
          edge.relation === "promotedTo" ||
          edge.relation === "contains") &&
        frontier.has(edge.to);
      if (isUpstreamFoundation) {
        edgeSet.add(edge.id);
        nodeSet.add(edge.from);
        if (!visitedUpstream.has(edge.from)) {
          visitedUpstream.add(edge.from);
          nextFrontier.add(edge.from);
        }
      }
    }
    frontier = nextFrontier;
  }

  return { nodeSet, edgeSet };
}

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

  if (fromPos.x > toPos.x) {
    const startX = fromPos.x;
    const endX = toPos.x + NODE_W;
    const dx = Math.max(48, (startX - endX) * 0.48);
    const c1x = startX - dx;
    const c1y = startY + spread * 0.6;
    const c2x = endX + dx;
    const c2y = endY + spread * 0.6;
    return {
      d: `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: 0.125 * startY + 0.375 * c1y + 0.375 * c2y + 0.125 * endY - 8,
    };
  }

  if (fromPos.y === toPos.y) {
    const x = fromPos.x + NODE_W / 2;
    const y = fromPos.y;
    const loopH = 44 + parallelIndex * 18;
    return {
      d: `M ${x - 24} ${y} C ${x - 24} ${y - loopH}, ${x + 24} ${y - loopH}, ${x + 24} ${y}`,
      labelX: x,
      labelY: y - loopH + 10,
    };
  }

  const startX = fromPos.x + NODE_W / 2;
  const endX = toPos.x + NODE_W / 2;
  const arcOffset = 78 + spread;
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

function formatBundledEdgeText(bundle: BundledCanvasEdge): {
  shortText: string;
  fullDescription: string;
} {
  const edge = bundle.primary;
  const relationName = RELATION_LABELS[edge.relation];
  const pagePart =
    bundle.pages.length === 0
      ? ""
      : bundle.pages.length <= 3
        ? `（第${bundle.pages.join("、")}页）`
        : `（第${bundle.pages.slice(0, 2).join("、")}页等${bundle.pages.length}处）`;
  const sharedSuffix = edge.sharedAttribution ? " · 跨课共享证据" : "";
  const shortText = `${relationName}${pagePart}${sharedSuffix}`;

  const descParts = [
    relationName,
    EDGE_BASIS_LABELS[edge.basis],
    ...(edge.sourceVersion !== undefined ? [`第 ${edge.sourceVersion} 版`] : []),
    ...(bundle.pages.length > 0 ? [`第 ${bundle.pages.join("、")} 页`] : []),
    ...(edge.sharedAttribution
      ? [
          `跨课共享自「${edge.sharedAttribution.sourceCourseTitle} · ${edge.sharedAttribution.sourceRequirementTitle}」（第 ${edge.sharedAttribution.sourceRequirementRevision} 版）`,
        ]
      : []),
  ];
  return {
    shortText,
    fullDescription: descParts.join(" · "),
  };
}

export type AssetGraphCanvasProps = {
  nodes: readonly AssetGraphNode[];
  edges: readonly AssetGraphEdge[];
  rootIds: readonly string[];
  selectedNodeId: string | null;
  activeDetail?: AssetGraphDetail | null;
  pinnedNodeId?: string | null;
  context: AssetGraphContext;
  lens?: AssetGraphLens;
  expandedCenters: Record<string, ExpandedCenterState>;
  expandingNodeId: string | null;
  loadingDetailNodeId: string | null;
  onSelectNode: (nodeId: AssetGraphNodeId) => void;
  onExpandNode: (nodeId: AssetGraphNodeId, direction: AssetGraphDirection) => void;
  onCollapseNode?: (nodeId: AssetGraphNodeId) => void;
  onLoadMoreNeighbors: (nodeId: AssetGraphNodeId) => void;
  onLoadDetail: (nodeId: AssetGraphNodeId) => void;
  onEnterContext: (context: AssetGraphContext, focusId?: string) => void;
  onTogglePinNode?: (nodeId: AssetGraphNodeId) => void;
};

export function AssetGraphCanvas({
  nodes,
  edges,
  rootIds,
  selectedNodeId,
  activeDetail = null,
  pinnedNodeId = null,
  context,
  lens = "all",
  expandedCenters,
  expandingNodeId,
  loadingDetailNodeId,
  onSelectNode,
  onExpandNode,
  onCollapseNode,
  onLoadMoreNeighbors,
  onLoadDetail,
  onEnterContext,
  onTogglePinNode,
}: AssetGraphCanvasProps) {
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const markerPrefix = useId().replace(/:/g, "");
  const recordedArrowId = `${markerPrefix}-arrow-recorded`;
  const activeArrowId = `${markerPrefix}-arrow-active`;
  const prereqArrowId = `${markerPrefix}-arrow-prereq`;
  const derivedArrowId = `${markerPrefix}-arrow-derived`;
  const derivedOriginId = `${markerPrefix}-origin-derived`;
  const suggestedArrowId = `${markerPrefix}-arrow-suggested`;
  const suggestedActiveArrowId = `${markerPrefix}-arrow-suggested-active`;
  const suggestedOriginId = `${markerPrefix}-origin-suggested`;

  const layout = useMemo(
    () => computeLayeredGraphLayout(nodes, edges, rootIds),
    [nodes, edges, rootIds],
  );
  const bundledEdges = useMemo(() => bundleCanvasEdges(edges), [edges]);
  const activeLineage = useMemo(
    () => computeHighlightedLineage(selectedNodeId, edges),
    [selectedNodeId, edges],
  );

  const parallelGroups = useMemo(() => {
    const groups = new Map<string, BundledCanvasEdge[]>();
    for (const bundle of bundledEdges) {
      const canonicalPair =
        bundle.primary.from < bundle.primary.to
          ? `${bundle.primary.from}<=>${bundle.primary.to}`
          : `${bundle.primary.to}<=>${bundle.primary.from}`;
      const list = groups.get(canonicalPair) ?? [];
      list.push(bundle);
      groups.set(canonicalPair, list);
    }
    return groups;
  }, [bundledEdges]);

  const sharedEdgesByNodeId = useMemo(() => {
    const map = new Map<string, AssetGraphEdge[]>();
    for (const edge of edges) {
      if (!edge.sharedAttribution) continue;
      const fromList = map.get(edge.from) ?? [];
      fromList.push(edge);
      map.set(edge.from, fromList);
      if (edge.to !== edge.from) {
        const toList = map.get(edge.to) ?? [];
        toList.push(edge);
        map.set(edge.to, toList);
      }
    }
    return map;
  }, [edges]);

  const viewWidth = Math.round(layout.width / zoom);
  const viewHeight = Math.round(layout.height / zoom);
  const viewX = Math.round(pan.x + (layout.width - viewWidth) / 2);
  const viewY = Math.round(pan.y + (layout.height - viewHeight) / 2);

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

  const hasDerivedEdges = edges.some(edge => edge.basis === "derived");
  const hasSuggestedEdges = edges.some(edge => edge.basis === "suggested");

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-2">
          <div className="flex items-center gap-2 text-meta text-text-2">
            <GitBranch size={14} aria-hidden="true" className="text-accent" />
            <span>
              当前关系图：{nodes.length} 项内容 · {bundledEdges.length} 条关联
            </span>
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="toolbar"
            aria-label="关系图缩放与视角控制"
          >
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
            aria-label={`个人知识地图关系画布，共 ${nodes.length} 项内容与 ${bundledEdges.length} 条关联`}
            className="block h-96 w-full min-w-xl touch-pan-y select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={handlePointerEnd}
          >
            <defs>
              <marker
                id={recordedArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" className="fill-text-3" />
              </marker>
              <marker
                id={activeArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" className="fill-accent" />
              </marker>
              <marker
                id={prereqArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" className="fill-obj-2" />
              </marker>
              <marker
                id={derivedArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0.5 1.5 L 9.5 5 L 0.5 8.5 z"
                  className="fill-surface stroke-text-2"
                  strokeWidth="1.4"
                />
              </marker>
              <marker
                id={derivedOriginId}
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerWidth="5.5"
                markerHeight="5.5"
              >
                <rect
                  x="2"
                  y="2"
                  width="6"
                  height="6"
                  className="fill-surface stroke-text-2"
                  strokeWidth="1.5"
                />
              </marker>
              <marker
                id={suggestedArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M 1 1.5 L 9.5 5 L 1 8.5"
                  fill="none"
                  className="stroke-warn"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
              <marker
                id={suggestedActiveArrowId}
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M 1 1.5 L 9.5 5 L 1 8.5"
                  fill="none"
                  className="stroke-accent"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
              <marker
                id={suggestedOriginId}
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
              >
                <polygon
                  points="5,1 9,5 5,9 1,5"
                  className="fill-surface stroke-warn"
                  strokeWidth="1.5"
                />
              </marker>
            </defs>

            <g aria-label="关联线">
              {bundledEdges.map(bundle => {
                const edge = bundle.primary;
                const fromPos = getOwn(layout.positions, edge.from);
                const toPos = getOwn(layout.positions, edge.to);
                if (!fromPos || !toPos) return null;

                const canonicalPair =
                  edge.from < edge.to
                    ? `${edge.from}<=>${edge.to}`
                    : `${edge.to}<=>${edge.from}`;
                const group = parallelGroups.get(canonicalPair) ?? [bundle];
                const idx = group.indexOf(bundle);
                const geom = edgeGeometry(fromPos, toPos, idx, group.length);

                const inLineage = bundle.edges.some(item => activeLineage.edgeSet.has(item.id));
                const dimmed = selectedNodeId !== null && !inLineage;
                const isPrereq = edge.relation === "prerequisite";
                const { shortText, fullDescription } = formatBundledEdgeText(bundle);

                const dashPattern =
                  edge.basis === "derived"
                    ? "8 4"
                    : edge.basis === "suggested"
                      ? "3 4"
                      : undefined;
                const startMarker =
                  edge.basis === "derived"
                    ? `url(#${derivedOriginId})`
                    : edge.basis === "suggested"
                      ? `url(#${suggestedOriginId})`
                      : undefined;
                const endMarker =
                  edge.basis === "suggested"
                    ? `url(#${inLineage ? suggestedActiveArrowId : suggestedArrowId})`
                    : isPrereq && inLineage
                      ? `url(#${prereqArrowId})`
                      : inLineage
                        ? `url(#${activeArrowId})`
                        : edge.basis === "derived"
                          ? `url(#${derivedArrowId})`
                          : `url(#${recordedArrowId})`;

                return (
                  <g
                    key={bundle.key}
                    data-edge-id={edge.id}
                    data-edge-basis={edge.basis}
                    data-bundled-count={bundle.edges.length}
                    data-highlighted={inLineage ? "true" : "false"}
                    className={dimmed ? "opacity-30 transition-opacity" : "opacity-100 transition-opacity"}
                  >
                    <title>{fullDescription}</title>
                    <path
                      d={geom.d}
                      fill="none"
                      strokeWidth={inLineage ? (isPrereq ? 2.4 : 2.2) : 1.5}
                      strokeDasharray={dashPattern}
                      markerStart={startMarker}
                      markerEnd={endMarker}
                      className={
                        inLineage
                          ? isPrereq
                            ? "stroke-obj-2"
                            : "stroke-accent"
                          : edge.basis === "suggested"
                            ? "stroke-warn"
                            : "stroke-line-strong"
                      }
                    />
                    <text
                      x={geom.labelX}
                      y={geom.labelY}
                      textAnchor="middle"
                      className={`text-micro font-medium ${
                        inLineage ? "fill-accent" : "fill-text-2"
                      }`}
                    >
                      {shortText}
                    </text>
                  </g>
                );
              })}
            </g>

            <g aria-label="地图项目">
              {nodes.map(node => {
                const pos = getOwn(layout.positions, node.id);
                if (!pos) return null;
                const isSelected = selectedNodeId === node.id;
                const isPinned = pinnedNodeId === node.id;
                const isExpanded = Boolean(getOwn(expandedCenters, node.id));
                const dimmedNode =
                  selectedNodeId !== null &&
                  !activeLineage.nodeSet.has(node.id) &&
                  !isPinned;

                const effectiveStates = resolveEffectiveNodeStates(
                  node,
                  activeDetail && activeDetail.id === node.id ? activeDetail : null,
                );
                const [line1, line2] = truncateSvgLabel(node.label);
                const statusText = effectiveStates.requirementStatus
                  ? REQUIREMENT_STATUS_LABELS[effectiveStates.requirementStatus]
                  : effectiveStates.learnerState
                    ? LEARNER_STATE_LABELS[effectiveStates.learnerState]
                    : isExpanded
                      ? "已展开关联"
                      : null;

                return (
                  <g
                    key={node.id}
                    data-graph-node={node.id}
                    data-highlighted={activeLineage.nodeSet.has(node.id) ? "true" : "false"}
                    transform={`translate(${pos.x}, ${pos.y})`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`${NODE_KIND_LABELS[node.kind]}：${node.label}`}
                    className={`cursor-pointer focus:outline-none ${
                      dimmedNode ? "opacity-40 transition-opacity hover:opacity-100" : "opacity-100 transition-opacity"
                    }`}
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
                    <text x={14} y={22} className="fill-text-2 text-micro font-medium">
                      {NODE_KIND_LABELS[node.kind]}
                      {isPinned ? " · 已固定" : ""}
                    </text>
                    <text x={14} y={42} className="fill-text text-ui font-semibold">
                      {line1}
                    </text>
                    {line2 ? (
                      <text x={14} y={59} className="fill-text text-ui font-semibold">
                        {line2}
                      </text>
                    ) : null}
                    {statusText ? (
                      <text x={14} y={77} className="fill-text-2 text-micro">
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

      <section aria-label="项目操作清单" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">当前展示的项目与关联展开</h2>
          <p className="text-meta text-text-3">
            点选任意一项聚焦关联路径，或按来源、延伸、双向逐步展开关联内容。
          </p>
        </div>
        <ul className="grid gap-3 md:grid-cols-2">
          {nodes.map(node => {
            const isSelected = selectedNodeId === node.id;
            const isPinned = pinnedNodeId === node.id;
            const center = getOwn(expandedCenters, node.id);
            const zeroMatch = isZeroNeighborResult(center);
            const isExpanding = expandingNodeId === node.id;
            const isLoadingDetail = loadingDetailNodeId === node.id;
            const effectiveStates = resolveEffectiveNodeStates(
              node,
              activeDetail && activeDetail.id === node.id ? activeDetail : null,
            );
            const canEnterGoal =
              node.kind === "goal" && !(context.kind === "goal" && context.id === node.id);
            const canEnterCourse =
              node.kind === "course" && !(context.kind === "course" && context.id === node.id);
            const isScopeRoot = context.kind !== "workspace" && context.id === node.id;
            const canCollapse = Boolean(
              onCollapseNode && center && !isScopeRoot && center.edgeIds.length > 0,
            );
            const incidentSharedEdges = sharedEdgesByNodeId.get(node.id) ?? [];

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
                          已展开（
                          {center.direction === "in"
                            ? "入边"
                            : center.direction === "out"
                              ? "出边"
                              : "双向"}
                          ）
                        </span>
                      ) : null}
                      {isPinned ? (
                        <span className={`${ui.badge} ${tone.neutral}`}>对比参考</span>
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

                {effectiveStates.learnerState || effectiveStates.requirementStatus ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {effectiveStates.learnerState ? (
                      <span className={`${ui.badge} ${tone.neutral}`}>
                        练习状态：{LEARNER_STATE_LABELS[effectiveStates.learnerState]}
                      </span>
                    ) : null}
                    {effectiveStates.requirementStatus ? (
                      <span
                        className={`${ui.badge} ${requirementStatusBadgeTone(
                          effectiveStates.requirementStatus,
                        )}`}
                      >
                        课程要求：{REQUIREMENT_STATUS_LABELS[effectiveStates.requirementStatus]}
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

                {zeroMatch && center ? (
                  <p className="mt-2 text-meta text-text-3">
                    {describeZeroExpansion(node.kind, center.direction, lens)}
                  </p>
                ) : null}

                {incidentSharedEdges.map(sharedEdge =>
                  sharedEdge.sharedAttribution ? (
                    <SharedEdgeAttribution
                      key={`${node.id}-${sharedEdge.id}`}
                      attribution={sharedEdge.sharedAttribution}
                    />
                  ) : null,
                )}

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
                  {canCollapse && onCollapseNode ? (
                    <button
                      type="button"
                      className={ui.quiet}
                      onClick={() => onCollapseNode(node.id)}
                    >
                      <Minimize2 size={14} aria-hidden="true" />
                      收起关联
                    </button>
                  ) : null}
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
                  {onTogglePinNode ? (
                    <button
                      type="button"
                      className={ui.quiet}
                      aria-pressed={isPinned}
                      onClick={() => onTogglePinNode(node.id)}
                    >
                      <Pin size={14} aria-hidden="true" />
                      {isPinned ? "取消固定" : "固定对比"}
                    </button>
                  ) : null}
                  {center?.nextCursor ? (
                    <button
                      type="button"
                      className={ui.secondary}
                      disabled={isExpanding}
                      onClick={() => onLoadMoreNeighbors(node.id)}
                    >
                      加载更多关联
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {hasDerivedEdges || hasSuggestedEdges ? (
          <p className="text-meta text-text-3">
            实线表示「{EDGE_BASIS_LABELS.recorded}」
            {hasDerivedEdges ? `；长虚线配方形起点表示「${EDGE_BASIS_LABELS.derived}」` : ""}
            {hasSuggestedEdges
              ? `；短虚线配菱形起点表示「${EDGE_BASIS_LABELS.suggested}」，仅作浏览参考，不代表已确认的课程要求关系`
              : ""}
            。
          </p>
        ) : null}
      </section>
    </div>
  );
}
