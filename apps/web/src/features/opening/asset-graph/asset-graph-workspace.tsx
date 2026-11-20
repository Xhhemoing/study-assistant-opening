"use client";

import {
  AlertTriangle,
  ArrowRight,
  Compass,
  FileSearch,
  FlaskConical,
  List,
  Network,
  PinOff,
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
  type CourseRequirementProgress,
  type CourseRouteActionResult,
  type CourseRouteTaskContext,
} from "@aistudy/contracts";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { getVerifiedSessionIdentity } from "../../auth/session-identity";
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
import {
  AssetGraphCanvas,
  ConnectedEdgeItem,
  requirementStatusBadgeTone,
} from "./asset-graph-canvas";
import {
  createAssetGraphClient,
  createHttpAssetGraphTransport,
  type AssetGraphTransport,
} from "./asset-graph-client";
import { AssetGraphExamPanel } from "./asset-graph-exam-panel";
import { AssetGraphListView, type ListSubTab } from "./asset-graph-list-view";
import {
  ASSISTANCE_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  LEARNER_STATE_LABELS,
  LENS_LABELS,
  NODE_KIND_LABELS,
  NOT_FOUND_SAFE_NOTICE,
  REQUIREMENT_STATUS_LABELS,
  ROOT_KIND_OPTIONS,
  collectGraphWarnings,
  createAssetGraphStore,
  getOwn,
  getVisibleEdges,
  getVisibleNodes,
  isGraphPartial,
  resolveEffectiveNodeStates,
  type AssetGraphDirection,
} from "./asset-graph-model";
import type { FreeMapLocateRequest } from "./free-map-canvas";
import { buildFreeMapPersistKey } from "./free-map-canvas-storage";
import { SeriesMapExample } from "./series-map-example";

type StartAction = Extract<AssetGraphAction, { kind: "startCourseRequirement" }>;

type StartOptions = {
  minutes?: number;
  taskId?: string;
  expectedTaskVersion?: number;
};

type PendingStartIntent = {
  signature: string;
  action: StartAction;
  clientKey: string;
  minutes: number;
  taskId?: string;
  expectedTaskVersion?: number;
};

type PendingExpandFocusIntent = {
  button: HTMLButtonElement;
  generation: number;
  requestSeq: number;
};

type LastFocusedCard = {
  cardElement: HTMLElement;
  element: Element;
};

type ContextChoiceOption = {
  value: string;
  label: string;
  context: AssetGraphContext;
};

export type AssetGraphViewMode = "graph" | "list";

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

