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
  nextCursor: string | null;
  completeness: "complete" | "partial";
  warnings: string[];
};

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
  rootsCursor: string | null;
  rootsCompleteness: "complete" | "partial" | null;
  rootsWarnings: string[];
  expandedCenters: Record<string, ExpandedCenterState>;
  selectedNodeId: string | null;
  detail: AssetGraphDetail | null;
  asOf: string | null;
  notice: string | null;
  error: AssetGraphErrorState | null;
  requestGeneration: number;
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
    rootsCursor: null,
    rootsCompleteness: null,
    rootsWarnings: [],
    expandedCenters: {},
    selectedNodeId: options?.selectedNodeId ?? null,
    detail: null,
    asOf: null,
    notice: null,
    error: null,
    requestGeneration: 0,
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
    const prev = next[node.id];
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

function clearGraphCollections(
  state: AssetGraphState,
  options: { preserveSelectedNodeId: boolean },
): AssetGraphState {
  return {
    ...state,
    nodesById: {},
    edgesById: {},
    rootIds: [],
    rootsCursor: null,
    rootsCompleteness: null,
    rootsWarnings: [],
    expandedCenters: {},
    selectedNodeId: options.preserveSelectedNodeId ? state.selectedNodeId : null,
    detail: null,
    asOf: null,
    error: null,
    loadingRoots: false,
    loadingMoreRoots: false,
    expandingNodeId: null,
    loadingDetailNodeId: null,
    requestGeneration: state.requestGeneration + 1,
  };
}

export function bumpRequestGeneration(state: AssetGraphState): AssetGraphState {
  return {
    ...state,
    requestGeneration: state.requestGeneration + 1,
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
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: false });
  return {
    ...cleared,
    context,
    selectedNodeId: options?.preserveFocusId ?? (context.kind === "workspace" ? null : context.id),
    notice: null,
  };
}

export function switchLens(state: AssetGraphState, lens: AssetGraphLens): AssetGraphState {
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: true });
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
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: false });
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
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: true });
  return {
    ...cleared,
    includeSummary,
    notice: null,
  };
}

export function applyCursorStaleReset(
  state: AssetGraphState,
  notice = "当前内容列表已更新，已从第 1 页重新读取。",
): AssetGraphState {
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: false });
  return {
    ...cleared,
    notice,
  };
}

export function applyPrivacyInvalidationReset(
  state: AssetGraphState,
  notice = "可见范围设置已变更，已清空旧视图并重新读取。",
): AssetGraphState {
  const cleared = clearGraphCollections(state, { preserveSelectedNodeId: false });
  return {
    ...cleared,
    notice,
  };
}

export function applyRootsPage(
  state: AssetGraphState,
  page: AssetGraphPage,
  options: { append: boolean; generation: number },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  const pageNodeIds = page.nodes.map(node => node.id);
  const nextRootIds = options.append
    ? [...new Set([...state.rootIds, ...pageNodeIds])]
    : pageNodeIds;

  return {
    ...state,
    nodesById: mergeNodes(state.nodesById, page.nodes),
    edgesById: mergeEdges(state.edgesById, page.edges),
    rootIds: nextRootIds,
    rootsCursor: page.page.nextCursor,
    rootsCompleteness: page.completeness,
    rootsWarnings: options.append
      ? uniqueStrings([...state.rootsWarnings, ...page.warnings])
      : uniqueStrings(page.warnings),
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
  },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  const previousCenter = state.expandedCenters[options.focus];
  const nextWarnings =
    options.append && previousCenter
      ? uniqueStrings([...previousCenter.warnings, ...page.warnings])
      : uniqueStrings(page.warnings);

  const nextExpanded: Record<string, ExpandedCenterState> = {
    ...state.expandedCenters,
    [options.focus]: {
      direction: options.direction,
      relations: options.relations,
      nextCursor: page.page.nextCursor,
      completeness: page.completeness,
      warnings: nextWarnings,
    },
  };

  return {
    ...state,
    nodesById: mergeNodes(state.nodesById, page.nodes),
    edgesById: mergeEdges(state.edgesById, page.edges),
    expandedCenters: nextExpanded,
    asOf: page.asOf,
    error: null,
    expandingNodeId: state.expandingNodeId === options.focus ? null : state.expandingNodeId,
  };
}

