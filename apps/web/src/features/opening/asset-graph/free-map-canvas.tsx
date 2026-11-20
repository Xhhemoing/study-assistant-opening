"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Expand, Focus, GitBranch, RotateCcw, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import type {
  AssetGraphDetail,
  AssetGraphEdge,
  AssetGraphNode,
  AssetGraphNodeId,
} from "@aistudy/contracts";
import {
  EDGE_BASIS_LABELS,
  EDGE_KNOWLEDGE_STATUS_LABELS,
  RELATION_LABELS,
  describeEdgeStatus,
} from "./asset-graph-model";
import {
  MAP_NODE_HEIGHT,
  MAP_NODE_WIDTH,
  curveBetween,
  type MapPoint,
} from "./free-map-canvas-geometry";
import { useFreeMapGestures } from "./free-map-canvas-gestures";
import {
  emptyFreeMapLayout,
  extendFreeMapLayout,
  freeMapDescendants,
  freeMapVisibleIds,
  moveFreeMapNodes,
  type FreeMapLayout,
} from "./free-map-canvas-layout";
import { FreeMapCanvasNode, freeMapCaption, freeMapNodeColor } from "./free-map-canvas-node";
import {
  freeMapStorageKey,
  readFreeMapStorage,
  removeFreeMapStorage,
  writeFreeMapStorage,
} from "./free-map-canvas-storage";

export type FreeMapLocateRequest = { id: AssetGraphNodeId; sequence: number };

export type FreeMapCanvasProps = {
  nodes: readonly AssetGraphNode[];
  edges: readonly AssetGraphEdge[];
  selectedId: AssetGraphNodeId | null;
  selectedDetail?: AssetGraphDetail | null;
  mode: "exam" | "study";
  onSelect: (id: AssetGraphNodeId) => void;
  onExpand?: (id: AssetGraphNodeId) => void;
  layoutKey: string;
  /** Isolated by userId:workspaceId:contextKey (undefined disables localStorage persistence). */
  persistKey?: string;
  locateRequest?: FreeMapLocateRequest | null;
  onLocateHandled?: (sequence: number) => void;
  highlightedNodeIds?: ReadonlySet<string> | null;
  highlightedEdgeIds?: ReadonlySet<string> | null;
};

const noPoints: readonly MapPoint[] = [];

const toolClass =
  "inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-ctl px-2.5 text-xs font-medium text-text-2 transition hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

function edgeStrokeDasharray(edge: AssetGraphEdge): string | undefined {
  if (edge.knowledgeStatus === "needs_check") return "6 4";
  if (edge.knowledgeStatus === "suggested" || edge.basis === "suggested") return "3 4";
  if (edge.basis === "derived") return "8 4";
  return undefined;
}

function edgeStrokeClass(edge: AssetGraphEdge, fallbackStroke: string): string {
  if (edge.knowledgeStatus === "needs_check") return "stroke-warn";
  if (edge.knowledgeStatus === "suggested" || edge.basis === "suggested") return "stroke-text-3";
  if (edge.knowledgeStatus === "supported") return "stroke-accent";
  return fallbackStroke;
}

/** A remount makes invalidation synchronous: no frame can show the previous scope's nodes. */
export function FreeMapCanvas(props: FreeMapCanvasProps) {
  return (
    <FreeMapCanvasSurface
      key={JSON.stringify([props.layoutKey, props.persistKey ?? null])}
      {...props}
    />
  );
}

