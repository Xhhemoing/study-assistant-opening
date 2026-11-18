"use client";

import {
  AlertTriangle,
  ArrowRight,
  Compass,
  FileSearch,
  Network,
  RefreshCw,
  Search,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  ASSET_GRAPH_DEFAULT_LIMIT,
  isSafeOpeningNavigateHref,
  type AssetGraphAction,
  type AssetGraphContext,
  type AssetGraphLens,
  type AssetGraphNodeId,
  type AssetGraphRootKind,
  type CourseRouteActionResult,
} from "@aistudy/contracts";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { subscribeOpeningPrivacyChange } from "../client/privacy-change";
import {
  CourseRouteRequestError,
  courseRouteHref,
  createCourseRouteClient,
  type CourseRouteClient,
} from "../courses/course-route-client";
import {
  ContentBlock,
  EmptyState,
  LoadError,
  LoadingRows,
  PageHeader,
  tone,
  ui,
} from "../design/ui";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { AssetGraphCanvas } from "./asset-graph-canvas";
import {
  createAssetGraphClient,
  createHttpAssetGraphTransport,
  type AssetGraphTransport,
} from "./asset-graph-client";
import {
  ASSISTANCE_LABELS,
  EDGE_BASIS_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  LENS_LABELS,
  NODE_KIND_LABELS,
  RELATION_LABELS,
  REQUIREMENT_STATUS_LABELS,
  ROOT_KIND_OPTIONS,
  collectGraphWarnings,
  createAssetGraphStore,
  getVisibleEdges,
  getVisibleNodes,
  isGraphPartial,
} from "./asset-graph-model";

type StartAction = Extract<AssetGraphAction, { kind: "startCourseRequirement" }>;

type PendingStartIntent = {
  signature: string;
  action: StartAction;
  clientKey: string;
  minutes: number;
};

type ContextChoiceOption = {
  value: string;
  label: string;
  context: AssetGraphContext;
};

const LENS_OPTIONS: readonly AssetGraphLens[] = ["all", "structure", "assets", "evidence"];
const MINUTE_OPTIONS = [15, 20, 30, 45] as const;
const LIMIT_OPTIONS = [1, 10, 20, 40] as const;

function useOptionalNextRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

function createStartIntentKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `asset-graph-start:${crypto.randomUUID()}`;
  }
  return `asset-graph-start:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function startActionSignature(action: StartAction): string {
  return [
    action.courseId,
    action.goalId,
    action.requirementId,
    action.expectedGoalRevision,
    action.expectedRequirementRevision,
  ].join(":");
}

function serializeContextValue(context: AssetGraphContext): string {
  return context.kind === "workspace" ? "workspace" : `${context.kind}:${context.id}`;
}

function parseSerializedContextValue(serialized: string): AssetGraphContext {
  if (serialized.startsWith("course:")) {
    return { kind: "course", id: serialized.slice("course:".length) };
  }
  if (serialized.startsWith("goal:")) {
    return { kind: "goal", id: serialized.slice("goal:".length) };
  }
  return { kind: "workspace" };
}

function formatReadableTime(iso: string): string {
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

export type AssetGraphWorkspaceProps = {
  endpoint?: string;
  transport?: AssetGraphTransport;
  courseRouteClient?: Pick<CourseRouteClient, "start">;
  initialContext?: AssetGraphContext;
  initialLens?: AssetGraphLens;
  initialFocus?: AssetGraphNodeId | null;
  initialPageLimit?: number;
  courses?: readonly { id: string; title: string }[];
  goals?: readonly { id: string; title: string }[];
  onNavigate?: (href: string) => void;
};

export function AssetGraphWorkspace({
  endpoint,
  transport,
  courseRouteClient,
  initialContext = { kind: "workspace" },
  initialLens = "all",
  initialFocus = null,
  initialPageLimit = ASSET_GRAPH_DEFAULT_LIMIT,
  courses = [],
  goals = [],
  onNavigate,
}: AssetGraphWorkspaceProps) {
  const resolvedTransport = useMemo(
    () => transport ?? (endpoint ? createHttpAssetGraphTransport(endpoint) : null),
    [transport, endpoint],
  );

  if (!resolvedTransport) {
    return (
      <section className="flex h-full min-h-0 min-w-0 flex-col bg-bg text-text">
        <PageHeader
          title="知识地图"
          action={
            <Link className={ui.secondary} href="/opening/library">
              返回资料列表
            </Link>
          }
        />
        <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <ContentBlock width="full">
            <div className="rounded-tile border border-line bg-surface p-6 shadow-card">
              <EmptyState
                icon={Network}
                title="知识地图接口即将接入"
                description="知识地图接口即将接入，当前可先使用课程与资料列表"
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link className={ui.primary} href="/opening/courses">
                      前往课程列表
                    </Link>
                    <Link className={ui.secondary} href="/opening/library">
                      前往资料列表
                    </Link>
                  </div>
                }
              />
            </div>
          </ContentBlock>
        </div>
      </section>
    );
  }

  return (
    <ConnectedAssetGraphWorkspace
      transport={resolvedTransport}
      courseRouteClient={courseRouteClient}
      initialContextKey={serializeContextValue(initialContext)}
      initialLens={initialLens}
      initialFocus={initialFocus}
      initialPageLimit={initialPageLimit}
      courses={courses}
      goals={goals}
      onNavigate={onNavigate}
    />
  );
}

function ConnectedAssetGraphWorkspace({
  transport,
  courseRouteClient,
  initialContextKey,
  initialLens,
  initialFocus,
  initialPageLimit,
  courses,
  goals,
  onNavigate,
}: {
  transport: AssetGraphTransport;
  courseRouteClient?: Pick<CourseRouteClient, "start">;
  initialContextKey: string;
  initialLens: AssetGraphLens;
  initialFocus: AssetGraphNodeId | null;
  initialPageLimit: number;
  courses: readonly { id: string; title: string }[];
  goals: readonly { id: string; title: string }[];
  onNavigate?: (href: string) => void;
}) {
  const router = useOptionalNextRouter();
  const routeClient = useMemo(
    () => courseRouteClient ?? createCourseRouteClient(),
    [courseRouteClient],
  );
  const graphClient = useMemo(() => createAssetGraphClient(transport), [transport]);

  const store = useMemo(() => {
    const context = parseSerializedContextValue(initialContextKey);
    return createAssetGraphStore(graphClient, {
      context,
      lens: initialLens,
      pageLimit: initialPageLimit,
      selectedNodeId: initialFocus ?? (context.kind === "workspace" ? null : context.id),
    });
  }, [graphClient, initialContextKey, initialLens, initialFocus, initialPageLimit]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const [searchInput, setSearchInput] = useState("");
  const [kindInput, setKindInput] = useState<AssetGraphRootKind | "">("");
  const [limitInput, setLimitInput] = useState<number>(initialPageLimit);
  const [selectedMinutes, setSelectedMinutes] = useState<number>(20);
  const [startBusy, setStartBusy] = useState(false);
  const [pendingStart, setPendingStart] = useState<PendingStartIntent | null>(null);
  const [startError, setStartError] = useState("");
  const [choiceResult, setChoiceResult] = useState<
    Extract<CourseRouteActionResult, { kind: "choice" }> | null
  >(null);
  const mountedRef = useRef(true);
  const startBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    void store.initialize(initialFocus);
    return () => {
      mountedRef.current = false;
      store.dispose();
    };
  }, [store, initialFocus]);

  useEffect(() => {
    return subscribeOpeningPrivacyChange(() => {
      setPendingStart(null);
      setStartError("");
      setChoiceResult(null);
      void store.invalidateByPrivacy();
    });
  }, [store]);

  useEffect(() => {
    setLimitInput(initialPageLimit);
  }, [initialPageLimit]);

  const visibleNodes = useMemo(() => getVisibleNodes(state), [state]);
  const visibleEdges = useMemo(() => getVisibleEdges(state), [state]);
  const partial = isGraphPartial(state);
  const warnings = useMemo(() => collectGraphWarnings(state), [state]);
  const selectedNode = state.selectedNodeId ? state.nodesById[state.selectedNodeId] ?? null : null;
  const activeDetail =
    state.detail && state.detail.id === state.selectedNodeId ? state.detail : null;

  const contextOptions = useMemo<ContextChoiceOption[]>(() => {
    const map = new Map<string, ContextChoiceOption>();
    const rootContext: AssetGraphContext = { kind: "workspace" };
    map.set(serializeContextValue(rootContext), {
      value: serializeContextValue(rootContext),
      label: "全部个人资产",
      context: rootContext,
    });

    for (const course of courses) {
      const ctx: AssetGraphContext = { kind: "course", id: `course/${course.id}` };
      map.set(serializeContextValue(ctx), {
        value: serializeContextValue(ctx),
        label: `课程：${course.title}`,
        context: ctx,
      });
    }

    for (const goal of goals) {
      const ctx: AssetGraphContext = { kind: "goal", id: `goal/${goal.id}` };
      map.set(serializeContextValue(ctx), {
        value: serializeContextValue(ctx),
        label: `目标：${goal.title}`,
        context: ctx,
      });
    }

    for (const node of visibleNodes) {
      if (node.kind === "course") {
        const ctx: AssetGraphContext = { kind: "course", id: node.id };
        const key = serializeContextValue(ctx);
        if (!map.has(key)) {
          map.set(key, { value: key, label: `课程：${node.label}`, context: ctx });
        }
      } else if (node.kind === "goal") {
        const ctx: AssetGraphContext = { kind: "goal", id: node.id };
        const key = serializeContextValue(ctx);
        if (!map.has(key)) {
          map.set(key, { value: key, label: `目标：${node.label}`, context: ctx });
        }
      }
    }

    const currentKey = serializeContextValue(state.context);
    if (!map.has(currentKey) && state.context.kind !== "workspace") {
      map.set(currentKey, {
        value: currentKey,
        label: state.context.kind === "course" ? "当前课程范围" : "当前目标范围",
        context: state.context,
      });
    }

    return [...map.values()];
  }, [courses, goals, visibleNodes, state.context]);

  const connectedEdges = useMemo(() => {
    if (!selectedNode) return { incoming: [], outgoing: [] };
    return {
      incoming: visibleEdges.filter(edge => edge.to === selectedNode.id),
      outgoing: visibleEdges.filter(edge => edge.from === selectedNode.id),
    };
  }, [selectedNode, visibleEdges]);

  function navigateTo(href: string) {
    if (onNavigate) {
      onNavigate(href);
      return;
    }
    if (router) {
      router.push(href);
      return;
    }
    window.location.assign(href);
  }

  function resetActionTransientState() {
    setPendingStart(null);
    setStartError("");
    setChoiceResult(null);
  }

  function handleContextChange(nextContext: AssetGraphContext, preserveFocusId?: string | null) {
    resetActionTransientState();
    void store.selectContext(nextContext, preserveFocusId);
  }

  function handleLensChange(nextLens: AssetGraphLens) {
    resetActionTransientState();
    void store.selectLens(nextLens);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: searchInput,
      selectedKinds: kindInput ? [kindInput] : [],
      pageLimit: limitInput,
    });
  }

  function handleKindFilterChange(nextKind: AssetGraphRootKind | "") {
    setKindInput(nextKind);
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: searchInput,
      selectedKinds: nextKind ? [nextKind] : [],
      pageLimit: limitInput,
    });
  }

  function handleLimitChange(nextLimit: number) {
    setLimitInput(nextLimit);
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: searchInput,
      selectedKinds: kindInput ? [kindInput] : [],
      pageLimit: nextLimit,
    });
  }

  function handleClearFilters() {
    setSearchInput("");
    setKindInput("");
    setLimitInput(ASSET_GRAPH_DEFAULT_LIMIT);
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: "",
      selectedKinds: [],
      pageLimit: ASSET_GRAPH_DEFAULT_LIMIT,
    });
  }

  async function executeStartRequirement(action: StartAction, reusePending?: PendingStartIntent) {
    if (startBusyRef.current) return;
    const signature = startActionSignature(action);
    const intent: PendingStartIntent =
      reusePending && reusePending.signature === signature
        ? reusePending
        : pendingStart && pendingStart.signature === signature
          ? pendingStart
          : {
              signature,
              action,
              clientKey: createStartIntentKey(),
              minutes: selectedMinutes,
            };

    startBusyRef.current = true;
    setStartBusy(true);
    setStartError("");
    setChoiceResult(null);
    setPendingStart(intent);

    try {
      const result = await routeClient.start(action.courseId, {
        goalId: action.goalId,
        expectedGoalRevision: action.expectedGoalRevision,
        requirementId: action.requirementId,
        expectedRequirementRevision: action.expectedRequirementRevision,
        minutes: intent.minutes,
        clientKey: intent.clientKey,
      });

      if (!mountedRef.current) return;

      if (result.kind === "ready") {
        if (result.activity.courseId !== action.courseId) {
          setPendingStart(null);
          setStartError("学习活动与当前课程不匹配，请重新读取详情后再试。");
          return;
        }
        const safeHref = courseRouteHref(action.courseId, result.href);
        setPendingStart(null);
        navigateTo(safeHref);
        return;
      }

      setPendingStart(null);
      setChoiceResult(result);
    } catch (reason) {
      if (!mountedRef.current) return;
      const isConflict = reason instanceof CourseRouteRequestError && reason.status === 409;
      if (isConflict) {
        setPendingStart(null);
        setStartError(
          userFacingMessage(reason, "课程目标或要求已更新，请重新读取详情后再试。"),
        );
      } else {
        setStartError(
          userFacingMessage(reason, "本次安排结果未确认，请点击重试继续。"),
        );
      }
    } finally {
      startBusyRef.current = false;
      if (mountedRef.current) {
        setStartBusy(false);
      }
    }
  }

  const effectiveLearnerState =
    activeDetail?.learnerState ?? selectedNode?.summary?.learnerState ?? null;
  const effectiveRequirementStatus =
    activeDetail?.requirementStatus ?? selectedNode?.summary?.requirementStatus ?? null;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-bg text-text">
      <PageHeader
        title="知识地图"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <Link className={ui.quiet} href="/opening/library">
              资料列表
            </Link>
            <Link className={ui.quiet} href="/opening/courses">
              课程列表
            </Link>
          </div>
        }
      />

      <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <ContentBlock width="full" className="space-y-4">
          <section
            aria-label="知识地图筛选与视角工具栏"
            className="space-y-3 rounded-tile border border-line bg-surface p-4 shadow-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={ui.secondary}
                  aria-pressed={state.context.kind === "workspace"}
                  onClick={() => handleContextChange({ kind: "workspace" }, null)}
                >
                  <Compass size={14} aria-hidden="true" />
                  全部个人资产
                </button>
                <label className="flex items-center gap-2 text-meta text-text-2">
                  <span>观察范围</span>
                  <select
                    aria-label="观察范围"
                    className={ui.input}
                    value={serializeContextValue(state.context)}
                    onChange={event => {
                      const matched = contextOptions.find(
                        option => option.value === event.target.value,
                      );
                      if (matched) {
                        handleContextChange(matched.context);
                      }
                    }}
                  >
                    {contextOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div role="toolbar" aria-label="观察视角" className="flex flex-wrap gap-1.5">
                  {LENS_OPTIONS.map(lens => (
                    <button
                      key={lens}
                      type="button"
                      className={state.lens === lens ? ui.primary : ui.secondary}
                      aria-pressed={state.lens === lens}
                      onClick={() => handleLensChange(lens)}
                    >
                      {LENS_LABELS[lens]}
                    </button>
                  ))}
                </div>
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line bg-surface-2/60 px-3 text-meta text-text">
                  <input
                    type="checkbox"
                    checked={state.includeSummary}
                    onChange={event => {
                      resetActionTransientState();
                      void store.setIncludeSummary(event.target.checked);
                    }}
                  />
                  <span>显示状态摘要</span>
                </label>
              </div>
            </div>

            <form
              role="search"
              onSubmit={handleSearchSubmit}
              className="flex flex-wrap items-end gap-2.5 border-t border-line pt-3"
            >
              <label className="min-w-[220px] flex-1 space-y-1">
                <span className={ui.label}>标题检索</span>
                <div className="flex items-center gap-2 rounded-ctl border border-text-3 bg-surface px-3">
                  <Search size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                  <input
                    type="search"
                    aria-label="标题检索"
                    className="min-h-(--control-h) w-full bg-transparent text-ui text-text placeholder:text-text-3 focus:outline-none"
                    placeholder="输入课程、目标、资料或笔记标题"
                    value={searchInput}
                    onChange={event => setSearchInput(event.target.value)}
                  />
                </div>
              </label>

              <label className="space-y-1">
                <span className={ui.label}>起点类型</span>
                <select
                  aria-label="起点类型"
                  className={ui.input}
                  value={kindInput}
                  onChange={event =>
                    handleKindFilterChange((event.target.value as AssetGraphRootKind | "") || "")
                  }
                >
                  <option value="">默认起点</option>
                  {ROOT_KIND_OPTIONS.map(kind => (
                    <option key={kind} value={kind}>
                      {NODE_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className={ui.label}>每页条数</span>
                <select
                  aria-label="每页条数"
                  className={ui.input}
                  value={String(limitInput)}
                  onChange={event => handleLimitChange(Number(event.target.value))}
                >
                  {LIMIT_OPTIONS.map(option => (
                    <option key={option} value={String(option)}>
                      {option} 条
                    </option>
                  ))}
                </select>
              </label>

              <button type="submit" className={ui.primary}>
                检索
              </button>
              {searchInput || kindInput || limitInput !== ASSET_GRAPH_DEFAULT_LIMIT ? (
                <button type="button" className={ui.quiet} onClick={handleClearFilters}>
                  重置筛选
                </button>
              ) : null}
            </form>
          </section>

          {state.notice ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-tile border border-line-strong bg-surface-2 px-4 py-3 text-sm text-text"
            >
              <span>{state.notice}</span>
              <button type="button" className={ui.quiet} onClick={() => store.clearNotice()}>
                知道了
              </button>
            </div>
          ) : null}

          {partial ? (
            <div
              role="status"
              aria-label="内容缺口提示"
              className="flex flex-wrap items-start justify-between gap-3 rounded-tile border border-warn bg-warn-soft px-4 py-3 text-warn"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">
                    当前仅显示部分内容，部分关联或状态暂时无法完整确认。
                  </p>
                  {warnings.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-xs">
                      {warnings.map(warning => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className={ui.secondary}
                onClick={() => void store.retryCurrentView()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                重试读取
              </button>
            </div>
          ) : null}

          {state.error ? (
            <LoadError
              message={state.error.message}
              onRetry={() => void store.retryCurrentView()}
            />
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-4">
              {state.loadingRoots && visibleNodes.length === 0 ? (
                <div className="rounded-tile border border-line bg-surface p-5">
                  <p role="status" className="mb-3 text-sm text-text-2">
                    正在读取个人知识地图…
                  </p>
                  <LoadingRows label="正在读取个人知识地图" />
                </div>
              ) : visibleNodes.length > 0 ? (
                <AssetGraphCanvas
                  nodes={visibleNodes}
                  edges={visibleEdges}
                  rootIds={state.rootIds}
                  selectedNodeId={state.selectedNodeId}
                  context={state.context}
                  expandedCenters={state.expandedCenters}
                  expandingNodeId={state.expandingNodeId}
                  loadingDetailNodeId={state.loadingDetailNodeId}
                  onSelectNode={nodeId => {
                    resetActionTransientState();
                    store.focusNode(nodeId);
                  }}
                  onExpandNode={(nodeId, direction) => {
                    resetActionTransientState();
                    void store.expandNode(nodeId, direction);
                  }}
                  onLoadMoreNeighbors={nodeId => {
                    void store.loadMoreNeighbors(nodeId);
                  }}
                  onLoadDetail={nodeId => {
                    resetActionTransientState();
                    void store.loadDetail(nodeId);
                  }}
                  onEnterContext={(nextContext, focusId) => {
                    handleContextChange(nextContext, focusId);
                  }}
                />
              ) : !state.error ? (
                <div className="rounded-tile border border-line bg-surface p-6 shadow-card">
                  <EmptyState
                    icon={Network}
                    title="当前范围无匹配内容"
                    description="可以切换观察视角、清空检索词，或回到全部个人资产继续查找。"
                    action={
                      state.context.kind !== "workspace" || searchInput || kindInput ? (
                        <button
                          type="button"
                          className={ui.secondary}
                          onClick={() => {
                            if (searchInput || kindInput) {
                              handleClearFilters();
                            } else {
                              handleContextChange({ kind: "workspace" }, null);
                            }
                          }}
                        >
                          查看全部个人资产
                        </button>
                      ) : undefined
                    }
                  />
                </div>
              ) : null}

              {state.rootsCursor !== null ? (
                <div className="flex items-center justify-between rounded-tile border border-line bg-surface px-4 py-3">
                  <span className="text-meta text-text-2">还有更多起点内容可加载</span>
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={state.loadingMoreRoots}
                    onClick={() => void store.loadMoreRoots()}
                  >
                    {state.loadingMoreRoots ? "正在加载下一页…" : "加载下一页"}
                  </button>
                </div>
              ) : null}
            </div>

            <aside
              aria-label="节点详情与行动面板"
              className="h-fit space-y-4 rounded-tile border border-line bg-surface p-4 shadow-card lg:sticky lg:top-4"
            >
              {selectedNode || activeDetail ? (
                <>
                  <div className="space-y-1.5 border-b border-line pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {selectedNode ? (
                        <span className={`${ui.badge} ${tone.neutral}`}>
                          {NODE_KIND_LABELS[selectedNode.kind]}
                        </span>
                      ) : null}
                      {state.asOf ? (
                        <span className="text-meta text-text-3">
                          读取时间：{formatReadableTime(state.asOf)}
                        </span>
                      ) : null}
                    </div>
                    <h2 className="text-base font-semibold text-text">
                      {selectedNode?.label ?? activeDetail?.id}
                    </h2>
                  </div>

                  {selectedNode?.meta ? (
                    <dl className="grid grid-cols-1 gap-2 rounded-ctl bg-surface-2/60 p-3 text-xs text-text-2">
                      {selectedNode.meta.occurredAt ? (
                        <div className="flex justify-between gap-2">
                          <dt className="text-text-3">发生时间</dt>
                          <dd className="font-medium text-text">
                            {formatReadableTime(selectedNode.meta.occurredAt)}
                          </dd>
                        </div>
                      ) : null}
                      {selectedNode.meta.assistance ? (
                        <div className="flex justify-between gap-2">
                          <dt className="text-text-3">帮助条件</dt>
                          <dd className="font-medium text-text">
                            {ASSISTANCE_LABELS[selectedNode.meta.assistance]}
                          </dd>
                        </div>
                      ) : null}
                      {selectedNode.meta.version !== undefined ? (
                        <div className="flex justify-between gap-2">
                          <dt className="text-text-3">当前版本</dt>
                          <dd className="font-medium text-text">
                            第 {selectedNode.meta.version} 版
                          </dd>
                        </div>
                      ) : null}
                      {selectedNode.meta.knowledgeStatus ? (
                        <div className="flex justify-between gap-2">
                          <dt className="text-text-3">知识整理状态</dt>
                          <dd className="font-medium text-text">
                            {KNOWLEDGE_STATUS_LABELS[selectedNode.meta.knowledgeStatus]}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}

                  <div className="space-y-2 rounded-ctl border border-line p-3">
                    <h3 className="text-xs font-semibold text-text">状态判断</h3>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-text-3">近期练习表现</span>
                        <span className={`${ui.badge} ${tone.neutral}`}>
                          {effectiveLearnerState
                            ? LEARNER_STATE_LABELS[effectiveLearnerState]
                            : "暂无练习状态"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-text-3">课程要求达成情况</span>
                        <span
                          className={`${ui.badge} ${
                            effectiveRequirementStatus === "verified"
                              ? tone.success
                              : effectiveRequirementStatus === "blocked" ||
                                  effectiveRequirementStatus === "needs_correction"
                                ? tone.warning
                                : tone.neutral
                          }`}
                        >
                          {effectiveRequirementStatus
                            ? REQUIREMENT_STATUS_LABELS[effectiveRequirementStatus]
                            : "未纳入课程要求"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {selectedNode ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={ui.secondary}
                        disabled={state.loadingDetailNodeId === selectedNode.id}
                        onClick={() => {
                          resetActionTransientState();
                          void store.loadDetail(selectedNode.id);
                        }}
                      >
                        <FileSearch size={14} aria-hidden="true" />
                        {state.loadingDetailNodeId === selectedNode.id
                          ? "正在读取详情…"
                          : activeDetail
                            ? "刷新节点详情"
                            : "查看详情与行动"}
                      </button>
                    </div>
                  ) : null}

                  {activeDetail ? (
                    <div className="space-y-4 border-t border-line pt-3">
                      {activeDetail.notes.length > 0 ? (
                        <div className="space-y-1.5">
                          <h3 className="text-xs font-semibold text-text">说明</h3>
                          <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-text-2">
                            {activeDetail.notes.map((note, index) => (
                              <li key={`${index}-${note}`}>{note}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        <h3 className="text-xs font-semibold text-text">可用行动</h3>
                        {activeDetail.actions.length === 0 ? (
                          <p className="text-xs text-text-3">
                            当前节点暂无可直接打开的后续入口。
                          </p>
                        ) : (
                          <div className="space-y-2.5">
                            {activeDetail.actions.some(
                              item => item.kind === "startCourseRequirement",
                            ) ? (
                              <label className="block space-y-1">
                                <span className={ui.label}>本次计划用时</span>
                                <select
                                  aria-label="本次计划用时"
                                  className={ui.input}
                                  disabled={startBusy || pendingStart !== null}
                                  value={String(selectedMinutes)}
                                  onChange={event => setSelectedMinutes(Number(event.target.value))}
                                >
                                  {MINUTE_OPTIONS.map(minutes => (
                                    <option key={minutes} value={String(minutes)}>
                                      {minutes} 分钟
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}

                            {activeDetail.actions.map((action, index) => {
                              if (action.kind === "navigate") {
                                if (!isSafeOpeningNavigateHref(action.href)) return null;
                                return (
                                  <Link
                                    key={`${action.kind}-${action.href}-${index}`}
                                    href={action.href}
                                    className={`${ui.secondary} w-full justify-between`}
                                  >
                                    <span>{action.label}</span>
                                    <ArrowRight size={14} aria-hidden="true" />
                                  </Link>
                                );
                              }

                              const signature = startActionSignature(action);
                              const hasPendingSameIntent = pendingStart?.signature === signature;
                              return (
                                <div key={`${action.kind}-${signature}`} className="space-y-2">
                                  <button
                                    type="button"
                                    className={`${ui.primary} w-full justify-between`}
                                    disabled={startBusy || hasPendingSameIntent}
                                    onClick={() => void executeStartRequirement(action)}
                                  >
                                    <span>
                                      {startBusy && hasPendingSameIntent
                                        ? "正在开启学习…"
                                        : action.label}
                                    </span>
                                    <ArrowRight size={14} aria-hidden="true" />
                                  </button>
                                  {hasPendingSameIntent && !startBusy ? (
                                    <button
                                      type="button"
                                      className={`${ui.secondary} w-full`}
                                      onClick={() =>
                                        void executeStartRequirement(action, pendingStart!)
                                      }
                                    >
                                      <RefreshCw size={14} aria-hidden="true" />
                                      重试本次安排
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {startError ? (
                          <p role="alert" className="text-xs text-danger">
                            {startError}
                          </p>
                        ) : null}

                        {choiceResult ? (
                          <div
                            role="status"
                            className="space-y-2 rounded-ctl border border-warn bg-warn-soft p-3 text-xs text-warn"
                          >
                            <p className="font-medium">暂未直接开启活动</p>
                            <p>{choiceResult.message}</p>
                            {(() => {
                              try {
                                const safeChoiceHref = courseRouteHref(
                                  choiceResult.courseId,
                                  choiceResult.href,
                                );
                                return (
                                  <Link href={safeChoiceHref} className={ui.secondary}>
                                    前往课程确认
                                  </Link>
                                );
                              } catch {
                                return null;
                              }
                            })()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {selectedNode &&
                  (connectedEdges.incoming.length > 0 || connectedEdges.outgoing.length > 0) ? (
                    <div className="space-y-2 border-t border-line pt-3">
                      <h3 className="text-xs font-semibold text-text">当前已展开关联</h3>
                      <ul className="space-y-1.5 text-xs text-text-2">
                        {connectedEdges.outgoing.map(edge => {
                          const target = state.nodesById[edge.to];
                          return (
                            <li key={edge.id} className="rounded-ctl bg-surface-2/60 p-2">
                              <span className="font-medium text-text">
                                {RELATION_LABELS[edge.relation]}
                              </span>
                              <span> · {EDGE_BASIS_LABELS[edge.basis]}</span>
                              {edge.sourceVersion !== undefined ? (
                                <span> · 资料第 {edge.sourceVersion} 版</span>
                              ) : null}
                              {edge.page !== undefined ? <span> · 第 {edge.page} 页</span> : null}
                              {target ? (
                                <button
                                  type="button"
                                  className="mt-1 block text-left text-accent hover:underline"
                                  onClick={() => store.focusNode(target.id)}
                                >
                                  指向：{target.label}
                                </button>
                              ) : null}
                            </li>
                          );
                        })}
                        {connectedEdges.incoming.map(edge => {
                          const source = state.nodesById[edge.from];
                          return (
                            <li key={edge.id} className="rounded-ctl bg-surface-2/60 p-2">
                              <span className="font-medium text-text">
                                {RELATION_LABELS[edge.relation]}
                              </span>
                              <span>（入边 · {EDGE_BASIS_LABELS[edge.basis]}）</span>
                              {edge.sourceVersion !== undefined ? (
                                <span> · 资料第 {edge.sourceVersion} 版</span>
                              ) : null}
                              {edge.page !== undefined ? <span> · 第 {edge.page} 页</span> : null}
                              {source ? (
                                <button
                                  type="button"
                                  className="mt-1 block text-left text-accent hover:underline"
                                  onClick={() => store.focusNode(source.id)}
                                >
                                  来自：{source.label}
                                </button>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="space-y-2 text-sm text-text-2">
                  <h2 className="text-base font-semibold text-text">节点详情</h2>
                  <p className="text-xs leading-6 text-text-3">
                    在左侧画布或节点清单中点击任意一项，或点击“查看详情”查看依据说明与后续学习入口。
                  </p>
                </div>
              )}
            </aside>
          </div>
        </ContentBlock>
      </div>
    </section>
  );
}