export function applyDetailPage(
  state: AssetGraphState,
  page: AssetGraphPage,
  options: { generation: number },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  const focusId = page.detail?.id ?? page.nodes[0]?.id ?? state.selectedNodeId;
  return {
    ...state,
    nodesById: mergeNodes(state.nodesById, page.nodes),
    edgesById: mergeEdges(state.edgesById, page.edges),
    selectedNodeId: focusId,
    detail: page.detail,
    asOf: page.asOf,
    error: null,
    loadingDetailNodeId: null,
  };
}

export function selectNodeFocus(state: AssetGraphState, nodeId: string | null): AssetGraphState {
  return {
    ...state,
    selectedNodeId: nodeId,
    detail: state.detail?.id === nodeId ? state.detail : null,
    notice: null,
    error: null,
  };
}

export function applyNotFoundForFocus(
  state: AssetGraphState,
  focusId: string,
  options?: { generation?: number; message?: string },
): AssetGraphState {
  if (options?.generation !== undefined && !isCurrentGeneration(state, options.generation)) {
    return state;
  }
  const nextNodes = { ...state.nodesById };
  delete nextNodes[focusId];

  const nextEdges: Record<string, AssetGraphEdge> = {};
  for (const [edgeId, edge] of Object.entries(state.edgesById)) {
    if (edge.from !== focusId && edge.to !== focusId) {
      nextEdges[edgeId] = edge;
    }
  }

  const nextExpanded = { ...state.expandedCenters };
  delete nextExpanded[focusId];

  return {
    ...state,
    nodesById: nextNodes,
    edgesById: nextEdges,
    rootIds: state.rootIds.filter(id => id !== focusId),
    expandedCenters: nextExpanded,
    selectedNodeId: state.selectedNodeId === focusId ? null : state.selectedNodeId,
    detail: state.detail?.id === focusId ? null : state.detail,
    notice: NOT_FOUND_SAFE_NOTICE,
    error: null,
    expandingNodeId: state.expandingNodeId === focusId ? null : state.expandingNodeId,
    loadingDetailNodeId: state.loadingDetailNodeId === focusId ? null : state.loadingDetailNodeId,
  };
}

