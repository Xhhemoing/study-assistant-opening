import {
  ASSET_GRAPH_DEFAULT_LIMIT,
  ASSET_GRAPH_LENS_RELATIONS,
  parseAssetGraphNodeId,
  type AssetGraphContext,
  type AssetGraphDetail,
  type AssetGraphEdge,
  type AssetGraphLearnerState,
  type AssetGraphLens,
  type AssetGraphNode,
  type AssetGraphNodeId,
  type AssetGraphNodeKind,
  type AssetGraphNodeMeta,
  type AssetGraphPage,
  type AssetGraphRelation,
  type AssetGraphRequirementStatus,
  type AssetGraphRootKind,
} from "@aistudy/contracts";
import {
  AssetGraphRequestError,
  type AssetGraphClient,
  type AssetGraphClientErrorCode,
} from "./asset-graph-client";

export type AssetGraphDirection = "in" | "out" | "both";

export type ExpandedCenterState = {
  direction: AssetGraphDirection;
  relations?: readonly AssetGraphRelation[];
  nodeIds: string[];
  edgeIds: string[];
  nextCursor: string | null;
  completeness: "complete" | "partial";
  warnings: string[];
};

export type PinnedComparisonItem = {
  node: AssetGraphNode;
  detail: AssetGraphDetail | null;
};

export type NodeTraversalLabels = {
  incomingLabel: string;
  outgoingLabel: string;
  handleLabel: string;
  primaryDirection: AssetGraphDirection;
};

export type LastGraphOperation =
  | { op: "roots" }
  | {
      op: "neighbors";
      focus: AssetGraphNodeId;
      direction: AssetGraphDirection;
      relations?: readonly AssetGraphRelation[];
    }
  | { op: "detail"; focus: AssetGraphNodeId };

export type AssetGraphErrorState = {
  code: AssetGraphClientErrorCode;
  message: string;
};

export type AssetGraphState = {
  context: AssetGraphContext;
  lens: AssetGraphLens;
  includeSummary: boolean;
  searchQuery: string;
  selectedKinds: AssetGraphRootKind[];
  pageLimit: number;
  nodesById: Record<string, AssetGraphNode>;
  edgesById: Record<string, AssetGraphEdge>;
  rootIds: string[];
  rootEdgeIds: string[];
  standaloneNodeIds: string[];
  rootsCursor: string | null;
  rootsCompleteness: "complete" | "partial" | null;
  rootsWarnings: string[];
  expandedCenters: Record<string, ExpandedCenterState>;
  transitionCenter: AssetGraphNode | null;
  selectedNodeId: string | null;
  detail: AssetGraphDetail | null;
  detailCompleteness: "complete" | "partial" | null;
  detailWarnings: string[];
  pinnedComparison: PinnedComparisonItem | null;
  lastFailedOperation: LastGraphOperation | null;
  asOf: string | null;
  notice: string | null;
  error: AssetGraphErrorState | null;
  requestGeneration: number;
  activeRequestSeq: number;
  loadingRoots: boolean;
  loadingMoreRoots: boolean;
  expandingNodeId: string | null;
  loadingDetailNodeId: string | null;
};

export const LENS_LABELS: Record<AssetGraphLens, string> = {
  all: "全部关联",
  structure: "课程结构",
  assets: "材料与笔记",
  evidence: "练习记录",
};

export const NODE_KIND_LABELS: Record<AssetGraphNodeKind, string> = {
  course: "课程",
  goal: "目标",
  requirement: "课程要求",
  knowledge: "知识点",
  source: "学习资料",
  document: "个人笔记",
  exploration: "自由探索",
  observation: "练习记录",
};

export const ROOT_KIND_OPTIONS: readonly AssetGraphRootKind[] = [
  "course",
  "goal",
  "requirement",
  "knowledge",
  "source",
  "document",
  "exploration",
];

export const LEARNER_STATE_LABELS: Record<AssetGraphLearnerState, string> = {
  independent: "独立完成",
  hinted: "提示后完成",
  retest: "待复测",
  insufficient: "记录较少",
};

export const REQUIREMENT_STATUS_LABELS: Record<AssetGraphRequirementStatus, string> = {
  unobserved: "尚无练习记录",
  needs_correction: "待纠错",
  assisted: "曾受助",
  needs_verification: "待独立检验",
  verified: "已达到课程要求",
  blocked: "材料待补齐",
};

export const RELATION_LABELS: Record<AssetGraphRelation, string> = {
  servesGoal: "服务目标",
  scopes: "适用要求",
  mappedTo: "对应知识点",
  usesSource: "参考资料",
  hasObservation: "练习记录",
  promotedTo: "整理为笔记",
  linkedTo: "关联",
  contains: "包含",
  prerequisite: "先修",
  appliesTo: "应用于",
};

export const EDGE_BASIS_LABELS: Record<AssetGraphEdge["basis"], string> = {
  recorded: "已记录",
  derived: "按规则关联",
  suggested: "待确认建议",
};

export const ASSISTANCE_LABELS: Record<NonNullable<AssetGraphNodeMeta["assistance"]>, string> = {
  independent: "独立完成",
  hinted: "提示后完成",
  revealed: "已查看解析",
  unknown: "帮助条件未明",
};

export const KNOWLEDGE_STATUS_LABELS: Record<
  NonNullable<AssetGraphNodeMeta["knowledgeStatus"]>,
  string
> = {
  suggested: "待确认",
  supported: "已有材料依据",
  needs_check: "待进一步确认",
};

export const NOT_FOUND_SAFE_NOTICE = "所选内容不可用或不在当前范围";

export function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Shared resolution of learnerState and requirementStatus:
 * when `detail` is loaded for this item, its values (including explicit `null`) take precedence over `node.summary`.
 */
export function resolveEffectiveNodeStates(
  node: AssetGraphNode | null | undefined,
  detail: AssetGraphDetail | null | undefined,
): {
  hasDetail: boolean;
  learnerState: AssetGraphLearnerState | null | undefined;
  requirementStatus: AssetGraphRequirementStatus | null | undefined;
} {
  if (detail && (!node || detail.id === node.id)) {
    return {
      hasDetail: true,
      learnerState: detail.learnerState,
      requirementStatus: detail.requirementStatus,
    };
  }
  return {
    hasDetail: false,
    learnerState: node?.summary ? node.summary.learnerState : undefined,
    requirementStatus: node?.summary ? node.summary.requirementStatus : undefined,
  };
}

