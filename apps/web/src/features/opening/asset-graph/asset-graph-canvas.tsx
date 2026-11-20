"use client";

import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Compass,
  Expand,
  FileSearch,
  Minimize2,
  Pin,
} from "lucide-react";
import { useMemo } from "react";
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
  EDGE_KNOWLEDGE_STATUS_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  NODE_KIND_LABELS,
  RELATION_LABELS,
  REQUIREMENT_STATUS_LABELS,
  describeEdgeStatus,
  describeZeroExpansion,
  getOwn,
  isZeroNeighborResult,
  resolveEffectiveNodeStates,
  type AssetGraphDirection,
  type ExpandedCenterState,
} from "./asset-graph-model";
import { FreeMapCanvas, type FreeMapLocateRequest } from "./free-map-canvas";

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

export function edgeKnowledgeStatusBadgeTone(
  status: NonNullable<AssetGraphEdge["knowledgeStatus"]>,
): string {
  switch (status) {
    case "supported":
      return tone.success;
    case "needs_check":
      return tone.warning;
    case "suggested":
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
  const statusLabel = describeEdgeStatus(edge);
  const basisText =
    direction === "out" ? ` · ${statusLabel}` : `（入边 · ${statusLabel}）`;

  return (
    <li
      data-connected-edge={edge.id}
      data-knowledge-status={edge.knowledgeStatus}
      className="rounded-ctl bg-surface-2/60 p-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-text">{RELATION_LABELS[edge.relation]}</span>
        {edge.knowledgeStatus ? (
          <span
            className={`${ui.badge} ${edgeKnowledgeStatusBadgeTone(edge.knowledgeStatus)}`}
          >
            {EDGE_KNOWLEDGE_STATUS_LABELS[edge.knowledgeStatus]}
          </span>
        ) : (
          <span>{basisText}</span>
        )}
        {edge.knowledgeStatus && direction === "in" ? (
          <span className="text-text-3">（入边）</span>
        ) : null}
        {edge.sourceVersion !== undefined ? (
          <span> · 资料第 {edge.sourceVersion} 版</span>
        ) : null}
        {edge.page !== undefined ? <span> · 第 {edge.page} 页</span> : null}
      </div>
      {edge.knowledgeStatus === "needs_check" ? (
        <p className="mt-1 text-micro text-warn">
          原资料依据当前暂不可确认，请对照本课资料重新核对后再采用。
        </p>
      ) : null}
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
      edge.knowledgeStatus ?? "",
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
  activeDetail?: AssetGraphDetail | null;
  pinnedNodeId?: string | null;
  context: AssetGraphContext;
  lens?: AssetGraphLens;
  mode?: "exam" | "study";
  layoutKey?: string;
  persistKey?: string;
  locateRequest?: FreeMapLocateRequest | null;
  expandedCenters: Record<string, ExpandedCenterState>;
  expandingNodeId: string | null;
  loadingDetailNodeId: string | null;
  onSelectNode: (nodeId: AssetGraphNodeId) => void;
  onExpandNode: (
    nodeId: AssetGraphNodeId,
    direction: AssetGraphDirection,
    triggerButton?: HTMLButtonElement | null,
  ) => void;
  onCollapseNode?: (nodeId: AssetGraphNodeId) => void;
  onLoadMoreNeighbors: (
    nodeId: AssetGraphNodeId,
    triggerButton?: HTMLButtonElement | null,
  ) => void;
  onLoadDetail: (nodeId: AssetGraphNodeId) => void;
  onEnterContext: (context: AssetGraphContext, focusId?: string) => void;
  onTogglePinNode?: (nodeId: AssetGraphNodeId) => void;
};

export function AssetGraphCanvas({
  nodes,
  edges,
  rootIds: _rootIds,
  selectedNodeId,
  activeDetail = null,
  pinnedNodeId = null,
  context,
  lens = "all",
  mode = "exam",
  layoutKey,
  persistKey,
  locateRequest = null,
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
  const activeLineage = useMemo(
    () => computeHighlightedLineage(selectedNodeId, edges),
    [selectedNodeId, edges],
  );

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

  const resolvedLayoutKey =
    layoutKey ??
    `${context.kind}:${context.kind === "workspace" ? "workspace" : context.id}:${lens}`;

  const hasDerivedEdges = edges.some(edge => edge.basis === "derived");
  const hasSuggestedEdges = edges.some(
    edge => edge.basis === "suggested" || edge.knowledgeStatus === "suggested",
  );
  const hasNeedsCheckEdges = edges.some(edge => edge.knowledgeStatus === "needs_check");

  return (
    <div className="space-y-4">
      <FreeMapCanvas
        nodes={nodes}
        edges={edges}
        selectedId={(selectedNodeId as AssetGraphNodeId | null) ?? null}
        selectedDetail={activeDetail}
        mode={mode}
        onSelect={onSelectNode}
        onExpand={nodeId => onExpandNode(nodeId, "both")}
        layoutKey={resolvedLayoutKey}
        persistKey={persistKey}
        locateRequest={locateRequest}
        highlightedNodeIds={selectedNodeId ? activeLineage.nodeSet : null}
        highlightedEdgeIds={selectedNodeId ? activeLineage.edgeSet : null}
      />

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
                    onClick={event => onExpandNode(node.id, "in", event.currentTarget)}
                  >
                    <ArrowDownLeft size={14} aria-hidden="true" />
                    入边探索
                  </button>
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={isExpanding}
                    onClick={event => onExpandNode(node.id, "out", event.currentTarget)}
                  >
                    <ArrowUpRight size={14} aria-hidden="true" />
                    出边展开
                  </button>
                  <button
                    type="button"
                    className={ui.quiet}
                    disabled={isExpanding}
                    onClick={event => onExpandNode(node.id, "both", event.currentTarget)}
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
                      onClick={event => onLoadMoreNeighbors(node.id, event.currentTarget)}
                    >
                      加载更多关联
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {hasDerivedEdges || hasSuggestedEdges || hasNeedsCheckEdges ? (
          <p className="text-meta text-text-3">
            实线表示「{EDGE_BASIS_LABELS.recorded}」或「{EDGE_KNOWLEDGE_STATUS_LABELS.supported}」
            {hasNeedsCheckEdges
              ? `；中虚线警示色表示「${EDGE_KNOWLEDGE_STATUS_LABELS.needs_check}」，表示原资料依据当前暂不可确认`
              : ""}
            {hasDerivedEdges ? `；长虚线表示「${EDGE_BASIS_LABELS.derived}」` : ""}
            {hasSuggestedEdges
              ? `；短虚线表示「${EDGE_BASIS_LABELS.suggested}」，仅作浏览参考，不代表已确认的课程要求关系`
              : ""}
            。
          </p>
        ) : null}
      </section>
    </div>
  );
}