function FreeMapCanvasSurface({
  nodes,
  edges,
  selectedId,
  selectedDetail,
  mode,
  onSelect,
  onExpand,
  persistKey,
  locateRequest,
  onLocateHandled,
  highlightedNodeIds,
  highlightedEdgeIds,
}: FreeMapCanvasProps) {
  const [snapshot, setSnapshot] = useState(() => ({
    nodes,
    edges,
    layout: extendFreeMapLayout(emptyFreeMapLayout(), nodes, edges),
  }));
  const restored = useRef<Record<string, MapPoint>>({});
  let layout = snapshot.layout;
  if (snapshot.nodes !== nodes || snapshot.edges !== edges) {
    layout = extendFreeMapLayout(snapshot.layout, nodes, edges, restored.current);
    setSnapshot({ nodes, edges, layout });
  }
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const handledLocate = useRef<{ id: string; sequence: number } | null>(null);
  const prefix = useId().replace(/:/g, "");
  const storageKey = freeMapStorageKey(persistKey);
  const [geometryReady, setGeometryReady] = useState(!storageKey);
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const visible = useMemo(() => freeMapVisibleIds(layout, nodes, folded), [layout, nodes, folded]);
  const points = useMemo(
    () => nodes.filter(node => visible.has(node.id)).map(node => layout.positions[node.id]!),
    [nodes, layout, visible],
  );
  const childParents = useMemo(
    () =>
      new Set(
        Object.entries(layout.parents)
          .filter(([id, parent]) => nodeById.has(id) && parent !== null)
          .map(([, parent]) => parent!),
      ),
    [layout.parents, nodeById],
  );
  const edgeGroups = useMemo(() => {
    const groups = new Map<string, AssetGraphEdge[]>();
    for (const edge of edges) {
      const key = JSON.stringify([edge.from, edge.to].sort());
      groups.set(key, [...(groups.get(key) ?? []), edge]);
    }
    return groups;
  }, [edges]);

  function updateLayout(next: FreeMapLayout) {
    setSnapshot(current => ({ ...current, layout: next }));
  }

  function savePositions(next: FreeMapLayout) {
    if (!storageKey) return;
    const geometry = { ...restored.current, ...next.positions };
    restored.current = geometry;
    if (writeFreeMapStorage(storageKey, geometry)) {
      setStorageNotice(null);
    } else {
      setStorageNotice("位置暂时无法保存在本机；当前画布仍可操作。");
    }
  }

  useEffect(() => {
    if (!storageKey) return;
    const { ok, positions } = readFreeMapStorage(storageKey);
    if (!ok) {
      setStorageNotice("无法读取本机位置，已使用初始布局。");
    }
    restored.current = positions;
    setSnapshot(current => ({
      ...current,
      layout: {
        ...current.layout,
        positions: Object.fromEntries(
          Object.entries(current.layout.positions).map(([id, point]) => [
            id,
            positions[id] ?? point,
          ]),
        ),
      },
    }));
    setGeometryReady(true);
  }, [storageKey]);

  useEffect(() => {
    if (!selectedId) return;
    setFolded(current => {
      const next = new Set(current);
      let parent = layout.parents[selectedId];
      while (parent != null) {
        next.delete(parent);
        parent = layout.parents[parent];
      }
      return next.size === current.size ? current : next;
    });
  }, [selectedId, layout.parents]);

  const gestures = useFreeMapGestures({
    layout,
    points: geometryReady ? points : noPoints,
    initialFocus: selected ? layout.positions[selected.id] : undefined,
    onLayout: updateLayout,
    onSave: savePositions,
    onSelect,
    moveIds: (id, alt) => (solo || alt ? [id] : freeMapDescendants(layout, id)),
  });

  useEffect(() => {
    if (!geometryReady || !locateRequest || !nodeById.has(locateRequest.id)) return;
    if (
      handledLocate.current?.id === locateRequest.id &&
      handledLocate.current.sequence === locateRequest.sequence
    ) {
      return;
    }
    if (!visible.has(locateRequest.id)) {
      setFolded(current => {
        const next = new Set(current);
        let parent = layout.parents[locateRequest.id];
        while (parent != null) {
          next.delete(parent);
          parent = layout.parents[parent];
        }
        return next.size === current.size ? current : next;
      });
      return;
    }
    const canvas = canvasRef.current;
    const target = canvas?.querySelector<SVGGElement>(`[data-free-map-node="${locateRequest.id}"]`);
    if (!target) return;
    handledLocate.current = locateRequest;
    gestures.focus(layout.positions[locateRequest.id]!);
    canvas?.scrollIntoView?.({ block: "nearest" });
    target.focus({ preventScroll: true });
    onLocateHandled?.(locateRequest.sequence);
  }, [geometryReady, locateRequest, nodeById, visible, layout.parents, layout.positions, gestures, onLocateHandled]);

  const hasOffscreenNodes = points.some(point => {
    const x = point.x * gestures.camera.k + gestures.camera.x;
    const y = point.y * gestures.camera.k + gestures.camera.y;
    return (
      x < (MAP_NODE_WIDTH / 2) * gestures.camera.k ||
      x > gestures.size.width - (MAP_NODE_WIDTH / 2) * gestures.camera.k ||
      y < (MAP_NODE_HEIGHT / 2) * gestures.camera.k ||
      y > gestures.size.height - (MAP_NODE_HEIGHT / 2) * gestures.camera.k
    );
  });

  function moveByKey(id: string, key: string, alt: boolean, shift: boolean) {
    const directions: Record<string, MapPoint> = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
    };
    const direction = directions[key]!;
    const step = shift ? 40 : 10;
    const next = moveFreeMapNodes(
      layout,
      alt || solo ? [id] : freeMapDescendants(layout, id),
      { x: direction.x * step, y: direction.y * step },
    );
    updateLayout(next);
    savePositions(next);
  }

  function toggleBranch(id: string) {
    const closing = !folded.has(id);
    setFolded(current => {
      const next = new Set(current);
      if (closing) next.add(id);
      else next.delete(id);
      return next;
    });
    if (
      closing &&
      selectedId &&
      selectedId !== id &&
      freeMapDescendants(layout, id).includes(selectedId)
    ) {
      onSelect(id);
    }
  }

  function restoreLayout() {
    const next = extendFreeMapLayout(emptyFreeMapLayout(), nodes, edges);
    restored.current = {};
    updateLayout(next);
    setFolded(new Set());
    gestures.fit(Object.values(next.positions));
    if (storageKey) {
      if (removeFreeMapStorage(storageKey)) {
        setStorageNotice(null);
      } else {
        setStorageNotice("本机保存的位置未能清除；本次已恢复初始布局。");
      }
    }
  }

  function locateSelected() {
    if (!selected) return;
    setFolded(current => {
      const next = new Set(current);
      let parent = layout.parents[selected.id];
      while (parent != null) {
        next.delete(parent);
        parent = layout.parents[parent];
      }
      return next;
    });
    gestures.focus(layout.positions[selected.id]!);
  }

  return (
    <section
      ref={canvasRef}
      aria-label="可拖动学习地图"
      className="overflow-hidden rounded-tile border border-line bg-surface text-text"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch size={17} aria-hidden="true" className="text-accent" />
          <span>学习地图</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-accent" aria-hidden="true" />
            已佐证 / 已记录
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4 border-t-2 border-dashed border-warn"
              aria-hidden="true"
            />
            待核对
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4 border-t-2 border-dotted border-text-3"
              aria-hidden="true"
            />
            待确认建议
          </span>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-xs text-text-2">
            <input
              type="checkbox"
              checked={solo}
              onChange={event => setSolo(event.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            只移当前节点
          </label>
        </div>
      </header>
      <div className="relative overflow-hidden bg-bg">
        <svg
          ref={gestures.svgRef}
          role="group"
          aria-label={`学习地图：${nodes.length} 个已加载节点，${visible.size} 个可见节点`}
          aria-describedby={`${prefix}-help`}
          tabIndex={0}
          onFocus={event => {
            if (!geometryReady || !(event.target instanceof Element)) return;
            const nodeId = event.target.closest("[data-free-map-focus-node]")
              ?.getAttribute("data-free-map-focus-node");
            const point = nodeId ? layout.positions[nodeId] : undefined;
            if (!point) return;
            const isFold = event.target.closest('[data-map-control="fold"]') !== null;
            const target = isFold ? { x: point.x + 108, y: point.y + 32 } : point;
            const { camera, size } = gestures;
            const x = target.x * camera.k + camera.x;
            const y = target.y * camera.k + camera.y;
            const marginX = isFold ? 20 : MAP_NODE_WIDTH / 2 * camera.k;
            const marginY = isFold ? 20 : MAP_NODE_HEIGHT / 2 * camera.k;
            if (x < marginX || x > size.width - marginX || y < marginY || y > size.height - marginY) {
              gestures.focus(target);
            }
          }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            const directions: Record<string, MapPoint> = {
              ArrowUp: { x: 0, y: 40 },
              ArrowDown: { x: 0, y: -40 },
              ArrowLeft: { x: 40, y: 0 },
              ArrowRight: { x: -40, y: 0 },
            };
            const delta = directions[event.key];
            if (delta) {
              event.preventDefault();
              gestures.pan(delta);
            } else if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              gestures.zoom(1.25);
            } else if (event.key === "-") {
              event.preventDefault();
              gestures.zoom(0.8);
            } else if (event.key === "0") {
              event.preventDefault();
              gestures.fit();
            }
          }}
          className={`block h-[480px] w-full touch-none select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:h-[560px] ${
            gestures.dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
          {...gestures.handlers}
        >
          <defs>
            <pattern id={`${prefix}-dots`} width={18} height={18} patternUnits="userSpaceOnUse">
              <circle cx={1} cy={1} r={0.8} className="fill-line-strong" />
            </pattern>
            <marker
              id={`${prefix}-arrow`}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto"
            >
              <path
                d="M 1 2 L 8 5 L 1 8"
                fill="none"
                stroke="context-stroke"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${prefix}-dots)`} />
          <g transform={`translate(${gestures.camera.x} ${gestures.camera.y}) scale(${gestures.camera.k})`}>
            <g aria-label="真实有向关系" className="pointer-events-none">
              {edges.map(edge => {
                if (!visible.has(edge.from) || !visible.has(edge.to)) return null;
                const from = layout.positions[edge.from];
                const to = layout.positions[edge.to];
                const target = nodeById.get(edge.to);
                if (!from || !to || !target) return null;
                const group = edgeGroups.get(JSON.stringify([edge.from, edge.to].sort()))!;
                const index = group.indexOf(edge);
                const lane = edge.from > edge.to ? group.length - 1 - index : index;
                const curve = curveBetween(from, to, lane, group.length);
                const color = freeMapNodeColor(target, layout.branches[edge.to] ?? 0);
                const active =
                  selectedId === edge.from ||
                  selectedId === edge.to ||
                  Boolean(highlightedEdgeIds?.has(edge.id));
                const dimmed = Boolean(highlightedEdgeIds && !highlightedEdgeIds.has(edge.id));
                const statusBadge = edge.knowledgeStatus
                  ? EDGE_KNOWLEDGE_STATUS_LABELS[edge.knowledgeStatus]
                  : edge.basis === "suggested"
                    ? "待确认建议"
                    : null;
                const label = [
                  RELATION_LABELS[edge.relation],
                  statusBadge,
                  edge.sourceVersion !== undefined ? `第 ${edge.sourceVersion} 版` : null,
                  edge.page !== undefined ? `第 ${edge.page} 页` : null,
                  edge.sharedAttribution ? "跨课共享证据" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const sharedTitle = edge.sharedAttribution
                  ? ` · 跨课共享自「${edge.sharedAttribution.sourceCourseTitle} · ${edge.sharedAttribution.sourceRequirementTitle}」（第 ${edge.sharedAttribution.sourceRequirementRevision} 版）`
                  : "";
                const dash = edgeStrokeDasharray(edge);
                const strokeClass = edgeStrokeClass(edge, color.stroke);

                return (
                  <g
                    key={edge.id}
                    data-free-map-edge={edge.id}
                    data-edge-basis={edge.basis}
                    data-knowledge-status={edge.knowledgeStatus}
                  >
                    <title>
                      {`${nodeById.get(edge.from)?.label ?? edge.from} → ${target.label}：${label}（${describeEdgeStatus(edge)} / ${EDGE_BASIS_LABELS[edge.basis]}）${sharedTitle}`}
                    </title>
                    <path
                      d={curve.d}
                      fill="none"
                      className={`${strokeClass} ${dimmed ? "opacity-25" : active ? "opacity-100" : "opacity-75"}`}
                      strokeWidth={active ? 2.4 : layout.parents[edge.from] === null ? 2.2 : 1.6}
                      strokeLinecap="round"
                      strokeDasharray={dash}
                      markerEnd={`url(#${prefix}-arrow)`}
                    />
                    <text
                      x={curve.label.x}
                      y={curve.label.y}
                      textAnchor="middle"
                      paintOrder="stroke"
                      strokeWidth={5}
                      strokeLinejoin="round"
                      className={`${
                        edge.knowledgeStatus === "needs_check" ? "fill-warn" : "fill-text-2"
                      } stroke-bg text-[11px] font-medium ${dimmed ? "opacity-35" : ""}`}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </g>
            <g aria-label="已加载资产节点">
              {nodes
                .filter(node => visible.has(node.id))
                .map(node => (
                  <FreeMapCanvasNode
                    key={node.id}
                    node={node}
                    layout={layout}
                    selected={selectedId === node.id}
                    selectedDetail={selectedId === node.id ? selectedDetail : null}
                    folded={folded.has(node.id)}
                    hasChildren={childParents.has(node.id)}
                    mode={mode}
                    dimmed={Boolean(highlightedNodeIds && !highlightedNodeIds.has(node.id))}
                    onSelect={() => onSelect(node.id)}
                    onToggle={() => toggleBranch(node.id)}
                    onMove={(key, alt, shift) => moveByKey(node.id, key, alt, shift)}
                  />
                ))}
            </g>
          </g>
        </svg>
        {!nodes.length ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-text-2">
            当前范围还没有已加载节点。请选择范围或加载关联。
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-2 py-1.5">
        <div role="group" aria-label="地图视角" className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={toolClass}
            aria-label="缩小地图"
            onClick={() => gestures.zoom(0.8)}
          >
            <ZoomOut size={17} aria-hidden="true" />
          </button>
          <output
            aria-label="缩放比例"
            className="min-w-10 text-center text-xs tabular-nums text-text-2"
          >
            {Math.round(gestures.camera.k * 100)}%
          </output>
          <button
            type="button"
            className={toolClass}
            aria-label="放大地图"
            onClick={() => gestures.zoom(1.25)}
          >
            <ZoomIn size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={toolClass}
            disabled={!nodes.length}
            onClick={() => gestures.fit()}
          >
            <Expand size={16} aria-hidden="true" />
            适配
          </button>
          <button
            type="button"
            className={toolClass}
            disabled={!gestures.canReturn}
            onClick={gestures.back}
          >
            <Undo2 size={16} aria-hidden="true" />
            返回视角
          </button>
          <button
            type="button"
            className={toolClass}
            disabled={!nodes.length}
            onClick={restoreLayout}
          >
            <RotateCcw size={16} aria-hidden="true" />
            恢复布局
          </button>
        </div>
        <span className="px-2 text-xs text-text-2" aria-live="polite">
          已加载 {nodes.length} · 可见 {visible.size}
        </span>
      </div>
      {hasOffscreenNodes ? (
        <p role="status" className="px-3 pb-2 text-xs text-text-2">
          当前显示局部。拖动画布继续查看，或点“适配”查看全图。
        </p>
      ) : null}
      {selected ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2"
          aria-label="所选节点操作"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={selected.label}>
              {selected.label}
            </p>
            <p className="text-xs text-text-2">
              {freeMapCaption(selected, mode, selectedDetail)}
            </p>
          </div>
          <button
            type="button"
            className={toolClass}
            aria-label="定位所选节点"
            onClick={locateSelected}
          >
            <Focus size={16} aria-hidden="true" />
            定位
          </button>
          {onExpand ? (
            <button
              type="button"
              className={toolClass}
              aria-label="加载所选节点的关联"
              onClick={() => onExpand(selected.id)}
            >
              加载关联
            </button>
          ) : null}
        </div>
      ) : null}
      <details className="border-t border-line px-3 py-2 text-xs text-text-2">
        <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-accent">
          画布操作与关系说明
        </summary>
        <p id={`${prefix}-help`} className="max-w-3xl py-2 leading-relaxed">
          拖节点移动整支（包括暂时收起的内容），Alt 拖动或勾选“只移当前节点”可独移。拖空白平移，按住 Ctrl 或 Command 滚动可在指针处缩放，双指可平移缩放。Tab
          聚焦节点，回车查看；方向键移动，Shift 加速，Alt 独移。聚焦画布空白时，方向键平移，+ / −
          缩放，0 适配。圆钮只收起已加载分支；“加载关联”获取更多内容。实线为已佐证或已记录关系，橙色虚线为待核对，点线为待确认建议。分支配色和拖动分组仅帮助整理，不代表额外的知识关系。
        </p>
      </details>
      {storageNotice ? (
        <p role="status" className="px-3 pb-3 text-xs text-warn">
          {storageNotice}
        </p>
      ) : null}
    </section>
  );
}