export function getNodeTraversalLabels(
  kind: AssetGraphNodeKind,
  lens: AssetGraphLens,
): NodeTraversalLabels {
  switch (kind) {
    case "goal":
      return {
        incomingLabel: "追溯所属课程",
        outgoingLabel: "查看适用要求",
        handleLabel: "适用要求",
        primaryDirection: "out",
      };
    case "course":
      return {
        incomingLabel: "查看关联资料",
        outgoingLabel: "查看课程目标",
        handleLabel: "课程目标",
        primaryDirection: "out",
      };
    case "requirement": {
      const outgoingLabel =
        lens === "assets"
          ? "查看参考资料"
          : lens === "evidence"
            ? "查看练习记录"
            : lens === "structure"
              ? "查看对应知识点"
              : "查看材料与记录";
      const handleLabel =
        lens === "assets"
          ? "资料"
          : lens === "evidence"
            ? "练习"
            : lens === "structure"
              ? "知识点"
              : "关联";
      return {
        incomingLabel: "追溯所属目标",
        outgoingLabel,
        handleLabel,
        primaryDirection: "out",
      };
    }
    case "document":
      return {
        incomingLabel: "追溯来源",
        outgoingLabel: "查看关联目标",
        handleLabel: "溯源",
        primaryDirection: "in",
      };
    case "source":
      return {
        incomingLabel: "查看引用要求",
        outgoingLabel: "查看关联范围",
        handleLabel: "引用处",
        primaryDirection: "in",
      };
    case "exploration":
      return {
        incomingLabel: "追溯来源内容",
        outgoingLabel: "查看产出笔记",
        handleLabel: "产出笔记",
        primaryDirection: "out",
      };
    case "knowledge":
      return {
        incomingLabel: "追溯先修与要求",
        outgoingLabel: "展开后续知识",
        handleLabel: "延伸",
        primaryDirection: "out",
      };
    case "observation":
      return {
        incomingLabel: "回到对应要求",
        outgoingLabel: "查看延伸关联",
        handleLabel: "对应要求",
        primaryDirection: "in",
      };
  }
}

export function summarizeExpansionForScreenReader(
  nodes: readonly AssetGraphNode[],
  focusId: string,
): string {
  const added = nodes.filter(node => node.id !== focusId);
  if (added.length === 0) return "当前视角下没有新增关联内容";
  const counts = new Map<AssetGraphNodeKind, number>();
  for (const item of added) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(
    ([kind, count]) => `${count} 项${NODE_KIND_LABELS[kind]}`,
  );
  return `已展开 ${parts.join("、")}`;
}

export function isZeroNeighborResult(center: ExpandedCenterState | undefined): boolean {
  return Boolean(
    center &&
      center.edgeIds.length === 0 &&
      center.completeness === "complete" &&
      center.nextCursor === null,
  );
}

export function describeZeroExpansion(
  kind: AssetGraphNodeKind,
  direction: AssetGraphDirection,
  lens: AssetGraphLens,
): string {
  const lensName = LENS_LABELS[lens];
  if (direction === "in") {
    if (kind === "document") {
      return `在「${lensName}」视角下没有找到指向这篇笔记的来源内容；独立笔记本身仍是有效起点。`;
    }
    return `在「${lensName}」视角下暂时没有指向这项${NODE_KIND_LABELS[kind]}的来源内容。`;
  }
  if (direction === "out") {
    return `在「${lensName}」视角下这项${NODE_KIND_LABELS[kind]}暂时没有展开的关联内容。`;
  }
  return `在「${lensName}」视角下这项${NODE_KIND_LABELS[kind]}暂时没有直接相连的内容。`;
}

function stripNodeSummary(node: AssetGraphNode): AssetGraphNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.meta ? { meta: node.meta } : {}),
  };
}

function combineCompleteness(
  previous: "complete" | "partial" | null | undefined,
  incoming: "complete" | "partial",
  append: boolean,
): "complete" | "partial" {
  if (append && previous === "partial") return "partial";
  return incoming;
}

export function createInitialAssetGraphState(options?: {
  context?: AssetGraphContext;
  lens?: AssetGraphLens;
  includeSummary?: boolean;
  searchQuery?: string;
  selectedKinds?: readonly AssetGraphRootKind[];
  pageLimit?: number;
  selectedNodeId?: string | null;
}): AssetGraphState {
  return {
    context: options?.context ?? { kind: "workspace" },
    lens: options?.lens ?? "all",
    includeSummary: options?.includeSummary ?? false,
    searchQuery: options?.searchQuery ?? "",
    selectedKinds: options?.selectedKinds ? [...options.selectedKinds] : [],
    pageLimit: options?.pageLimit ?? ASSET_GRAPH_DEFAULT_LIMIT,
    nodesById: {},
    edgesById: {},
    rootIds: [],
    rootEdgeIds: [],
    standaloneNodeIds: [],
    rootsCursor: null,
    rootsCompleteness: null,
    rootsWarnings: [],
    expandedCenters: {},
    transitionCenter: null,
    selectedNodeId: options?.selectedNodeId ?? null,
    detail: null,
    detailCompleteness: null,
    detailWarnings: [],
    pinnedComparison: null,
    lastFailedOperation: null,
    asOf: null,
    notice: null,
    error: null,
    requestGeneration: 0,
    activeRequestSeq: 0,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
  };
}

function mergeNodes(
  existing: Record<string, AssetGraphNode>,
  incoming: readonly AssetGraphNode[],
): Record<string, AssetGraphNode> {
  const next: Record<string, AssetGraphNode> = { ...existing };
  for (const node of incoming) {
    const prev = getOwn(next, node.id);
    next[node.id] = prev
      ? {
          ...prev,
          ...node,
          meta: node.meta ?? prev.meta,
          summary: node.summary ?? prev.summary,
        }
      : node;
  }
  return next;
}

function mergeEdges(
  existing: Record<string, AssetGraphEdge>,
  incoming: readonly AssetGraphEdge[],
): Record<string, AssetGraphEdge> {
  const next: Record<string, AssetGraphEdge> = { ...existing };
  for (const edge of incoming) {
    next[edge.id] = edge;
  }
  return next;
}

function uniqueStrings(items: readonly string[]): string[] {
  return [...new Set(items.filter(item => item.trim().length > 0))];
}

