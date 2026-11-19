"use client";

import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Clock,
  Compass,
  Expand,
  FileSearch,
  Minimize2,
  Pin,
} from "lucide-react";
import { useMemo } from "react";
import type {
  AssetGraphContext,
  AssetGraphDetail,
  AssetGraphEdge,
  AssetGraphLens,
  AssetGraphNode,
  AssetGraphNodeId,
} from "@aistudy/contracts";
import { tone, ui } from "../design/ui";
import { Segmented } from "../v3/ui/segmented";
import {
  KIND_BADGE_TONE,
  SharedEdgeAttribution,
  requirementStatusBadgeTone,
} from "./asset-graph-canvas";
import {
  ASSISTANCE_LABELS,
  EDGE_BASIS_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  NODE_KIND_LABELS,
  RELATION_LABELS,
  REQUIREMENT_STATUS_LABELS,
  describeZeroExpansion,
  getNodeTraversalLabels,
  getOwn,
  isZeroNeighborResult,
  resolveEffectiveNodeStates,
  type AssetGraphDirection,
  type ExpandedCenterState,
} from "./asset-graph-model";

export type ListSubTab = "relations" | "nodes" | "timeline";

function formatEventTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type AssetGraphListViewProps = {
  nodes: readonly AssetGraphNode[];
  edges: readonly AssetGraphEdge[];
  nodesById: Record<string, AssetGraphNode>;
  selectedNodeId: string | null;
  activeDetail?: AssetGraphDetail | null;
  pinnedNodeId?: string | null;
  context: AssetGraphContext;
  lens: AssetGraphLens;
  subTab: ListSubTab | null;
  onSubTabChange: (tab: ListSubTab) => void;
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

export function AssetGraphListView({
  nodes,
  edges,
  nodesById,
  selectedNodeId,
  activeDetail = null,
  pinnedNodeId = null,
  context,
  lens,
  subTab,
  onSubTabChange,
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
}: AssetGraphListViewProps) {
  const effectiveSubTab: ListSubTab = subTab ?? (edges.length > 0 ? "relations" : "nodes");

  const timelineNodes = useMemo(() => {
    return nodes
      .filter((node): node is AssetGraphNode & { meta: { occurredAt: string } } =>
        Boolean(node.meta?.occurredAt),
      )
      .sort((a, b) => {
        const ta = Date.parse(a.meta.occurredAt);
        const tb = Date.parse(b.meta.occurredAt);
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && tb !== ta) return tb - ta;
        return b.meta.occurredAt.localeCompare(a.meta.occurredAt);
      });
  }, [nodes]);

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

  return (
    <div
      data-list-view
      className="space-y-4 rounded-tile border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <Segmented<ListSubTab>
          name="asset-graph-list-tab"
          label="列表阅读维度"
          value={effectiveSubTab}
          onChange={onSubTabChange}
          options={[
            { value: "relations", label: `关联列表（${edges.length}）` },
            { value: "nodes", label: `当前展示的项目（${nodes.length}）` },
            { value: "timeline", label: `练习时间线（${timelineNodes.length}）` },
          ]}
        />
        <span className="text-meta text-text-3">
          切换列表维度仅改变当前已读内容的排列方式，不会重新读取或改变观察范围
        </span>
      </div>

      {effectiveSubTab === "relations" ? (
        edges.length === 0 ? (
          <div className="rounded-tile bg-surface-2/50 p-5 text-center text-ui text-text-2">
            <p className="font-medium text-text">尚未展开关联内容</p>
            <p className="mt-1 text-meta text-text-3">
              可以在「当前展示的项目」中任选一项查看来源或展开关联内容，同一份资料的不同页码引用也会在此逐行列出。
            </p>
            <button
              type="button"
              className={`${ui.secondary} mt-3`}
              onClick={() => onSubTabChange("nodes")}
            >
              查看当前展示的项目
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              aria-label="已展开关联列表"
              className="w-full min-w-xl border-collapse text-left text-ui"
            >
              <thead>
                <tr className="border-b border-line text-meta font-medium text-text-3">
                  <th className="py-2 pr-3">起点项目</th>
                  <th className="px-3 py-2">关系与出处</th>
                  <th className="py-2 pl-3">关联对象</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {edges.map(edge => {
                  const fromNode = getOwn(nodesById, edge.from);
                  const toNode = getOwn(nodesById, edge.to);
                  const active =
                    selectedNodeId === edge.from || selectedNodeId === edge.to;

                  return (
                    <tr
                      key={edge.id}
                      className={active ? "bg-accent-soft/35" : "hover:bg-surface-2/40"}
                    >
                      <td className="py-2.5 pr-3 align-top">
                        {fromNode ? (
                          <button
                            type="button"
                            onClick={() => onSelectNode(fromNode.id)}
                            className="rounded-sm text-left font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          >
                            <span className="mr-1.5 text-meta text-text-3">
                              [{NODE_KIND_LABELS[fromNode.kind]}]
                            </span>
                            {fromNode.label}
                          </button>
                        ) : (
                          <span className="text-text-2">{edge.from}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`${ui.badge} ${tone.neutral}`}>
                            {RELATION_LABELS[edge.relation]}
                          </span>
                          <span className="text-meta text-text-2">
                            {EDGE_BASIS_LABELS[edge.basis]}
                          </span>
                          {edge.sourceVersion !== undefined ? (
                            <span className="text-meta text-text-2">
                              · 资料第 {edge.sourceVersion} 版
                            </span>
                          ) : null}
                          {edge.page !== undefined ? (
                            <span className="text-meta font-medium text-text">
                              · 第 {edge.page} 页
                            </span>
                          ) : null}
                        </div>
                        {edge.sharedAttribution ? (
                          <SharedEdgeAttribution attribution={edge.sharedAttribution} />
                        ) : null}
                      </td>
                      <td className="py-2.5 pl-3 align-top">
                        {toNode ? (
                          <button
                            type="button"
                            onClick={() => onSelectNode(toNode.id)}
                            className="inline-flex items-center gap-1.5 rounded-sm text-left font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          >
                            <ArrowRight size={13} aria-hidden="true" className="shrink-0 text-text-3" />
                            <span>
                              <span className="mr-1.5 text-meta text-text-3">
                                [{NODE_KIND_LABELS[toNode.kind]}]
                              </span>
                              {toNode.label}
                            </span>
                          </button>
                        ) : (
                          <span className="text-text-2">{edge.to}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {effectiveSubTab === "nodes" ? (
        <ul className="divide-y divide-line">
          {nodes.map(node => {
            const isSelected = selectedNodeId === node.id;
            const isPinned = pinnedNodeId === node.id;
            const center = getOwn(expandedCenters, node.id);
            const labels = getNodeTraversalLabels(node.kind, lens);
            const zeroMatch = isZeroNeighborResult(center);
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
                className={`py-3 first:pt-1 last:pb-1 ${
                  isSelected ? "rounded-tile bg-accent-soft/35 px-3" : "px-1"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`${ui.badge} ${KIND_BADGE_TONE[node.kind]}`}>
                        {NODE_KIND_LABELS[node.kind]}
                      </span>
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
                      {isPinned ? (
                        <span className={`${ui.badge} ${tone.neutral}`}>对比参考</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onSelectNode(node.id)}
                      className="block rounded-sm text-left text-ui font-semibold text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {node.label}
                    </button>
                    {node.meta ? (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-text-3">
                        {node.meta.occurredAt ? (
                          <span>发生时间：{formatEventTimestamp(node.meta.occurredAt)}</span>
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
                      <p className="text-meta text-text-3">
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
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className={ui.secondary}
                      disabled={expandingNodeId === node.id}
                      onClick={() => onExpandNode(node.id, "in")}
                    >
                      <ArrowDownLeft size={14} aria-hidden="true" />
                      {labels.incomingLabel}
                    </button>
                    <button
                      type="button"
                      className={ui.secondary}
                      disabled={expandingNodeId === node.id}
                      onClick={() => onExpandNode(node.id, "out")}
                    >
                      <ArrowUpRight size={14} aria-hidden="true" />
                      {labels.outgoingLabel}
                    </button>
                    <button
                      type="button"
                      className={ui.quiet}
                      disabled={expandingNodeId === node.id}
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
                      disabled={loadingDetailNodeId === node.id}
                      onClick={() => onLoadDetail(node.id)}
                    >
                      <FileSearch size={14} aria-hidden="true" />
                      {loadingDetailNodeId === node.id ? "读取详情中…" : "查看详情"}
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
                        disabled={expandingNodeId === node.id}
                        onClick={() => onLoadMoreNeighbors(node.id)}
                      >
                        加载更多关联
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {effectiveSubTab === "timeline" ? (
        timelineNodes.length === 0 ? (
          <div className="rounded-tile bg-surface-2/50 p-5 text-center text-ui text-text-2">
            <p className="font-medium text-text">这项范围内暂时没有带发生时间的练习记录</p>
            <p className="mt-1 text-meta text-text-3">
              这里只按真实发生时间排列练习记录，读取地图的时间不会混入其中。
            </p>
          </div>
        ) : (
          <ol className="space-y-2.5">
            {timelineNodes.map(node => {
              const incidentSharedEdges = sharedEdgesByNodeId.get(node.id) ?? [];
              return (
                <li
                  key={node.id}
                  className="space-y-2 rounded-tile border border-line bg-surface-2/35 px-3.5 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 text-meta text-text-2">
                        <Clock size={13} aria-hidden="true" className="text-accent" />
                        <span className="tabular-nums font-medium text-text">
                          {formatEventTimestamp(node.meta.occurredAt)}
                        </span>
                        {node.meta.assistance ? (
                          <span className={`${ui.badge} ${tone.neutral}`}>
                            {ASSISTANCE_LABELS[node.meta.assistance]}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => onSelectNode(node.id)}
                        className="block rounded-sm text-left text-ui font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        {node.label}
                      </button>
                    </div>
                    <button
                      type="button"
                      className={ui.quiet}
                      onClick={() => onLoadDetail(node.id)}
                    >
                      查看详情
                    </button>
                  </div>
                  {incidentSharedEdges.map(sharedEdge =>
                    sharedEdge.sharedAttribution ? (
                      <SharedEdgeAttribution
                        key={`${node.id}-${sharedEdge.id}`}
                        attribution={sharedEdge.sharedAttribution}
                      />
                    ) : null,
                  )}
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </div>
  );
}