function startActionSignature(action: StartAction, options?: StartOptions): string {
  return [
    action.courseId,
    action.goalId,
    action.requirementId,
    action.expectedGoalRevision,
    action.expectedRequirementRevision,
    options?.taskId ?? "",
    options?.expectedTaskVersion ?? "",
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

export type AssetGraphCourseRouteClient = Pick<CourseRouteClient, "start"> &
  Partial<Pick<CourseRouteClient, "read" | "task">>;

export type AssetGraphWorkspaceProps = {
  endpoint?: string;
  transport?: AssetGraphTransport;
  courseRouteClient?: AssetGraphCourseRouteClient;
  initialContext?: AssetGraphContext;
  initialLens?: AssetGraphLens;
  initialFocus?: AssetGraphNodeId | null;
  initialPageLimit?: number;
  initialViewMode?: AssetGraphViewMode;
  initialSandbox?: "series" | null;
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
  initialViewMode = "graph",
  initialSandbox = null,
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
      enableHttpRouteRead={Boolean(endpoint && !courseRouteClient)}
      initialContextKey={serializeContextValue(initialContext)}
      initialLens={initialLens}
      initialFocus={initialFocus}
      initialPageLimit={initialPageLimit}
      initialViewMode={initialViewMode}
      initialSandbox={initialSandbox}
      courses={courses}
      goals={goals}
      onNavigate={onNavigate}
    />
  );
}

function ConnectedAssetGraphWorkspace({
  transport,
  courseRouteClient,
  enableHttpRouteRead,
  initialContextKey,
  initialLens,
  initialFocus,
  initialPageLimit,
  initialViewMode,
  initialSandbox,
  courses,
  goals,
  onNavigate,
}: {
  transport: AssetGraphTransport;
  courseRouteClient?: AssetGraphCourseRouteClient;
  enableHttpRouteRead: boolean;
  initialContextKey: string;
  initialLens: AssetGraphLens;
  initialFocus: AssetGraphNodeId | null;
  initialPageLimit: number;
  initialViewMode: AssetGraphViewMode;
  initialSandbox: "series" | null;
  courses: readonly { id: string; title: string }[];
  goals: readonly { id: string; title: string }[];
  onNavigate?: (href: string) => void;
}) {
  const router = useOptionalNextRouter();
  const routeClient = useMemo(
    () => courseRouteClient ?? createCourseRouteClient(),
    [courseRouteClient],
  );
  const examRouteClient = useMemo<Partial<Pick<CourseRouteClient, "read" | "task">>>(() => {
    if (courseRouteClient) {
      return { read: courseRouteClient.read, task: courseRouteClient.task };
    }
    if (enableHttpRouteRead) {
      return { read: routeClient.read, task: routeClient.task };
    }
    return {};
  }, [courseRouteClient, enableHttpRouteRead, routeClient]);
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

  const [viewMode, setViewMode] = useState<AssetGraphViewMode>(initialViewMode);
  const [mapMode, setMapMode] = useState<"exam" | "study">("exam");
  const [sandboxMode, setSandboxMode] = useState<"series" | null>(initialSandbox);
  const [privacyGeneration, setPrivacyGeneration] = useState(0);
  const [locateRequest, setLocateRequest] = useState<FreeMapLocateRequest | null>(null);
  const [listSubTab, setListSubTab] = useState<ListSubTab | null>(null);
  const [srAnnouncement, setSrAnnouncement] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [kindInput, setKindInput] = useState<AssetGraphRootKind | "">("");
  const [limitInput, setLimitInput] = useState<number>(initialPageLimit);
  const [selectedMinutes, setSelectedMinutes] = useState<number>(20);
  const [startBusy, setStartBusy] = useState(false);
  const [startingRequirementId, setStartingRequirementId] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState<PendingStartIntent | null>(null);
  const [startError, setStartError] = useState("");
  const [choiceResult, setChoiceResult] = useState<
    Extract<CourseRouteActionResult, { kind: "choice" }> | null
  >(null);
  const mountedRef = useRef(true);
  const startBusyRef = useRef(false);
  const locateSeqRef = useRef(0);
  const workspaceRootRef = useRef<HTMLElement | null>(null);
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const noticeContainerRef = useRef<HTMLDivElement | null>(null);
  const errorContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingExpandFocusRef = useRef<PendingExpandFocusIntent | null>(null);
  const lastFocusedCardRef = useRef<LastFocusedCard | null>(null);

  function clearPendingExpandFocus() {
    pendingExpandFocusRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    void store.initialize(initialFocus);
    return () => {
      mountedRef.current = false;
      pendingExpandFocusRef.current = null;
      lastFocusedCardRef.current = null;
      store.dispose();
    };
  }, [store, initialFocus]);

  useEffect(() => {
    return subscribeOpeningPrivacyChange(() => {
      pendingExpandFocusRef.current = null;
      setPendingStart(null);
      setStartError("");
      setChoiceResult(null);
      setListSubTab(null);
      setSrAnnouncement("");
      setLocateRequest(null);
      setPrivacyGeneration(prev => prev + 1);
      void store.invalidateByPrivacy();
    });
  }, [store]);

  useEffect(() => {
    setLimitInput(initialPageLimit);
  }, [initialPageLimit]);

  useEffect(() => {
    function handleDocumentFocus(event: FocusEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target === document.body || target === document.documentElement) {
        return;
      }

      const pending = pendingExpandFocusRef.current;
      if (pending && target !== pending.button) {
        pendingExpandFocusRef.current = null;
      }

      if (workspaceRootRef.current?.contains(target)) {
        const card = target.closest<HTMLElement>("[data-node-card], [data-graph-node]");
        lastFocusedCardRef.current = card ? { cardElement: card, element: target } : null;
      } else {
        lastFocusedCardRef.current = null;
      }
    }

    document.addEventListener("focus", handleDocumentFocus, true);
    return () => {
      document.removeEventListener("focus", handleDocumentFocus, true);
    };
  }, []);

  const visibleNodes = useMemo(() => getVisibleNodes(state), [state]);
  const visibleEdges = useMemo(() => getVisibleEdges(state), [state]);
  const partial = isGraphPartial(state);
  const warnings = useMemo(() => collectGraphWarnings(state), [state]);
  const selectedNode = state.selectedNodeId
    ? getOwn(state.nodesById, state.selectedNodeId) ??
      (state.transitionCenter?.id === state.selectedNodeId ? state.transitionCenter : null)
    : null;
  const activeDetail =
    state.detail && state.detail.id === state.selectedNodeId ? state.detail : null;

  const isListDataReady =
    !state.loadingRoots &&
    state.expandingNodeId === null &&
    state.loadingDetailNodeId === null &&
    state.transitionCenter === null &&
    visibleNodes.length > 0;

  useEffect(() => {
    if (viewMode !== "list") return;
    if (listSubTab !== null) return;
    if (!isListDataReady) return;
    setListSubTab(visibleEdges.length > 0 ? "relations" : "nodes");
  }, [viewMode, listSubTab, isListDataReady, visibleEdges.length]);

  useEffect(() => {
    const intent = pendingExpandFocusRef.current;
    if (!intent) return;
    if (
      state.requestGeneration !== intent.generation ||
      state.activeRequestSeq !== intent.requestSeq ||
      state.error !== null ||
      state.notice === NOT_FOUND_SAFE_NOTICE
    ) {
      pendingExpandFocusRef.current = null;
      return;
    }
    if (state.expandingNodeId !== null) return;
    pendingExpandFocusRef.current = null;
    if (
      intent.button.isConnected &&
      !intent.button.disabled &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      intent.button.focus();
    }
  }, [
    state.expandingNodeId,
    state.activeRequestSeq,
    state.requestGeneration,
    state.error,
    state.notice,
  ]);

  useEffect(() => {
    const lastFocused = lastFocusedCardRef.current;
    if (!lastFocused) return;
    if (pendingExpandFocusRef.current !== null) return;
    if (lastFocused.cardElement.isConnected) return;
    lastFocusedCardRef.current = null;
    if (document.activeElement !== null && document.activeElement !== document.body) {
      return;
    }
    const fallbackTarget =
      (state.error ? errorContainerRef.current : null) ??
      (state.notice ? noticeContainerRef.current : null) ??
      (viewMode === "list"
        ? workspaceContentRef.current?.querySelector<HTMLElement>("[data-list-view]") ?? null
        : null) ??
      workspaceContentRef.current;
    fallbackTarget?.focus();
  }, [
    visibleNodes,
    viewMode,
    state.error,
    state.notice,
    state.context,
    state.requestGeneration,
  ]);

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
    clearPendingExpandFocus();
    resetActionTransientState();
    setListSubTab(null);
    setSrAnnouncement("");
    void store.selectContext(nextContext, preserveFocusId);
  }

  function handleLensChange(nextLens: AssetGraphLens) {
    clearPendingExpandFocus();
    resetActionTransientState();
    setSrAnnouncement("");
    void store.selectLens(nextLens);
  }

  async function handleExpandNode(
    nodeId: AssetGraphNodeId,
    direction: AssetGraphDirection,
    triggerButton?: HTMLButtonElement | null,
  ) {
    resetActionTransientState();
    setSrAnnouncement("");
    clearPendingExpandFocus();
    const shouldRestoreFocus = Boolean(
      triggerButton && document.activeElement === triggerButton,
    );
    const prevSeq = store.getState().activeRequestSeq;
    const expandPromise = store.expandNode(nodeId, direction);
    const startedState = store.getState();
    if (shouldRestoreFocus && triggerButton && startedState.activeRequestSeq !== prevSeq) {
      pendingExpandFocusRef.current = {
        button: triggerButton,
        generation: startedState.requestGeneration,
        requestSeq: startedState.activeRequestSeq,
      };
    }
    const result = await expandPromise;
    if (!mountedRef.current) return;
    if (!result.applied) {
      if (
        pendingExpandFocusRef.current?.generation === startedState.requestGeneration &&
        pendingExpandFocusRef.current?.requestSeq === startedState.activeRequestSeq
      ) {
        pendingExpandFocusRef.current = null;
      }
      return;
    }
    setSrAnnouncement(result.announcement);
  }

  async function handleLoadMoreNeighbors(
    nodeId: AssetGraphNodeId,
    triggerButton?: HTMLButtonElement | null,
  ) {
    setSrAnnouncement("");
    clearPendingExpandFocus();
    const shouldRestoreFocus = Boolean(
      triggerButton && document.activeElement === triggerButton,
    );
    const prevSeq = store.getState().activeRequestSeq;
    const loadPromise = store.loadMoreNeighbors(nodeId);
    const startedState = store.getState();
    if (shouldRestoreFocus && triggerButton && startedState.activeRequestSeq !== prevSeq) {
      pendingExpandFocusRef.current = {
        button: triggerButton,
        generation: startedState.requestGeneration,
        requestSeq: startedState.activeRequestSeq,
      };
    }
    const result = await loadPromise;
    if (!mountedRef.current) return;
    if (!result.applied) {
      if (
        pendingExpandFocusRef.current?.generation === startedState.requestGeneration &&
        pendingExpandFocusRef.current?.requestSeq === startedState.activeRequestSeq
      ) {
        pendingExpandFocusRef.current = null;
      }
      return;
    }
    setSrAnnouncement(result.announcement);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearPendingExpandFocus();
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: searchInput,
      selectedKinds: kindInput ? [kindInput] : [],
      pageLimit: limitInput,
    });
  }

  function handleKindFilterChange(nextKind: AssetGraphRootKind | "") {
    setKindInput(nextKind);
    clearPendingExpandFocus();
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: searchInput,
      selectedKinds: nextKind ? [nextKind] : [],
      pageLimit: limitInput,
    });
  }

  function handleLimitChange(nextLimit: number) {
    setLimitInput(nextLimit);
    clearPendingExpandFocus();
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
    clearPendingExpandFocus();
    resetActionTransientState();
    void store.applyFilters({
      searchQuery: "",
      selectedKinds: [],
      pageLimit: ASSET_GRAPH_DEFAULT_LIMIT,
    });
  }

  async function executeStartRequirement(
    action: StartAction,
    reusePending?: PendingStartIntent,
    options?: StartOptions,
  ) {
    if (startBusyRef.current) return;
    const signature = startActionSignature(action, options);
    const intent: PendingStartIntent =
      reusePending && reusePending.signature === signature
        ? reusePending
        : pendingStart && pendingStart.signature === signature
          ? pendingStart
          : {
              signature,
              action,
              clientKey: createStartIntentKey(),
              minutes: options?.minutes ?? selectedMinutes,
              ...(options?.taskId && options?.expectedTaskVersion
                ? {
                    taskId: options.taskId,
                    expectedTaskVersion: options.expectedTaskVersion,
                  }
                : {}),
            };

    startBusyRef.current = true;
    setStartBusy(true);
    setStartingRequirementId(action.requirementId);
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
        ...(intent.taskId && intent.expectedTaskVersion
          ? {
              taskId: intent.taskId,
              expectedTaskVersion: intent.expectedTaskVersion,
            }
          : {}),
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
        setStartingRequirementId(null);
      }
    }
  }

  function handleLocateRequirement(requirementId: string) {
    const reqNodeId = `requirement/${requirementId}` as AssetGraphNodeId;
    clearPendingExpandFocus();
    resetActionTransientState();
    setViewMode("graph");
    if (getOwn(state.nodesById, reqNodeId)) {
      store.focusNode(reqNodeId);
      setLocateRequest({ id: reqNodeId, sequence: ++locateSeqRef.current });
      void store.loadDetail(reqNodeId);
      return;
    }
    void store.loadDetail(reqNodeId).then(() => {
      if (!mountedRef.current) return;
      if (getOwn(store.getState().nodesById, reqNodeId)) {
        setLocateRequest({ id: reqNodeId, sequence: ++locateSeqRef.current });
      }
    });
  }

  function handleStartBoundRetest(
    courseId: string,
    taskContext: Extract<CourseRouteTaskContext, { managed: true }>,
  ) {
    const action: StartAction = {
      kind: "startCourseRequirement",
      label: "开始独立复测",
      courseId,
      goalId: taskContext.goalId,
      expectedGoalRevision: taskContext.expectedGoalRevision,
      requirementId: taskContext.requirementId,
      expectedRequirementRevision: taskContext.expectedRequirementRevision,
    };
    void executeStartRequirement(action, undefined, {
      minutes: taskContext.minutes,
      taskId: taskContext.taskId,
      expectedTaskVersion: taskContext.expectedTaskVersion,
    });
  }

  async function handleStartOrdinaryPractice(
    courseId: string,
    progress: CourseRequirementProgress,
    minutes: number,
  ) {
    if (startBusyRef.current) return;
    const reqId = progress.requirement.id;
    const reqNodeId = `requirement/${reqId}` as AssetGraphNodeId;

    const findMatchingStartAction = (): StartAction | undefined => {
      const currentDetail = store.getState().detail;
      if (!currentDetail || currentDetail.id !== reqNodeId) return undefined;
      return currentDetail.actions.find(
        (item): item is StartAction =>
          item.kind === "startCourseRequirement" &&
          item.courseId === courseId &&
          item.requirementId === reqId,
      );
    };

    let matchedAction = findMatchingStartAction();
    if (!matchedAction) {
      setStartError("");
      setChoiceResult(null);
      setStartingRequirementId(reqId);
      await store.loadDetail(reqNodeId);
      if (!mountedRef.current) return;
      matchedAction = findMatchingStartAction();
    }

    if (!matchedAction) {
      setStartingRequirementId(null);
      setStartError("这项要求暂未关联活跃学习目标，请先前往课程页面确认目标后再开始。");
      return;
    }

    await executeStartRequirement(matchedAction, undefined, { minutes });
  }

  const resolvedCourse = useMemo<{ id: string; title: string | null } | null>(() => {
    if (state.context.kind === "course") {
      const id = state.context.id.startsWith("course/")
        ? state.context.id.slice("course/".length)
        : state.context.id;
      const fromProp = courses.find(course => course.id === id);
      const fromNode = getOwn(state.nodesById, state.context.id);
      return { id, title: fromProp?.title ?? fromNode?.label ?? null };
    }
    if (state.context.kind === "workspace") {
      if (courses.length === 1) {
        return { id: courses[0]!.id, title: courses[0]!.title };
      }
      if (courses.length === 0) {
        const visibleCourseNodes = visibleNodes.filter(node => node.kind === "course");
        if (visibleCourseNodes.length === 1) {
          const single = visibleCourseNodes[0]!;
          const id = single.id.startsWith("course/") ? single.id.slice("course/".length) : single.id;
          return { id, title: single.label };
        }
      }
    }
    return null;
  }, [state.context, courses, state.nodesById, visibleNodes]);

  const contextKey = serializeContextValue(state.context);
  const canvasLayoutKey = `${contextKey}:${state.lens}:p${privacyGeneration}`;
  const canvasPersistKey = buildFreeMapPersistKey(getVerifiedSessionIdentity(), contextKey);

  const effectiveStates = resolveEffectiveNodeStates(selectedNode, activeDetail);
  const effectiveLearnerState = effectiveStates.learnerState ?? null;
  const effectiveRequirementStatus = effectiveStates.requirementStatus ?? null;
  const pinnedStates = state.pinnedComparison
    ? resolveEffectiveNodeStates(state.pinnedComparison.node, state.pinnedComparison.detail)
    : null;

  if (sandboxMode === "series") {
    return (
      <SeriesMapExample
        returnHref="/opening/map"
        onExit={() => {
          setSandboxMode(null);
        }}
      />
    );
  }

  return (
    <section
      ref={workspaceRootRef}
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg text-text"
    >
      <div role="status" aria-live="polite" className="sr-only">
        {srAnnouncement}
      </div>

      <PageHeader
        title="知识地图"
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-open-series-sandbox
              className={ui.secondary}
              onClick={() => setSandboxMode("series")}
            >
              <FlaskConical size={14} aria-hidden="true" />
              数项级数示例沙盒
            </button>
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
                <div role="toolbar" aria-label="视图模式" className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className={viewMode === "graph" ? ui.primary : ui.secondary}
                    aria-pressed={viewMode === "graph"}
                    onClick={() => {
                      clearPendingExpandFocus();
                      setViewMode("graph");
                    }}
                  >
                    <Network size={14} aria-hidden="true" />
                    关系图
                  </button>
                  <button
                    type="button"
                    className={viewMode === "list" ? ui.primary : ui.secondary}
                    aria-pressed={viewMode === "list"}
                    onClick={() => {
                      clearPendingExpandFocus();
                      if (viewMode !== "list") {
                        if (listSubTab === null && isListDataReady) {
                          setListSubTab(visibleEdges.length > 0 ? "relations" : "nodes");
                        }
                        setViewMode("list");
                      }
                    }}
                  >
                    <List size={14} aria-hidden="true" />
                    列表
                  </button>
                </div>

                {viewMode === "graph" ? (
                  <div role="toolbar" aria-label="画布注记模式" className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={mapMode === "exam" ? ui.primary : ui.secondary}
                      aria-pressed={mapMode === "exam"}
                      onClick={() => setMapMode("exam")}
                    >
                      备考状态
                    </button>
                    <button
                      type="button"
                      className={mapMode === "study" ? ui.primary : ui.secondary}
                      aria-pressed={mapMode === "study"}
                      onClick={() => setMapMode("study")}
                    >
                      结构整理
                    </button>
                  </div>
                ) : null}

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
                      clearPendingExpandFocus();
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
              <label className="min-w-56 flex-1 space-y-1">
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
              ref={noticeContainerRef}
              tabIndex={-1}
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-tile border border-line-strong bg-surface-2 px-4 py-3 text-sm text-text focus:outline-none"
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
                onClick={() => {
                  clearPendingExpandFocus();
                  void store.retryCurrentView();
                }}
              >
                <RefreshCw size={14} aria-hidden="true" />
                重试读取
              </button>
            </div>
          ) : null}

          {state.error ? (
            <div ref={errorContainerRef} tabIndex={-1} className="focus:outline-none">
              <LoadError
                message={state.error.message}
                onRetry={() => {
                  clearPendingExpandFocus();
                  void store.retryCurrentView();
                }}
              />
            </div>
          ) : null}

          {resolvedCourse && typeof examRouteClient.read === "function" ? (
            <div className="space-y-2">
              <AssetGraphExamPanel
                courseId={resolvedCourse.id}
                courseTitle={resolvedCourse.title}
                asOf={state.asOf}
                routeClient={examRouteClient}
                busy={startBusy}
                startingRequirementId={startingRequirementId}
                onLocateRequirement={handleLocateRequirement}
                onStartOrdinaryPractice={(courseId, progress, minutes) => {
                  void handleStartOrdinaryPractice(courseId, progress, minutes);
                }}
                onStartBoundRetest={handleStartBoundRetest}
              />
              {!activeDetail && startError ? (
                <p
                  role="alert"
                  className="rounded-ctl border border-danger/40 bg-surface px-3 py-2 text-xs text-danger"
                >
                  {startError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_var(--layout-companion)]">
            <div
              ref={workspaceContentRef}
              tabIndex={-1}
              data-workspace-content
              className="min-w-0 space-y-4 focus:outline-none"
            >
              {state.loadingRoots && visibleNodes.length === 0 ? (
                <div className="rounded-tile border border-line bg-surface p-5">
                  <p role="status" className="mb-3 text-sm text-text-2">
                    正在读取个人知识地图…
                  </p>
                  <LoadingRows label="正在读取个人知识地图" />
                </div>
              ) : visibleNodes.length > 0 ? (
                viewMode === "list" ? (
                  <AssetGraphListView
                    key={serializeContextValue(state.context)}
                    nodes={visibleNodes}
                    edges={visibleEdges}
                    nodesById={state.nodesById}
                    selectedNodeId={state.selectedNodeId}
                    activeDetail={activeDetail}
                    pinnedNodeId={state.pinnedComparison?.node.id ?? null}
                    context={state.context}
                    lens={state.lens}
                    subTab={listSubTab}
                    onSubTabChange={tab => {
                      clearPendingExpandFocus();
                      setListSubTab(tab);
                    }}
                    expandedCenters={state.expandedCenters}
                    expandingNodeId={state.expandingNodeId}
                    loadingDetailNodeId={state.loadingDetailNodeId}
                    onSelectNode={nodeId => {
                      clearPendingExpandFocus();
                      resetActionTransientState();
                      store.focusNode(nodeId);
                    }}
                    onExpandNode={(nodeId, direction, triggerButton) => {
                      void handleExpandNode(nodeId, direction, triggerButton);
                    }}
                    onCollapseNode={nodeId => {
                      clearPendingExpandFocus();
                      store.collapseNode(nodeId);
                    }}
                    onLoadMoreNeighbors={(nodeId, triggerButton) => {
                      void handleLoadMoreNeighbors(nodeId, triggerButton);
                    }}
                    onLoadDetail={nodeId => {
                      clearPendingExpandFocus();
                      resetActionTransientState();
                      void store.loadDetail(nodeId);
                    }}
                    onEnterContext={(nextContext, focusId) => {
                      handleContextChange(nextContext, focusId);
                    }}
                    onTogglePinNode={nodeId => {
                      clearPendingExpandFocus();
                      store.togglePinNode(nodeId);
                    }}
                  />
                ) : (
                  <AssetGraphCanvas
                    nodes={visibleNodes}
                    edges={visibleEdges}
                    rootIds={state.rootIds}
                    selectedNodeId={state.selectedNodeId}
                    activeDetail={activeDetail}
                    pinnedNodeId={state.pinnedComparison?.node.id ?? null}
                    context={state.context}
                    lens={state.lens}
                    mode={mapMode}
                    layoutKey={canvasLayoutKey}
                    persistKey={canvasPersistKey}
                    locateRequest={locateRequest}
                    expandedCenters={state.expandedCenters}
                    expandingNodeId={state.expandingNodeId}
                    loadingDetailNodeId={state.loadingDetailNodeId}
                    onSelectNode={nodeId => {
                      clearPendingExpandFocus();
                      resetActionTransientState();
                      store.focusNode(nodeId);
                    }}
                    onExpandNode={(nodeId, direction, triggerButton) => {
                      void handleExpandNode(nodeId, direction, triggerButton);
                    }}
                    onCollapseNode={nodeId => {
                      clearPendingExpandFocus();
                      store.collapseNode(nodeId);
                    }}
                    onLoadMoreNeighbors={(nodeId, triggerButton) => {
                      void handleLoadMoreNeighbors(nodeId, triggerButton);
                    }}
                    onLoadDetail={nodeId => {
                      clearPendingExpandFocus();
                      resetActionTransientState();
                      void store.loadDetail(nodeId);
                    }}
                    onEnterContext={(nextContext, focusId) => {
                      handleContextChange(nextContext, focusId);
                    }}
                    onTogglePinNode={nodeId => {
                      clearPendingExpandFocus();
                      store.togglePinNode(nodeId);
                    }}
                  />
                )
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
                    onClick={() => {
                      clearPendingExpandFocus();
                      void store.loadMoreRoots();
                    }}
                  >
                    {state.loadingMoreRoots ? "正在加载下一页…" : "加载下一页"}
                  </button>
                </div>
              ) : null}
            </div>

            <aside
              aria-label="详情与后续行动面板"
              className="h-fit space-y-4 rounded-tile border border-line bg-surface p-4 shadow-card lg:sticky lg:top-4"
            >
              {state.pinnedComparison ? (
                <section
                  aria-label="对比参考卡片"
                  className="space-y-2 rounded-ctl border border-line bg-surface-2/50 p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-text">对比参考</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-text-2 hover:text-text"
                      onClick={() => store.clearPinnedNode()}
                    >
                      <PinOff size={12} aria-hidden="true" />
                      取消固定
                    </button>
                  </div>
                  <button
                    type="button"
                    className="block text-left font-medium text-accent hover:underline"
                    onClick={() => store.focusNode(state.pinnedComparison!.node.id)}
                  >
                    [{NODE_KIND_LABELS[state.pinnedComparison.node.kind]}]{" "}
                    {state.pinnedComparison.node.label}
                  </button>
                  {pinnedStates?.learnerState || pinnedStates?.requirementStatus ? (
                    <div className="flex flex-wrap gap-1.5">
                      {pinnedStates.learnerState ? (
                        <span className={`${ui.badge} ${tone.neutral}`}>
                          {LEARNER_STATE_LABELS[pinnedStates.learnerState]}
                        </span>
                      ) : null}
                      {pinnedStates.requirementStatus ? (
                        <span
                          className={`${ui.badge} ${requirementStatusBadgeTone(
                            pinnedStates.requirementStatus,
                          )}`}
                        >
                          {REQUIREMENT_STATUS_LABELS[pinnedStates.requirementStatus]}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

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
                            effectiveRequirementStatus
                              ? requirementStatusBadgeTone(effectiveRequirementStatus)
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
                          clearPendingExpandFocus();
                          resetActionTransientState();
                          void store.loadDetail(selectedNode.id);
                        }}
                      >
                        <FileSearch size={14} aria-hidden="true" />
                        {state.loadingDetailNodeId === selectedNode.id
                          ? "正在读取详情…"
                          : activeDetail
                            ? "刷新详情"
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
                            这项内容下暂时没有可直接打开的后续入口。
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
                        {connectedEdges.outgoing.map(edge => (
                          <ConnectedEdgeItem
                            key={edge.id}
                            edge={edge}
                            direction="out"
                            endpointNode={getOwn(state.nodesById, edge.to)}
                            onFocusNode={store.focusNode}
                          />
                        ))}
                        {connectedEdges.incoming.map(edge => (
                          <ConnectedEdgeItem
                            key={edge.id}
                            edge={edge}
                            direction="in"
                            endpointNode={getOwn(state.nodesById, edge.from)}
                            onFocusNode={store.focusNode}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="space-y-2 text-sm text-text-2">
                  <h2 className="text-base font-semibold text-text">详情与行动</h2>
                  <p className="text-xs leading-6 text-text-3">
                    在左侧关系图或列表中点选任意一项，或点击“查看详情”阅读依据说明与后续学习入口。
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