function reconcileActiveGraphDictionaries(
  nodesById: Record<string, AssetGraphNode>,
  edgesById: Record<string, AssetGraphEdge>,
  rootIds: readonly string[],
  rootEdgeIds: readonly string[],
  standaloneNodeIds: readonly string[],
  expandedCenters: Record<string, ExpandedCenterState>,
): {
  nodesById: Record<string, AssetGraphNode>;
  edgesById: Record<string, AssetGraphEdge>;
} {
  const activeNodeSet = new Set<string>();
  for (const id of rootIds) activeNodeSet.add(id);
  for (const id of standaloneNodeIds) activeNodeSet.add(id);
  for (const center of Object.values(expandedCenters)) {
    for (const id of center.nodeIds) activeNodeSet.add(id);
  }

  const activeEdgeSet = new Set<string>();
  for (const id of rootEdgeIds) activeEdgeSet.add(id);
  for (const center of Object.values(expandedCenters)) {
    for (const id of center.edgeIds) activeEdgeSet.add(id);
  }

  const nextNodes: Record<string, AssetGraphNode> = {};
  for (const id of activeNodeSet) {
    const node = getOwn(nodesById, id);
    if (node) nextNodes[id] = node;
  }

  const nextEdges: Record<string, AssetGraphEdge> = {};
  for (const id of activeEdgeSet) {
    const edge = getOwn(edgesById, id);
    if (edge && getOwn(nextNodes, edge.from) && getOwn(nextNodes, edge.to)) {
      nextEdges[id] = edge;
    }
  }

  return { nodesById: nextNodes, edgesById: nextEdges };
}

function buildTransitionCenter(state: AssetGraphState): AssetGraphNode | null {
  if (!state.selectedNodeId) return null;
  const current =
    getOwn(state.nodesById, state.selectedNodeId) ??
    (state.transitionCenter?.id === state.selectedNodeId ? state.transitionCenter : undefined);
  if (!current) return null;
  return stripNodeSummary(current);
}

function sanitizePinnedAcrossLens(
  pinned: PinnedComparisonItem | null,
): PinnedComparisonItem | null {
  if (!pinned) return null;
  return {
    node: stripNodeSummary(pinned.node),
    detail: null,
  };
}

function clearGraphCollections(
  state: AssetGraphState,
  options: {
    preserveSelectedNodeId: boolean;
    preserveSameContextHelpers: boolean;
  },
): AssetGraphState {
  const preservedSelected = options.preserveSelectedNodeId ? state.selectedNodeId : null;
  const transitionCenter = options.preserveSameContextHelpers ? buildTransitionCenter(state) : null;

  return {
    ...state,
    nodesById: {},
    edgesById: {},
    rootIds: [],
    rootEdgeIds: [],
    standaloneNodeIds: [],
    rootsCursor: null,
    rootsCompleteness: null,
    rootsWarnings: [],
    expandedCenters: {},
    transitionCenter,
    selectedNodeId: preservedSelected,
    detail: null,
    detailCompleteness: null,
    detailWarnings: [],
    pinnedComparison: options.preserveSameContextHelpers
      ? sanitizePinnedAcrossLens(state.pinnedComparison)
      : null,
    lastFailedOperation: null,
    asOf: null,
    error: null,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
    requestGeneration: state.requestGeneration + 1,
    activeRequestSeq: state.activeRequestSeq + 1,
  };
}

export function bumpRequestGeneration(state: AssetGraphState): AssetGraphState {
  return {
    ...state,
    requestGeneration: state.requestGeneration + 1,
    activeRequestSeq: state.activeRequestSeq + 1,
  };
}

export function isCurrentGeneration(state: AssetGraphState, generation: number): boolean {
  return state.requestGeneration === generation;
}

export function switchContext(
  state: AssetGraphState,
  context: AssetGraphContext,
  options?: { preserveFocusId?: string | null },
): AssetGraphState {
  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: false,
    preserveSameContextHelpers: false,
  });
  return {
    ...cleared,
    context,
    selectedNodeId: options?.preserveFocusId ?? (context.kind === "workspace" ? null : context.id),
    notice: null,
  };
}

export function switchLens(state: AssetGraphState, lens: AssetGraphLens): AssetGraphState {
  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: true,
    preserveSameContextHelpers: true,
  });
  return {
    ...cleared,
    lens,
    notice: null,
  };
}

export function updateRootsFilters(
  state: AssetGraphState,
  patch: {
    searchQuery?: string;
    selectedKinds?: readonly AssetGraphRootKind[];
    pageLimit?: number;
    includeSummary?: boolean;
  },
): AssetGraphState {
  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: false,
    preserveSameContextHelpers: false,
  });
  return {
    ...cleared,
    searchQuery: patch.searchQuery ?? state.searchQuery,
    selectedKinds: patch.selectedKinds ? [...patch.selectedKinds] : state.selectedKinds,
    pageLimit: patch.pageLimit ?? state.pageLimit,
    includeSummary: patch.includeSummary ?? state.includeSummary,
    notice: null,
  };
}

export function toggleIncludeSummaryKeepFocus(
  state: AssetGraphState,
  includeSummary: boolean,
): AssetGraphState {
  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: true,
    preserveSameContextHelpers: true,
  });
  return {
    ...cleared,
    includeSummary,
    notice: null,
  };
}

export type ExpandNodeResult =
  | {
      applied: true;
      focusId: AssetGraphNodeId;
      direction: AssetGraphDirection;
      addedNodes: AssetGraphNode[];
      addedCount: number;
      announcement: string;
    }
  | {
      applied: false;
      reason: "aborted" | "superseded" | "not_found" | "error";
    };

export function applyCursorStaleReset(
  state: AssetGraphState,
  notice = "当前内容列表已更新，已从第 1 页重新读取。",
  retryTarget?: LastGraphOperation,
): AssetGraphState {
  if (retryTarget?.op === "neighbors") {
    const focusId = retryTarget.focus;
    const evicted = getOwn(state.expandedCenters, focusId);
    const nextExpanded: Record<string, ExpandedCenterState> = {};
    for (const [key, center] of Object.entries(state.expandedCenters)) {
      if (key !== focusId) {
        nextExpanded[key] = center;
      }
    }

    const stillAnchored = new Set<string>(state.rootIds);
    for (const center of Object.values(nextExpanded)) {
      for (const id of center.nodeIds) {
        stillAnchored.add(id);
      }
    }

    const evictedChildren = new Set(evicted ? evicted.nodeIds.filter(id => id !== focusId) : []);
    const focusExists = Boolean(getOwn(state.nodesById, focusId));
    const nextStandaloneIds = uniqueStrings([
      ...(focusExists && !stillAnchored.has(focusId) ? [focusId] : []),
      ...state.standaloneNodeIds.filter(id => !evictedChildren.has(id) || stillAnchored.has(id)),
    ]);

    const reconciled = reconcileActiveGraphDictionaries(
      state.nodesById,
      state.edgesById,
      state.rootIds,
      state.rootEdgeIds,
      nextStandaloneIds,
      nextExpanded,
    );

    const keepDetail = state.detail !== null && state.detail.id === focusId;
    const updatedPinned =
      state.pinnedComparison && getOwn(reconciled.nodesById, state.pinnedComparison.node.id)
        ? state.pinnedComparison
        : null;

    return {
      ...state,
      nodesById: reconciled.nodesById,
      edgesById: reconciled.edgesById,
      standaloneNodeIds: nextStandaloneIds,
      expandedCenters: nextExpanded,
      transitionCenter: null,
      selectedNodeId: focusId,
      detail: keepDetail ? state.detail : null,
      detailCompleteness: keepDetail ? state.detailCompleteness : null,
      detailWarnings: keepDetail ? state.detailWarnings : [],
      pinnedComparison: updatedPinned,
      lastFailedOperation: null,
      notice,
      error: null,
      loadingRoots: false,
      loadingMoreRoots: false,
      expandingNodeId: null,
      loadingDetailNodeId: null,
      requestGeneration: state.requestGeneration + 1,
      activeRequestSeq: state.activeRequestSeq + 1,
    };
  }

  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: false,
    preserveSameContextHelpers: false,
  });
  return {
    ...cleared,
    notice,
  };
}