export function applyRequestError(
  state: AssetGraphState,
  error: unknown,
  options: { generation: number; fallbackMessage?: string },
): AssetGraphState {
  if (!isCurrentGeneration(state, options.generation)) return state;
  const formatted = formatAssetGraphError(error, options.fallbackMessage);
  const shouldClearPrivateView =
    formatted.code === "UNAUTHENTICATED" ||
    formatted.code === "FORBIDDEN" ||
    formatted.code === "WORKSPACE_FORBIDDEN";
  const base = shouldClearPrivateView
    ? clearGraphCollections(state, { preserveSelectedNodeId: false })
    : state;

  return {
    ...base,
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
  return Object.values(state.expandedCenters).some(entry => entry.completeness === "partial");
}

export function collectGraphWarnings(state: AssetGraphState): string[] {
  return uniqueStrings([
    ...state.rootsWarnings,
    ...Object.values(state.expandedCenters).flatMap(entry => entry.warnings),
  ]);
}

export function getVisibleNodes(state: AssetGraphState): AssetGraphNode[] {
  const orderedIds: string[] = [];
  const seen = new Set<string>();

  for (const id of state.rootIds) {
    if (state.nodesById[id] && !seen.has(id)) {
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

  return orderedIds.map(id => state.nodesById[id]!);
}

export function getVisibleEdges(state: AssetGraphState): AssetGraphEdge[] {
  return Object.values(state.edgesById).filter(
    edge => Boolean(state.nodesById[edge.from] && state.nodesById[edge.to]),
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
 * AbortController cancellation, cursor-stale resets, and 404 eviction.
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

  function startRequest(): { generation: number; signal: AbortSignal } {
    activeController?.abort();
    activeController = new AbortController();
    return {
      generation: state.requestGeneration,
      signal: activeController.signal,
    };
  }

  async function restartAfterCursorStale() {
    emit(applyCursorStaleReset(state));
    if (state.context.kind === "goal") {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
        allowCursorStaleRestart: false,
      });
      return;
    }
    await loadRoots({ allowCursorStaleRestart: false });
  }

  async function loadRoots(options?: { cursor?: string; append?: boolean; allowCursorStaleRestart?: boolean }) {
    const append = options?.append ?? false;
    const allowRestart = options?.allowCursorStaleRestart ?? true;
    const { generation, signal } = startRequest();

    emit({
      ...state,
      error: null,
      loadingRoots: !append,
      loadingMoreRoots: append,
    });

    try {
      const page = await client.roots(buildRootsQueryParams(state, options?.cursor), signal);
      if (!isCurrentGeneration(state, generation)) return;
      emit(applyRootsPage(state, page, { append, generation }));
    } catch (error) {
      if (isAbortError(error) || !isCurrentGeneration(state, generation)) return;
      if (error instanceof AssetGraphRequestError && error.code === "CURSOR_STALE" && allowRestart) {
        await restartAfterCursorStale();
        return;
      }
      emit(applyRequestError(state, error, { generation }));
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
  ) {
    const append = options?.append ?? false;
    const allowRestart = options?.allowCursorStaleRestart ?? true;
    const relations = options?.relations ?? defaultNeighborRelations(focusId, direction, state.lens);
    const { generation, signal } = startRequest();

    emit({
      ...state,
      error: null,
      selectedNodeId: focusId,
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
      if (!isCurrentGeneration(state, generation)) return;
      emit(
        applyNeighborsPage(state, page, {
          focus: focusId,
          direction,
          relations,
          append,
          generation,
        }),
      );
    } catch (error) {
      if (isAbortError(error) || !isCurrentGeneration(state, generation)) return;
      if (error instanceof AssetGraphRequestError && error.code === "NOT_FOUND") {
        emit(applyNotFoundForFocus(state, focusId, { generation }));
        return;
      }
      if (error instanceof AssetGraphRequestError && error.code === "CURSOR_STALE" && allowRestart) {
        await restartAfterCursorStale();
        return;
      }
      emit(applyRequestError(state, error, { generation }));
    }
  }

  async function loadMoreNeighbors(focusId: AssetGraphNodeId) {
    const center = state.expandedCenters[focusId];
    if (!center?.nextCursor || state.expandingNodeId) return;
    await expandNode(focusId, center.direction, {
      relations: center.relations,
      cursor: center.nextCursor,
      append: true,
    });
  }

  async function loadDetail(focusId: AssetGraphNodeId) {
    const { generation, signal } = startRequest();
    emit({
      ...state,
      error: null,
      selectedNodeId: focusId,
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
      if (!isCurrentGeneration(state, generation)) return;
      emit(applyDetailPage(state, page, { generation }));
    } catch (error) {
      if (isAbortError(error) || !isCurrentGeneration(state, generation)) return;
      if (error instanceof AssetGraphRequestError && error.code === "NOT_FOUND") {
        emit(applyNotFoundForFocus(state, focusId, { generation }));
        return;
      }
      emit(applyRequestError(state, error, { generation }));
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
        previousExpanded[preservedFocus]?.direction ?? defaultDirectionForNode(preservedFocus);
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
        previousExpanded[preservedFocus]?.direction ?? defaultDirectionForNode(preservedFocus);
      await expandNode(preservedFocus, direction, {
        relations:
          previousExpanded[preservedFocus]?.relations ??
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
    const partialCenterEntry = Object.entries(state.expandedCenters).find(
      ([, center]) => center.completeness === "partial",
    );
    if (partialCenterEntry) {
      const [focusId, center] = partialCenterEntry;
      await expandNode(focusId, center.direction, { relations: center.relations });
      return;
    }
    if (state.context.kind === "goal" && state.rootIds.length === 0) {
      await expandNode(state.context.id, "out", {
        relations: defaultNeighborRelations(state.context.id, "out", state.lens),
      });
      return;
    }
    await loadRoots();
  }

  function focusNode(nodeId: string | null) {
    emit(selectNodeFocus(state, nodeId));
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
    clearNotice,
    dispose,
  };
}