export function applyPrivacyInvalidationReset(
  state: AssetGraphState,
  notice = "可见范围设置已变更，已清空旧视图并重新读取。",
): AssetGraphState {
  const cleared = clearGraphCollections(state, {
    preserveSelectedNodeId: false,
    preserveSameContextHelpers: false,
  });
  return {
    ...cleared,
    notice,
  };
}

export function applyRootsPage(
  state: AssetGraphState,
  page: AssetGraphPage,
  options: { append: boolean; generation: number; requestSeq?: number },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  if (options.requestSeq !== undefined && state.activeRequestSeq !== options.requestSeq) {
    return state;
  }

  const pageNodeIds = page.nodes.map(node => node.id);
  const pageEdgeIds = page.edges.map(edge => edge.id);
  const nextRootIds = options.append
    ? uniqueStrings([...state.rootIds, ...pageNodeIds])
    : pageNodeIds;
  const nextRootEdgeIds = options.append
    ? uniqueStrings([...state.rootEdgeIds, ...pageEdgeIds])
    : pageEdgeIds;

  const mergedNodes = mergeNodes(state.nodesById, page.nodes);
  const mergedEdges = mergeEdges(state.edgesById, page.edges);
  const reconciled = reconcileActiveGraphDictionaries(
    mergedNodes,
    mergedEdges,
    nextRootIds,
    nextRootEdgeIds,
    state.standaloneNodeIds,
    state.expandedCenters,
  );

  return {
    ...state,
    nodesById: reconciled.nodesById,
    edgesById: reconciled.edgesById,
    rootIds: nextRootIds,
    rootEdgeIds: nextRootEdgeIds,
    rootsCursor: page.page.nextCursor,
    rootsCompleteness: combineCompleteness(
      state.rootsCompleteness,
      page.completeness,
      options.append,
    ),
    rootsWarnings: options.append
      ? uniqueStrings([...state.rootsWarnings, ...page.warnings])
      : uniqueStrings(page.warnings),
    transitionCenter: null,
    lastFailedOperation: null,
    asOf: page.asOf,
    error: null,
    loadingRoots: false,
    loadingMoreRoots: false,
  };
}

export function applyNeighborsPage(
  state: AssetGraphState,
  page: AssetGraphPage,
  options: {
    focus: AssetGraphNodeId;
    direction: AssetGraphDirection;
    relations?: readonly AssetGraphRelation[];
    append: boolean;
    generation: number;
    requestSeq?: number;
  },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  if (options.requestSeq !== undefined && state.activeRequestSeq !== options.requestSeq) {
    return state;
  }

  const previousCenter = getOwn(state.expandedCenters, options.focus);
  const pageNodeIds = page.nodes.map(node => node.id);
  const pageEdgeIds = page.edges.map(edge => edge.id);

  const nextNodeIds =
    options.append && previousCenter
      ? uniqueStrings([...previousCenter.nodeIds, ...pageNodeIds])
      : pageNodeIds;
  const nextEdgeIds =
    options.append && previousCenter
      ? uniqueStrings([...previousCenter.edgeIds, ...pageEdgeIds])
      : pageEdgeIds;
  const nextWarnings =
    options.append && previousCenter
      ? uniqueStrings([...previousCenter.warnings, ...page.warnings])
      : uniqueStrings(page.warnings);

  const nextExpanded: Record<string, ExpandedCenterState> = {
    ...state.expandedCenters,
    [options.focus]: {
      direction: options.direction,
      relations: options.relations,
      nodeIds: nextNodeIds,
      edgeIds: nextEdgeIds,
      nextCursor: page.page.nextCursor,
      completeness: combineCompleteness(
        previousCenter?.completeness,
        page.completeness,
        options.append,
      ),
      warnings: nextWarnings,
    },
  };

  const mergedNodes = mergeNodes(state.nodesById, page.nodes);
  const mergedEdges = mergeEdges(state.edgesById, page.edges);
  const reconciled = reconcileActiveGraphDictionaries(
    mergedNodes,
    mergedEdges,
    state.rootIds,
    state.rootEdgeIds,
    state.standaloneNodeIds,
    nextExpanded,
  );

  const updatedPinnedNode = state.pinnedComparison
    ? getOwn(reconciled.nodesById, state.pinnedComparison.node.id)
    : undefined;

  return {
    ...state,
    nodesById: reconciled.nodesById,
    edgesById: reconciled.edgesById,
    expandedCenters: nextExpanded,
    transitionCenter: null,
    pinnedComparison:
      state.pinnedComparison && updatedPinnedNode
        ? {
            ...state.pinnedComparison,
            node: updatedPinnedNode,
          }
        : state.pinnedComparison,
    lastFailedOperation: null,
    asOf: page.asOf,
    error: null,
    expandingNodeId: null,
  };
}

export function applyDetailPage(
  state: AssetGraphState,
  page: AssetGraphPage,
  options: { generation: number; requestSeq?: number },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  if (options.requestSeq !== undefined && state.activeRequestSeq !== options.requestSeq) {
    return state;
  }

  const focusId = page.detail?.id ?? page.nodes[0]?.id ?? state.selectedNodeId;
  const nextStandaloneIds = uniqueStrings([
    ...state.standaloneNodeIds,
    ...page.nodes.map(node => node.id),
  ]);
  const mergedNodes = mergeNodes(state.nodesById, page.nodes);
  const mergedEdges = mergeEdges(state.edgesById, page.edges);
  const reconciled = reconcileActiveGraphDictionaries(
    mergedNodes,
    mergedEdges,
    state.rootIds,
    state.rootEdgeIds,
    nextStandaloneIds,
    state.expandedCenters,
  );

  const updatedPinned =
    state.pinnedComparison && focusId && state.pinnedComparison.node.id === focusId
      ? {
          node: getOwn(reconciled.nodesById, focusId) ?? state.pinnedComparison.node,
          detail: page.detail,
        }
      : state.pinnedComparison;

  return {
    ...state,
    nodesById: reconciled.nodesById,
    edgesById: reconciled.edgesById,
    standaloneNodeIds: nextStandaloneIds,
    transitionCenter: null,
    selectedNodeId: focusId,
    detail: page.detail,
    detailCompleteness: page.completeness,
    detailWarnings: uniqueStrings(page.warnings),
    pinnedComparison: updatedPinned,
    lastFailedOperation: null,
    asOf: page.asOf,
    error: null,
    loadingDetailNodeId: null,
  };
}

export function selectNodeFocus(state: AssetGraphState, nodeId: string | null): AssetGraphState {
  if (nodeId === state.selectedNodeId) {
    return state;
  }
  const keepDetail = state.detail?.id === nodeId;
  return {
    ...state,
    selectedNodeId: nodeId,
    detail: keepDetail ? state.detail : null,
    detailCompleteness: keepDetail ? state.detailCompleteness : null,
    detailWarnings: keepDetail ? state.detailWarnings : [],
    transitionCenter: null,
    notice: null,
    error: null,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
    activeRequestSeq: state.activeRequestSeq + 1,
  };
}

export function collapseExpandedNode(
  state: AssetGraphState,
  focusId: AssetGraphNodeId,
): AssetGraphState {
  const evicted = getOwn(state.expandedCenters, focusId);
  if (!evicted) return state;

  const nextExpanded: Record<string, ExpandedCenterState> = {};
  for (const [key, center] of Object.entries(state.expandedCenters)) {
    if (key !== focusId) {
      nextExpanded[key] = center;
    }
  }

  const stillAnchored = new Set<string>(state.rootIds);
  for (const center of Object.values(nextExpanded)) {
    for (const id of center.nodeIds) {
      stillAnchored.add(id);
    }
  }

  const evictedChildren = new Set(evicted.nodeIds.filter(id => id !== focusId));
  const nextStandaloneIds = uniqueStrings([
    ...(stillAnchored.has(focusId) ? [] : [focusId]),
    ...state.standaloneNodeIds.filter(id => !evictedChildren.has(id) || stillAnchored.has(id)),
  ]);

  const reconciled = reconcileActiveGraphDictionaries(
    state.nodesById,
    state.edgesById,
    state.rootIds,
    state.rootEdgeIds,
    nextStandaloneIds,
    nextExpanded,
  );

  const selectedWasCollapsedLeaf =
    state.selectedNodeId !== null &&
    state.selectedNodeId !== focusId &&
    !getOwn(reconciled.nodesById, state.selectedNodeId);

  const nextSelectedId = selectedWasCollapsedLeaf ? focusId : state.selectedNodeId;
  const keepDetail = state.detail !== null && state.detail.id === nextSelectedId;

  return {
    ...state,
    nodesById: reconciled.nodesById,
    edgesById: reconciled.edgesById,
    standaloneNodeIds: nextStandaloneIds,
    expandedCenters: nextExpanded,
    selectedNodeId: nextSelectedId,
    detail: keepDetail ? state.detail : null,
    detailCompleteness: keepDetail ? state.detailCompleteness : null,
    detailWarnings: keepDetail ? state.detailWarnings : [],
    expandingNodeId: state.expandingNodeId === focusId ? null : state.expandingNodeId,
  };
}

export function togglePinnedComparison(
  state: AssetGraphState,
  nodeId: string,
): AssetGraphState {
  if (state.pinnedComparison?.node.id === nodeId) {
    return {
      ...state,
      pinnedComparison: null,
    };
  }
  const targetNode = getOwn(state.nodesById, nodeId);
  if (!targetNode) return state;
  return {
    ...state,
    pinnedComparison: {
      node: targetNode,
      detail: state.detail?.id === nodeId ? state.detail : null,
    },
  };
}

export function applyNotFoundForFocus(
  state: AssetGraphState,
  focusId: string,
  options?: { generation?: number; requestSeq?: number; message?: string },
): AssetGraphState {
  if (options?.generation !== undefined && !isCurrentGeneration(state, options.generation)) {
    return state;
  }
  if (options?.requestSeq !== undefined && state.activeRequestSeq !== options.requestSeq) {
    return state;
  }

  const evictedCenter = getOwn(state.expandedCenters, focusId);
  const survivingNeighborNodeIds = evictedCenter
    ? evictedCenter.nodeIds.filter(id => id !== focusId)
    : [];

  const nextNodes: Record<string, AssetGraphNode> = {};
  for (const key of Object.keys(state.nodesById)) {
    if (key !== focusId) nextNodes[key] = state.nodesById[key]!;
  }

  const nextEdges: Record<string, AssetGraphEdge> = {};
  for (const [edgeId, edge] of Object.entries(state.edgesById)) {
    if (edge.from !== focusId && edge.to !== focusId) {
      nextEdges[edgeId] = edge;
    }
  }

  const nextExpanded: Record<string, ExpandedCenterState> = {};
  for (const [centerId, center] of Object.entries(state.expandedCenters)) {
    if (centerId === focusId) continue;
    nextExpanded[centerId] = {
      ...center,
      nodeIds: center.nodeIds.filter(id => id !== focusId),
      edgeIds: center.edgeIds.filter(id => Boolean(getOwn(nextEdges, id))),
    };
  }

  const nextStandaloneIds = uniqueStrings([
    ...state.standaloneNodeIds.filter(id => id !== focusId),
    ...survivingNeighborNodeIds,
  ]);
  const nextRootIds = state.rootIds.filter(id => id !== focusId);
  const nextRootEdgeIds = state.rootEdgeIds.filter(id => Boolean(getOwn(nextEdges, id)));

  const reconciled = reconcileActiveGraphDictionaries(
    nextNodes,
    nextEdges,
    nextRootIds,
    nextRootEdgeIds,
    nextStandaloneIds,
    nextExpanded,
  );

  const isSelectedEvicted = state.selectedNodeId === focusId;
  const isDetailEvicted = state.detail?.id === focusId;

  return {
    ...state,
    nodesById: reconciled.nodesById,
    edgesById: reconciled.edgesById,
    rootIds: nextRootIds,
    rootEdgeIds: nextRootEdgeIds,
    standaloneNodeIds: nextStandaloneIds,
    expandedCenters: nextExpanded,
    transitionCenter: state.transitionCenter?.id === focusId ? null : state.transitionCenter,
    selectedNodeId: isSelectedEvicted ? null : state.selectedNodeId,
    detail: isDetailEvicted ? null : state.detail,
    detailCompleteness: isDetailEvicted ? null : state.detailCompleteness,
    detailWarnings: isDetailEvicted ? [] : state.detailWarnings,
    pinnedComparison:
      state.pinnedComparison?.node.id === focusId ? null : state.pinnedComparison,
    lastFailedOperation: null,
    notice: NOT_FOUND_SAFE_NOTICE,
    error: null,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
  };
}

export function applyRequestError(
  state: AssetGraphState,
  error: unknown,
  options: {
    generation: number;
    requestSeq?: number;
    failedOperation?: LastGraphOperation;
    fallbackMessage?: string;
  },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  if (options.requestSeq !== undefined && state.activeRequestSeq !== options.requestSeq) {
    return state;
  }

  const formatted = formatAssetGraphError(error, options.fallbackMessage);
  const shouldClearPrivateView =
    formatted.code === "UNAUTHENTICATED" ||
    formatted.code === "FORBIDDEN" ||
    formatted.code === "WORKSPACE_FORBIDDEN";
  const base = shouldClearPrivateView
    ? clearGraphCollections(state, {
        preserveSelectedNodeId: false,
        preserveSameContextHelpers: false,
      })
    : state;

  return {
    ...base,
    transitionCenter: null,
    lastFailedOperation: shouldClearPrivateView ? null : (options.failedOperation ?? null),
    error: formatted,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
  };
}

export function formatAssetGraphError(
  error: unknown,
  fallbackMessage = "知识地图暂时无法读取，请稍后重试。",
): AssetGraphErrorState {
  if (error instanceof AssetGraphRequestError) {
    if (error.code === "NOT_FOUND") {
      return { code: error.code, message: NOT_FOUND_SAFE_NOTICE };
    }
    return {
      code: error.code,
      message: error.message || fallbackMessage,
    };
  }
  return { code: "NETWORK", message: fallbackMessage };
}

export function isGraphPartial(state: AssetGraphState): boolean {
  if (state.rootsCompleteness === "partial") return true;
  if (state.detailCompleteness === "partial") return true;
  return Object.values(state.expandedCenters).some(entry => entry.completeness === "partial");
}

export function collectGraphWarnings(state: AssetGraphState): string[] {
  return uniqueStrings([
    ...state.rootsWarnings,
    ...state.detailWarnings,
    ...Object.values(state.expandedCenters).flatMap(entry => entry.warnings),
  ]);
}

export function getVisibleNodes(state: AssetGraphState): AssetGraphNode[] {
  const orderedIds: string[] = [];
  const seen = new Set<string>();

  for (const id of state.rootIds) {
    if (getOwn(state.nodesById, id) && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  for (const id of Object.keys(state.nodesById)) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  if (orderedIds.length === 0 && state.transitionCenter) {
    return [state.transitionCenter];
  }

  return orderedIds.map(id => state.nodesById[id]!);
}

export function getVisibleEdges(state: AssetGraphState): AssetGraphEdge[] {
  return Object.values(state.edgesById).filter(
    edge => Boolean(getOwn(state.nodesById, edge.from) && getOwn(state.nodesById, edge.to)),
  );
}

export function defaultDirectionForNode(focusId: string): AssetGraphDirection {
  const parsed = parseAssetGraphNodeId(focusId);
  if (!parsed) return "out";
  if (parsed.kind === "source" || parsed.kind === "document" || parsed.kind === "observation") {
    return "in";
  }
  return "out";
}

export function defaultNeighborRelations(
  focusId: string,
  direction: AssetGraphDirection,
  lens: AssetGraphLens,
): AssetGraphRelation[] | undefined {
  const parsed = parseAssetGraphNodeId(focusId);
  const kind = parsed?.kind;
  const allowedByLens = new Set(ASSET_GRAPH_LENS_RELATIONS[lens]);

  if (lens === "evidence") {
    return ["hasObservation"];
  }

  if (!kind) {
    return direction === "both" ? undefined : [...ASSET_GRAPH_LENS_RELATIONS[lens]];
  }

  let candidates: AssetGraphRelation[] | undefined;
  if (direction === "out") {
    switch (kind) {
      case "course":
        candidates = ["servesGoal"];
        break;
      case "goal":
        candidates = ["scopes"];
        break;
      case "requirement":
        candidates =
          lens === "structure"
            ? ["mappedTo"]
            : lens === "assets"
              ? ["usesSource"]
              : ["usesSource", "hasObservation"];
        break;
      case "knowledge":
        candidates = ["contains", "prerequisite", "appliesTo"];
        break;
      case "source":
      case "document":
        candidates = ["linkedTo"];
        break;
      case "exploration":
        candidates = ["promotedTo"];
        break;
      case "observation":
        candidates = undefined;
        break;
    }
  } else if (direction === "in") {
    switch (kind) {
      case "course":
        candidates = ["linkedTo"];
        break;
      case "goal":
        candidates = lens === "assets" ? ["linkedTo"] : ["servesGoal", "linkedTo"];
        break;
      case "requirement":
        candidates =
          lens === "structure"
            ? ["scopes"]
            : lens === "assets"
              ? ["linkedTo"]
              : ["scopes", "linkedTo"];
        break;
      case "knowledge":
        candidates = ["mappedTo", "contains", "prerequisite", "appliesTo"];
        break;
      case "source":
        candidates = ["usesSource"];
        break;
      case "document":
        candidates = ["promotedTo"];
        break;
      case "exploration":
        candidates = undefined;
        break;
      case "observation":
        candidates = ["hasObservation"];
        break;
    }
  }

  if (!candidates) {
    return undefined;
  }

  const filtered = candidates.filter(relation => allowedByLens.has(relation));
  return filtered.length > 0 ? filtered : [...ASSET_GRAPH_LENS_RELATIONS[lens]];
}

export function buildRootsQueryParams(state: AssetGraphState, cursor?: string) {
  const trimmedQ = state.searchQuery.trim();
  const hasFilters = state.selectedKinds.length > 0 || trimmedQ.length > 0;
  const hasCustomLimit = state.pageLimit !== ASSET_GRAPH_DEFAULT_LIMIT;
  const isDefaultBareQuery =
    state.context.kind === "workspace" &&
    state.lens === "all" &&
    !hasFilters &&
    !hasCustomLimit &&
    !state.includeSummary &&
    !cursor;

  return {
    context: state.context,
    lens: state.lens,
    ...(state.selectedKinds.length > 0 ? { kinds: state.selectedKinds } : {}),
    ...(trimmedQ.length > 0 ? { q: trimmedQ } : {}),
    ...(isDefaultBareQuery ? {} : { limit: state.pageLimit }),
    ...(cursor ? { cursor } : {}),
    ...(state.includeSummary ? { include: ["summary"] as ["summary"] } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type AssetGraphStore = ReturnType<typeof createAssetGraphStore>;

/**
 * Framework-free controller coordinating async queries, request generation tokens,
 * AbortController cancellation, single-shot exact-operation cursor-stale recovery,
 * and 404 focus eviction.
 */
export function createAssetGraphStore(
  client: AssetGraphClient,
  initialOptions?: Parameters<typeof createInitialAssetGraphState>[0],
) {
  let state = createInitialAssetGraphState(initialOptions);
  let activeController: AbortController | null = null;
  const listeners = new Set<() => void>();

  function emit(next: AssetGraphState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function startRequest(): { generation: number; requestSeq: number; signal: AbortSignal } {
    activeController?.abort();
    activeController = new AbortController();
    const nextSeq = state.activeRequestSeq + 1;
    state = {
      ...state,
      activeRequestSeq: nextSeq,
      loadingRoots: false,
      loadingMoreRoots: false,
      expandingNodeId: null,
      loadingDetailNodeId: null,
    };
    return {
      generation: state.requestGeneration,
      requestSeq: nextSeq,
      signal: activeController.signal,
    };
  }

  function isActiveRequest(generation: number, requestSeq: number): boolean {
    return isCurrentGeneration(state, generation) && state.activeRequestSeq === requestSeq;
  }

  async function restartAfterCursorStaleRoots() {
    emit(applyCursorStaleReset(state, undefined, { op: "roots" }));
    await loadRoots({ cursor: undefined, allowCursorStaleRestart: false });
  }

  async function restartAfterCursorStaleNeighbors(
    retryTarget: Extract<LastGraphOperation, { op: "neighbors" }>,
  ): Promise<ExpandNodeResult> {
    emit(applyCursorStaleReset(state, undefined, retryTarget));
    return expandNode(retryTarget.focus, retryTarget.direction, {
      relations: retryTarget.relations,
      cursor: undefined,
      allowCursorStaleRestart: false,
    });
  }

  async function loadRoots(options?: {
    cursor?: string;
    append?: boolean;
    allowCursorStaleRestart?: boolean;
  }) {
    const append = options?.append ?? false;
    const allowRestart = options?.allowCursorStaleRestart ?? true;
    const { generation, requestSeq, signal } = startRequest();

    emit({
      ...state,
      error: null,
      loadingRoots: !append,
      loadingMoreRoots: append,
    });

    try {
      const page = await client.roots(buildRootsQueryParams(state, options?.cursor), signal);
      if (!isActiveRequest(generation, requestSeq)) return;
      emit(applyRootsPage(state, page, { append, generation, requestSeq }));
    } catch (error) {
      if (isAbortError(error) || !isActiveRequest(generation, requestSeq)) return;
      if (error instanceof AssetGraphRequestError && error.code === "CURSOR_STALE" && allowRestart) {
        await restartAfterCursorStaleRoots();
        return;
      }
      emit(
        applyRequestError(state, error, {
          generation,
          requestSeq,
          failedOperation: { op: "roots" },
        }),
      );
    }
  }

  async function loadMoreRoots() {
    if (!state.rootsCursor || state.loadingRoots || state.loadingMoreRoots) return;
    await loadRoots({ cursor: state.rootsCursor, append: true });
  }

  async function expandNode(
    focusId: AssetGraphNodeId,
    direction: AssetGraphDirection,
    options?: {
      relations?: readonly AssetGraphRelation[];
      cursor?: string;
      append?: boolean;
      allowCursorStaleRestart?: boolean;
    },
  ): Promise<ExpandNodeResult> {
    const append = options?.append ?? false;
    const allowRestart = options?.allowCursorStaleRestart ?? true;
    const relations = options?.relations ?? defaultNeighborRelations(focusId, direction, state.lens);
    const { generation, requestSeq, signal } = startRequest();

    const keepDetail = state.detail?.id === focusId;
    emit({
      ...state,
      error: null,
      selectedNodeId: focusId,
      detail: keepDetail ? state.detail : null,
      detailCompleteness: keepDetail ? state.detailCompleteness : null,
      detailWarnings: keepDetail ? state.detailWarnings : [],
      expandingNodeId: focusId,
    });

    try {
      const page = await client.neighbors(
        {
          context: state.context,
          lens: state.lens,
          focus: focusId,
          direction,
          ...(relations && relations.length > 0 ? { relations: [...relations] } : {}),
          limit: state.pageLimit,
          ...(options?.cursor ? { cursor: options.cursor } : {}),
          ...(state.includeSummary ? { include: ["summary"] as ["summary"] } : {}),
        },
        signal,
      );
      if (!isActiveRequest(generation, requestSeq)) {
        return { applied: false, reason: "superseded" };
      }
      emit(
        applyNeighborsPage(state, page, {
          focus: focusId,
          direction,
          relations,
          append,
          generation,
          requestSeq,
        }),
      );
      const appliedNodes = page.nodes
        .map(item => getOwn(state.nodesById, item.id) ?? item)
        .filter(node => node.id !== focusId);
      const focusNodeItem = getOwn(state.nodesById, focusId);
      return {
        applied: true,
        focusId,
        direction,
        addedNodes: appliedNodes,
        addedCount: appliedNodes.length,
        announcement: summarizeExpansionForScreenReader(
          focusNodeItem ? [focusNodeItem, ...appliedNodes] : appliedNodes,
          focusId,
        ),
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { applied: false, reason: "aborted" };
      }
      if (!isActiveRequest(generation, requestSeq)) {
        return { applied: false, reason: "superseded" };
      }
      if (error instanceof AssetGraphRequestError && error.code === "NOT_FOUND") {
        emit(applyNotFoundForFocus(state, focusId, { generation, requestSeq }));
        return { applied: false, reason: "not_found" };
      }
      if (error instanceof AssetGraphRequestError && error.code === "CURSOR_STALE" && allowRestart) {
        return restartAfterCursorStaleNeighbors({
          op: "neighbors",
          focus: focusId,
          direction,
          relations,
        });
      }
      emit(
        applyRequestError(state, error, {
          generation,
          requestSeq,
          failedOperation: { op: "neighbors", focus: focusId, direction, relations },
        }),
      );
      return { applied: false, reason: "error" };
    }
  }

  async function loadMoreNeighbors(focusId: AssetGraphNodeId): Promise<ExpandNodeResult> {
    const center = getOwn(state.expandedCenters, focusId);
    if (!center?.nextCursor || state.expandingNodeId) {
      return { applied: false, reason: "superseded" };
    }
    return expandNode(focusId, center.direction, {
      relations: center.relations,
      cursor: center.nextCursor,
      append: true,
    });
  }

  async function loadDetail(focusId: AssetGraphNodeId) {
    const { generation, requestSeq, signal } = startRequest();
    const keepDetail = state.detail?.id === focusId;
    emit({
      ...state,
      error: null,
      selectedNodeId: focusId,
      detail: keepDetail ? state.detail : null,
      detailCompleteness: keepDetail ? state.detailCompleteness : null,
      detailWarnings: keepDetail ? state.detailWarnings : [],
      loadingDetailNodeId: focusId,
    });

    try {
      const page = await client.detail(
        {
          context: state.context,
          lens: state.lens,
          focus: focusId,
        },
        signal,
      );
      if (!isActiveRequest(generation, requestSeq)) return;
      emit(applyDetailPage(state, page, { generation, requestSeq }));
    } catch (error) {
      if (isAbortError(error) || !isActiveRequest(generation, requestSeq)) return;
      if (error instanceof AssetGraphRequestError && error.code === "NOT_FOUND") {
        emit(applyNotFoundForFocus(state, focusId, { generation, requestSeq }));
        return;
      }
      emit(
        applyRequestError(state, error, {
          generation,
          requestSeq,
          failedOperation: { op: "detail", focus: focusId },
        }),
      );
    }
  }

  async function selectContext(context: AssetGraphContext, preserveFocusId?: string | null) {
    activeController?.abort();
    emit(switchContext(state, context, { preserveFocusId }));
    if (context.kind === "goal") {
      await expandNode(context.id, "out", {
        relations: defaultNeighborRelations(context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  async function selectLens(lens: AssetGraphLens) {
    const previousExpanded = state.expandedCenters;
    const preservedFocus = state.selectedNodeId;
    activeController?.abort();
    emit(switchLens(state, lens));

    if (preservedFocus) {
      const direction =
        getOwn(previousExpanded, preservedFocus)?.direction ??
        defaultDirectionForNode(preservedFocus);
      await expandNode(preservedFocus, direction, {
        relations: defaultNeighborRelations(preservedFocus, direction, lens),
      });
      return;
    }
    if (state.context.kind === "goal") {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", lens),
      });
      return;
    }
    await loadRoots();
  }

  async function applyFilters(patch: Parameters<typeof updateRootsFilters>[1]) {
    activeController?.abort();
    emit(updateRootsFilters(state, patch));
    await loadRoots();
  }

  async function setIncludeSummary(includeSummary: boolean) {
    const previousExpanded = state.expandedCenters;
    const preservedFocus = state.selectedNodeId;
    activeController?.abort();
    emit(toggleIncludeSummaryKeepFocus(state, includeSummary));

    if (preservedFocus) {
      const direction =
        getOwn(previousExpanded, preservedFocus)?.direction ??
        defaultDirectionForNode(preservedFocus);
      await expandNode(preservedFocus, direction, {
        relations:
          getOwn(previousExpanded, preservedFocus)?.relations ??
          defaultNeighborRelations(preservedFocus, direction, state.lens),
      });
      return;
    }
    if (state.context.kind === "goal") {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  async function initialize(initialFocus?: AssetGraphNodeId | null) {
    if (initialFocus) {
      await loadDetail(initialFocus);
      return;
    }
    if (state.context.kind === "goal") {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  async function invalidateByPrivacy() {
    activeController?.abort();
    emit(applyPrivacyInvalidationReset(state));
    if (state.context.kind === "goal") {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  async function retryCurrentView() {
    if (state.lastFailedOperation) {
      const failed = state.lastFailedOperation;
      if (failed.op === "detail") {
        await loadDetail(failed.focus);
        return;
      }
      if (failed.op === "neighbors") {
        await expandNode(failed.focus, failed.direction, { relations: failed.relations });
        return;
      }
      await loadRoots();
      return;
    }

    const partialCenterEntry = Object.entries(state.expandedCenters).find(
      ([, center]) => center.completeness === "partial",
    );
    if (partialCenterEntry) {
      const [focusId, center] = partialCenterEntry;
      await expandNode(focusId, center.direction, { relations: center.relations });
      return;
    }
    if (state.detailCompleteness === "partial" && state.selectedNodeId) {
      await loadDetail(state.selectedNodeId);
      return;
    }
    if (
      state.context.kind === "goal" &&
      state.rootIds.length === 0 &&
      state.rootsCompleteness === null &&
      !state.searchQuery.trim() &&
      state.selectedKinds.length === 0
    ) {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  function focusNode(nodeId: string | null) {
    if (nodeId === state.selectedNodeId) return;
    activeController?.abort();
    const wasTransitionOnly =
      state.transitionCenter !== null && Object.keys(state.nodesById).length === 0;
    emit(selectNodeFocus(state, nodeId));
    if (wasTransitionOnly && nodeId === null) {
      if (state.context.kind === "goal") {
        void expandNode(state.context.id, "out", {
          relations: defaultNeighborRelations(state.context.id, "out", state.lens),
        });
      } else {
        void loadRoots();
      }
    }
  }

  function collapseNode(focusId: AssetGraphNodeId) {
    if (!getOwn(state.expandedCenters, focusId) && state.expandingNodeId !== focusId) {
      return;
    }
    if (state.expandingNodeId === focusId) {
      activeController?.abort();
      state = {
        ...state,
        activeRequestSeq: state.activeRequestSeq + 1,
        expandingNodeId: null,
      };
    }
    emit(collapseExpandedNode(state, focusId));
  }

  function togglePinNode(nodeId: string) {
    emit(togglePinnedComparison(state, nodeId));
  }

  function clearPinnedNode() {
    if (!state.pinnedComparison) return;
    emit({ ...state, pinnedComparison: null });
  }

  function clearNotice() {
    if (!state.notice) return;
    emit({ ...state, notice: null });
  }

  function dispose() {
    activeController?.abort();
    activeController = null;
    emit(bumpRequestGeneration(state));
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize,
    loadRoots,
    loadMoreRoots,
    expandNode,
    loadMoreNeighbors,
    loadDetail,
    selectContext,
    selectLens,
    applyFilters,
    setIncludeSummary,
    invalidateByPrivacy,
    retryCurrentView,
    focusNode,
    collapseNode,
    togglePinNode,
    clearPinnedNode,
    clearNotice,
    dispose,
  };
}
