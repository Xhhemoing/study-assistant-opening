"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActivitySpecClientInit,
  LearningResume,
  LearningAttempt,
  LearningObservation,
  TeachingActivity,
  TeachingCommandConflict,
  TeachingCommandSuccess,
  TeachingSourceRef,
} from "@aistudy/contracts";
import {
  WHY_ASSIST_AVAILABLE,
  resolveTeachingBlockFocus,
} from "@aistudy/domain";
import { ui, tone } from "../design/ui";
import { createOpeningApi, type OpeningApi } from "../client/api";
import {
  BlockCommands,
  isBranchStackEmpty,
} from "./block-commands";
import { TeachingBlockItem } from "./teaching-block-item";
import {
  isKnownSchemaVersion,
  readSchemaVersion,
} from "./component-catalog";
import {
  canRequestTeachingCompile,
  formatActivityUpdatedAt,
  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";
import { PreferenceControls } from "./preference-controls";
import { ResumeCard, type LocalUnsentDraft } from "./resume-card";
import { ActivityEndControl } from "./activity-end-control";
import { TeachingGoalGuidance } from "./goal-guidance";
import { sourceViewerHref } from "../inbox/source-viewer";
import { StudyToolsPanel } from "./study-tools-panel";
import { buildTeachingStudyUnits, saveTeachingUnitPosition, teachingStudyUnitText, teachingUnitForBlock, type TeachingStudyUnit } from "./study-unit-focus";

export type TeachingToolsContext = {
  activity: TeachingActivity;
  blockId: string | null;
  contentVersion: number;
  unitTitle: string;
  unitText: string;
  sourceRefs: TeachingSourceRef[];
  sourceNameById?: Record<string, string>;
  isQuestion: boolean;
  learningAttempt?: LearningAttempt | null;
};

type ContextualTeachingTools = ReactNode | ((context: TeachingToolsContext) => ReactNode);

export type TeachingWorkspacePositionSnapshot = {
  activityId: string;
  contentVersion: number;
  pathVersion: number;
  epoch: number;
};

function sameWorkspaceSnapshot(a: TeachingWorkspacePositionSnapshot, b: TeachingWorkspacePositionSnapshot): boolean {
  return a.activityId === b.activityId && a.contentVersion === b.contentVersion && a.pathVersion === b.pathVersion && a.epoch === b.epoch;
}

/** A late cursor response must not replace a newer command, reread or parent snapshot. */
export async function saveCurrentTeachingUnitPosition(api: Pick<OpeningApi, "postTeachingCheckpoint">, snapshot: TeachingWorkspacePositionSnapshot, current: () => TeachingWorkspacePositionSnapshot, targetBlockId: string, apply: (result: Awaited<ReturnType<typeof saveTeachingUnitPosition>>) => void): Promise<void> {
  const result = await saveTeachingUnitPosition(api, snapshot.activityId, snapshot.contentVersion, targetBlockId);
  if (!sameWorkspaceSnapshot(snapshot, current())) throw new Error("学习内容或位置已变化，刚才的位置响应未采用。请重新读取后继续，原草稿仍保留。");
  apply(result);
}

export type TeachingWorkspaceProps = {
  activity: TeachingActivity;
  clientInit: ActivitySpecClientInit;
  assistantHref?: string | null;
  timeZone?: string;
  /** Optional OpeningApi inject (tests). */
  api?: OpeningApi;
  onActivityUpdated?: (activity: TeachingActivity) => void;
  /**
   * Optional sourceId → display name map (tests / parent inject).
   * When omitted, workspace resolves names via api.listSources().
   */
  sourceNameById?: Record<string, string> | null;
  contextualTools?: ContextualTeachingTools;
};

/**
 * Usable gate: ready or needs_check with published (non-empty) blocks.
 * needs_check is admitted for learning with an explicit 「待核对」 affordance;
 * failed/cancelled/stale/empty still refuse.
 */
export function isTeachingWorkspaceContentUsable(
  activity: Pick<TeachingActivity, "generateStatus">,
  clientInit: ActivitySpecClientInit | null | undefined,
): boolean {
  if (activity.generateStatus !== "ready" && activity.generateStatus !== "needs_check") {
    return false;
  }
  if (!clientInit) return false;
  if (!Array.isArray(clientInit.blocks) || clientInit.blocks.length === 0) return false;
  return true;
}

/**
 * Human-readable material label: title/filename when known; never bare UUID alone.
 * Short id may appear as secondary.
 */
export function formatTeachingSourceLabel(
  ref: Pick<TeachingSourceRef, "sourceId">,
  nameById?: ReadonlyMap<string, string> | Record<string, string> | null,
): { primary: string; secondary: string } {
  const shortId = `${ref.sourceId.slice(0, 8)}…`;
  let name: string | undefined;
  if (nameById instanceof Map) {
    name = nameById.get(ref.sourceId);
  } else if (nameById && typeof nameById === "object") {
    // `instanceof Map` does not narrow ReadonlyMap out of the union.
    name = (nameById as Record<string, string>)[ref.sourceId];
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed && trimmed !== ref.sourceId) {
    return { primary: trimmed, secondary: shortId };
  }
  return { primary: "未命名材料", secondary: shortId };
}

export function buildSourceNameMap(
  sources: readonly { id: string; name: string }[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const s of sources) {
    if (s.id && s.name) map[s.id] = s.name;
  }
  return map;
}

export function TeachingWorkspace({
  activity,
  clientInit: clientInitProp,
  assistantHref,
  timeZone = "Asia/Shanghai",
  api: apiProp,
  onActivityUpdated,
  sourceNameById: sourceNameByIdProp = null,
  contextualTools,
}: TeachingWorkspaceProps) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [liveActivity, setLiveActivity] = useState(activity);
  const [liveInit, setLiveInit] = useState<ActivitySpecClientInit>(clientInitProp);
  const [contentVersion, setContentVersion] = useState(
    clientInitProp.contentVersion ?? activity.contentVersion,
  );
  const [pathVersion, setPathVersion] = useState(activity.pathVersion);
  const [workspaceConflict, setWorkspaceConflict] =
    useState<TeachingCommandConflict | null>(null);
  const [rereadError, setRereadError] = useState<string | null>(null);
  const [fetchedSourceNames, setFetchedSourceNames] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [positionBusy, setPositionBusy] = useState(false);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Record<string, LearningAttempt>>({});
  const [observations, setObservations] = useState<Record<string, LearningObservation>>({});
  const positionInFlight = useRef(false);
  const commandInFlight = useRef(false);
  const positionSnapshot = useRef<TeachingWorkspacePositionSnapshot>({ activityId: activity.id, contentVersion: clientInitProp.contentVersion ?? activity.contentVersion, pathVersion: activity.pathVersion, epoch: 0 });
  const commandSnapshot = useRef<TeachingWorkspacePositionSnapshot | null>(null);
  const parentSnapshot = useRef({ activity, clientInit: clientInitProp });
  const contentRef = useRef<HTMLDivElement>(null);
  // Invalidate pending work as soon as changed parent input is rendered, before its effect applies.
  if (parentSnapshot.current.activity !== activity || parentSnapshot.current.clientInit !== clientInitProp) {
    positionSnapshot.current = { ...positionSnapshot.current, epoch: positionSnapshot.current.epoch + 1 };
    parentSnapshot.current = { activity, clientInit: clientInitProp };
  }

  const markSnapshot = useCallback((next: Partial<Omit<TeachingWorkspacePositionSnapshot, "epoch">> = {}) => {
    positionSnapshot.current = { ...positionSnapshot.current, ...next, epoch: positionSnapshot.current.epoch + 1 };
  }, []);

  const commandApi = useMemo<OpeningApi>(() => ({ ...api, async postTeachingCommand(id, input) {
    if (positionInFlight.current || commandInFlight.current) throw new Error("另一项学习操作仍在保存，请稍后再试。");
    const latest = positionSnapshot.current;
    if (id !== latest.activityId || input.expectedVersion !== latest.contentVersion || (input.expectedPathVersion != null && input.expectedPathVersion !== latest.pathVersion)) throw new Error("学习内容已切换，请重新读取当前内容后再操作。");
    commandInFlight.current = true;
    markSnapshot();
    commandSnapshot.current = { ...positionSnapshot.current };
    try { return await api.postTeachingCommand(id, input); }
    finally { commandInFlight.current = false; }
  } }), [api, markSnapshot]);

  // Sync when parent passes a new activity/init identity (e.g. today dashboard reload).
  useEffect(() => {
    const incomingVersion = clientInitProp.contentVersion ?? activity.contentVersion;
    const latest = positionSnapshot.current;
    if (latest.activityId === activity.id && (incomingVersion < latest.contentVersion || activity.pathVersion < latest.pathVersion)) {
      setPositionError("收到的课程快照已过期，保留当前学习位置。请重新读取后继续。");
      return;
    }
    markSnapshot({ activityId: activity.id, contentVersion: incomingVersion, pathVersion: activity.pathVersion });
    setLiveActivity(activity);
    setLiveInit(clientInitProp);
    setContentVersion(clientInitProp.contentVersion ?? activity.contentVersion);
    setPathVersion(activity.pathVersion);
  }, [
    activity.id,
    activity.contentVersion,
    activity.pathVersion,
    activity.updatedAt,
    clientInitProp.id,
    clientInitProp.version,
    clientInitProp.contentVersion,
    clientInitProp.updatedAt,
    clientInitProp,
    markSnapshot,
  ]);

  const schemaVersion = useMemo(() => readSchemaVersion(liveInit), [liveInit]);
  const schemaOk = isKnownSchemaVersion(schemaVersion);
  const orderedBlocks = useMemo(
    () => [...liveInit.blocks].sort((a, b) => a.position - b.position),
    [liveInit.blocks],
  );
  const blockFocus = useMemo(
    () => resolveTeachingBlockFocus(orderedBlocks, liveInit.checkpointJson ?? {}),
    [orderedBlocks, liveInit.checkpointJson],
  );
  const units = useMemo(() => buildTeachingStudyUnits(orderedBlocks), [orderedBlocks]);
  const currentUnit = teachingUnitForBlock(units, blockFocus.currentBlockId);
  const currentIndex = currentUnit ? units.indexOf(currentUnit) : -1;
  const currentUnitId = currentUnit?.id ?? null;
  const [visitedUnits, setVisitedUnits] = useState<Set<string>>(() => new Set(currentUnitId ? [currentUnitId] : []));
  const currentQuestionId = currentUnit?.questionBlockId ?? null;
  const sourceNameById = useMemo(() => {
    if (sourceNameByIdProp && Object.keys(sourceNameByIdProp).length) {
      return sourceNameByIdProp;
    }
    return fetchedSourceNames;
  }, [sourceNameByIdProp, fetchedSourceNames]);

  useEffect(() => {
    if (sourceNameByIdProp && Object.keys(sourceNameByIdProp).length) return;
    const ids = new Set<string>([
      ...liveInit.sourceRefs.map((r) => r.sourceId),
      ...(liveActivity.sourceIds ?? []),
    ]);
    if (!ids.size) return;
    let cancelled = false;
    void (async () => {
      try {
        const sources = await api.listSources();
        if (cancelled) return;
        setFetchedSourceNames(buildSourceNameMap(sources.filter((s) => ids.has(s.id))));
      } catch {
        // fail-soft: keep 未命名材料 labels
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, liveActivity.sourceIds, liveInit.sourceRefs, sourceNameByIdProp]);

  useEffect(() => {
    if (currentUnitId) setVisitedUnits(previous => new Set([...previous, currentUnitId]));
    const heading = contentRef.current?.querySelector<HTMLElement>('[data-study-unit-current="true"] h3');
    heading?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  }, [currentUnitId]);

  const returnDisabled = isBranchStackEmpty(liveInit.checkpointJson ?? {});
  const generateTone =
    liveActivity.generateStatus === "failed" || liveActivity.generateStatus === "stale"
      ? tone.danger
      : liveActivity.generateStatus === "ready"
        ? tone.success
        : liveActivity.generateStatus === "needs_check"
          ? tone.warning
          : tone.neutral;

  const applySuccess = useCallback((result: TeachingCommandSuccess) => {
    const started = commandSnapshot.current;
    if (!started || !sameWorkspaceSnapshot(started, positionSnapshot.current) || result.contentVersion < started.contentVersion || result.pathVersion < started.pathVersion) {
      setPositionError("学习内容或位置已变化，刚才的操作结果需重新读取确认。原草稿仍保留。");
      return;
    }
    markSnapshot({ contentVersion: result.contentVersion, pathVersion: result.pathVersion });
    setWorkspaceConflict(null);
    setContentVersion(result.contentVersion);
    setPathVersion(result.pathVersion);
    if (result.clientInit) {
      setLiveInit(result.clientInit);
    } else if (result.checkpointJson) {
      setLiveInit((prev) => ({
        ...prev,
        contentVersion: result.contentVersion,
        checkpointJson: result.checkpointJson,
      }));
    }
  }, [markSnapshot]);

  const handleConflict = useCallback((conflict: TeachingCommandConflict) => {
    setWorkspaceConflict(conflict);
  }, []);

  const reread = useCallback(async () => {
    setRereadError(null);
    markSnapshot();
    const started = { ...positionSnapshot.current };
    const [freshInit, freshActivity] = await Promise.all([
      api.getTeachingClientInit(started.activityId),
      api.getTeachingActivity(started.activityId),
    ]);
    if (!sameWorkspaceSnapshot(started, positionSnapshot.current)) throw new Error("重新读取期间学习状态又有变化，较早的快照未采用。请再读取一次，原草稿仍保留。");
    const freshVersion = freshInit.contentVersion ?? freshActivity.contentVersion;
    if (freshVersion < started.contentVersion || freshActivity.pathVersion < started.pathVersion) throw new Error("读取到较早的课程快照，保留当前学习位置。请稍后重新读取。");
    markSnapshot({ contentVersion: freshVersion, pathVersion: freshActivity.pathVersion });
    setLiveInit(freshInit);
    setLiveActivity(freshActivity);
    setContentVersion(freshInit.contentVersion ?? freshActivity.contentVersion);
    setPathVersion(freshActivity.pathVersion);
    setWorkspaceConflict(null);
  }, [api, markSnapshot]);

  const handleBlockReread = useCallback(async () => {
    try {
      await reread();
    } catch (err) {
      setRereadError(
        err instanceof Error ? err.message : "重新拉取失败",
      );
      throw err;
    }
  }, [reread]);

  const navigateUnit = useCallback(async (unit: TeachingStudyUnit) => {
    if (positionInFlight.current || !schemaOk) return;
    if (commandInFlight.current) { setPositionError("学习操作仍在保存，请稍后切换单元。"); return; }
    positionInFlight.current = true; setPositionBusy(true); setPositionError(null);
    const started = { ...positionSnapshot.current };
    try {
      await saveCurrentTeachingUnitPosition(api, started, () => positionSnapshot.current, unit.questionBlockId ?? unit.id, result => {
        markSnapshot({ contentVersion: result.contentVersion });
        setLiveInit(previous => ({ ...previous, contentVersion: result.contentVersion, checkpointJson: result.checkpointJson }));
        setContentVersion(result.contentVersion);
        setVisitedUnits(previous => new Set([...previous, unit.id]));
        setPanel(null);
        requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>('[data-study-unit-current="true"] h3')?.focus({ preventScroll: true }));
      });
    } catch (error) { setPositionError(error instanceof Error ? error.message : "学习位置保存未确认，请重新读取后继续。"); }
    finally { positionInFlight.current = false; setPositionBusy(false); }
  }, [api, markSnapshot, schemaOk]);

  const updateLiveActivity = useCallback((next: TeachingActivity) => {
    markSnapshot({ activityId: next.id, contentVersion: next.contentVersion, pathVersion: next.pathVersion });
    setLiveActivity(next);
    onActivityUpdated?.(next);
  }, [markSnapshot, onActivityUpdated]);

  const onAttemptReady = useCallback((blockId: string, attempt: LearningAttempt) => {
    setAttempts(previous => ({ ...previous, [`${liveActivity.id}:${blockId}:${contentVersion}`]: attempt }));
  }, [contentVersion, liveActivity.id]);

  const onObservationReady = useCallback((blockId: string, observation: LearningObservation) => {
    setObservations(previous => ({ ...previous, [`${liveActivity.id}:${blockId}:${contentVersion}`]: observation }));
  }, [contentVersion, liveActivity.id]);
  const questionSubmitted = !currentQuestionId || Boolean(observations[`${liveActivity.id}:${currentQuestionId}:${contentVersion}`]);

  const attemptContext = useMemo(
    () => ({
      ...liveActivity,
      contentVersion,
      outlineTitle: typeof liveInit.generationConfig.extras?.focusItemTitle === "string"
        ? liveInit.generationConfig.extras.focusItemTitle : undefined,
      onCourseAssociated: (next: TeachingActivity) => {
        updateLiveActivity(next);
      },
      onAttemptReady,
      onObservationReady,
    }),
    [liveActivity, contentVersion, liveInit.generationConfig, updateLiveActivity, onAttemptReady, onObservationReady],
  );

  const showBlockCommands = liveActivity.status !== "completed" && schemaOk;
  const toolsContext: TeachingToolsContext = {
    activity: { ...liveActivity, contentVersion, pathVersion },
    blockId: currentQuestionId ?? blockFocus.currentBlockId,
    contentVersion,
    unitTitle: currentUnit?.title ?? liveActivity.intentSummary,
    unitText: teachingStudyUnitText(currentUnit),
    sourceRefs: liveInit.sourceRefs,
    sourceNameById,
    isQuestion: Boolean(currentQuestionId),
    learningAttempt: currentQuestionId ? attempts[`${liveActivity.id}:${currentQuestionId}:${contentVersion}`] ?? null : null,
  };
  const contextualContent = typeof contextualTools === "function" ? contextualTools(toolsContext) : contextualTools;
  const toggleWholeLesson = () => {
    if (!showAll) setVisitedUnits(previous => new Set([...previous, ...units.map(unit => unit.id)]));
    setShowAll(value => !value);
  };
  const panels = [
    { id: "outline", label: "提纲与回看", content: <div className="space-y-4">
      <p className="text-xs leading-6 text-zinc-500">回看完整知识单元，切换位置会保存阅读断点。</p>
      <ol className="space-y-1">{units.map((unit, index) => <li key={unit.id}><button type="button" className={`${ui.quiet} h-auto w-full justify-start whitespace-normal py-2 text-left ${unit.id === currentUnitId ? "bg-emerald-50 text-emerald-900" : ""}`} aria-current={unit.id === currentUnitId ? "step" : undefined} disabled={positionBusy} onClick={() => { void navigateUnit(unit); }}>{index + 1}. {unit.title}</button></li>)}</ol>
      <button type="button" className={ui.secondary} onClick={toggleWholeLesson} aria-pressed={showAll}>{showAll ? "只看当前单元" : "查看整节内容"}</button>
      {liveInit.goals.length ? <details className="text-xs leading-6 text-zinc-600"><summary className="cursor-pointer">本节目标</summary><ul className="mt-2 list-disc space-y-1 pl-4">{liveInit.goals.map(goal => <li key={goal.goalId}>{goal.statement}</li>)}</ul></details> : null}
    </div> },
    { id: "help", label: "学习帮助", content: currentUnit && showBlockCommands ? <BlockCommands key={toolsContext.blockId} activityId={liveActivity.id} blockId={toolsContext.blockId ?? currentUnit.id} contentVersion={contentVersion} pathVersion={pathVersion} returnDisabled={returnDisabled} disabled={positionBusy} whyAvailable={WHY_ASSIST_AVAILABLE} api={commandApi} onSuccess={applySuccess} onConflict={handleConflict} onReread={handleBlockReread} defaultOpen compact /> : <p className="text-xs leading-6 text-zinc-500">当前没有可以调整的学习内容。</p> },
    { id: "materials", label: "资料与引用", content: <div className="space-y-3">
      {liveInit.sourceRefs.length ? <ul className="space-y-3">{liveInit.sourceRefs.map((ref, index) => {
        const label = formatTeachingSourceLabel(ref, sourceNameById);
        const numericVersion = ref.version == null || (typeof ref.version === "string" && !/^\d+$/.test(ref.version.trim())) ? null : Number(ref.version);
        const version = numericVersion != null && Number.isInteger(numericVersion) && numericVersion >= 0 ? numericVersion : null;
        return <li key={`${ref.sourceId}:${index}`} className="space-y-1 text-xs leading-6" data-source-ref={ref.sourceId}>
          {version != null ? <a className="break-words font-medium text-emerald-800 underline underline-offset-4" href={sourceViewerHref(ref.sourceId, version, { page: ref.page })}>{label.primary}{ref.page != null ? ` · 第 ${ref.page} 页` : ""}</a> : <p className="break-words font-medium text-zinc-800">{label.primary}{ref.page != null ? ` · 第 ${ref.page} 页` : ""} · 引用版本待确认</p>}
          <details className="text-zinc-500"><summary className="cursor-pointer">来源详情</summary><p className="break-all">资料标识：{ref.sourceId}</p><p>引用版本：{ref.version ?? "未知"}</p>{ref.chunkId ? <p className="break-all">原始片段：{ref.chunkId}</p> : null}</details>
        </li>;
      })}</ul> : <p className="text-xs leading-6 text-zinc-500">本节没有附带可定位的资料引用。</p>}
      <p className="text-xs leading-6 text-zinc-500">打开引用后可返回原学习单元。历史引用使用原来的资料版本。</p>
    </div> },
    ...(contextualContent ? [{ id: "context", label: "提问与笔记", content: contextualContent }] : []),
    { id: "settings", label: "学习设置", content: <div className="space-y-4">
      <TeachingGoalGuidance focus={liveActivity.learnerFocus} />
      <PreferenceControls scope="session" activityId={liveActivity.id} courseId={liveActivity.courseId} expectedUpdatedAt={liveActivity.updatedAt} compact />
      <p className="text-xs leading-6 text-zinc-500">阅读进度只记录位置；掌握判断继续依据独立作答与后续练习。</p>
      <details className="space-y-2 text-xs leading-6 text-zinc-500"><summary className="cursor-pointer">诊断信息与草稿状态</summary>
        <p>最近更新 {formatActivityUpdatedAt(liveActivity.updatedAt, timeZone)}</p><p>内容版本 {contentVersion} · 路径版本 {pathVersion} · 校验 {liveInit.verificationStatus ?? "未知"}</p>
        <p className="break-all">活动标识：{liveActivity.id}</p><p className="break-all">当前位置：{blockFocus.currentBlockId ?? "未设置"}</p>
        <p>界面开关不改变 AI 介入偏好。个人答案与草稿继续使用原有保存流程。</p>
      </details>
      <Link href={assistantHref ?? (liveActivity.courseId ? `/opening/assistant?courseId=${encodeURIComponent(liveActivity.courseId)}` : "/opening/assistant")} className={ui.quiet}>自由探索</Link>
    </div> },
  ];

  return <section className="min-w-0 px-4 py-5 sm:px-6" aria-labelledby="teaching-workspace-heading" data-teaching-workspace="true" data-study-question={currentQuestionId ? "true" : "false"} data-content-version={contentVersion} data-path-version={pathVersion}>
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2"><BookOpen size={16} aria-hidden className="shrink-0 text-emerald-700" /><h2 id="teaching-workspace-heading" className="text-sm font-semibold text-zinc-900">本次学习</h2><span className="text-xs text-zinc-500">单元 {Math.max(1, currentIndex + 1)} / {units.length}</span></div>
      <span className={`${ui.badge} ${generateTone}`}>{liveActivity.status === "completed" ? "已结束" : liveActivity.generateStatus === "ready" ? teachingActivityStatusLabel(liveActivity.status) : liveActivity.generateStatus === "needs_check" ? "需要核查" : liveActivity.generateStatus === "queued" || liveActivity.generateStatus === "generating" ? "正在准备" : teachingActivityGenerateStatusLabel(liveActivity.generateStatus, { contentVersion })}</span>
    </header>
    <div className="mb-4 max-w-3xl space-y-1"><p className="text-sm font-medium leading-7 text-zinc-800">本次目标：{liveActivity.intentSummary}</p><p className="text-xs leading-6 text-zinc-500">读当前讲解 → 完成自己的尝试 → 保存并核对。结束本节后查看小结；记录位置和任务完成不等于掌握。</p></div>
    {liveActivity.generateStatus === "needs_check" ? <div className={`${tone.warning} mb-4 rounded-lg px-3 py-2 text-xs leading-6`} role="status" data-teaching-needs-check="true">主讲内容需要核查：内容已发布，来源校验尚未完成，可先学习。</div> : null}
    {workspaceConflict ? <div className={`${tone.warning} mb-4 space-y-2 rounded-lg px-3 py-2 text-xs leading-6`} role="status" data-workspace-command-conflict={workspaceConflict.conflict}><p>学习内容已更新，请重新读取后对照草稿。</p><p>{workspaceConflict.message}</p><button type="button" className={ui.secondary} onClick={() => { void handleBlockReread().catch(() => undefined); }}>重新读取学习内容</button><details><summary className="cursor-pointer">技术信息</summary><p>{workspaceConflict.conflict}</p></details></div> : null}
    {rereadError || positionError ? <div className="mb-4 space-y-2 text-xs leading-6 text-red-700" role="alert"><p>{rereadError ?? positionError}</p><button type="button" className={ui.secondary} onClick={() => { void handleBlockReread().then(() => setPositionError(null)).catch(() => undefined); }}>重新读取，保留草稿</button></div> : null}
    {!schemaOk ? <div className={`${tone.warning} mb-4 rounded-lg px-3 py-2 text-xs leading-6`} role="status" data-workspace-schema-fail="true">教学内容的格式暂不受支持。学习记录仍保留，请重新读取或查看活动小结。<details><summary className="cursor-pointer">技术信息</summary><p>schema 版本不受支持：{schemaVersion}</p></details></div> : null}
    <StudyToolsPanel panels={panels} activePanel={panel} onPanelChange={setPanel}>
      <div ref={contentRef} className="min-w-0 space-y-6" data-teaching-blocks="true" data-current-block-id={blockFocus.currentBlockId ?? ""}>
        {schemaOk ? units.map(unit => {
          const current = unit.id === currentUnitId;
          if (!showAll && !current && !visitedUnits.has(unit.id)) return null;
          return <div key={unit.id} hidden={!showAll && !current} className={current ? "space-y-5" : "space-y-5 [&_[data-inline-attempt]]:hidden"} data-study-unit={unit.id} data-study-unit-current={current ? "true" : "false"}>
            <h3 tabIndex={-1} className="break-words text-lg font-semibold leading-8 text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">{unit.title}</h3>
            {unit.blocks.filter(block => block.role !== "answer_key" && block.blockType !== "answer_key").map(block => <TeachingBlockItem key={block.blockId} block={block} focusStatus={blockFocus.statusById.get(block.blockId) ?? "upcoming"} schemaVersion={schemaVersion} sourceRefs={liveInit.sourceRefs} attemptContext={attemptContext} showCommands={false} activityId={liveActivity.id} contentVersion={contentVersion} pathVersion={pathVersion} returnDisabled={returnDisabled} whyAvailable={WHY_ASSIST_AVAILABLE} api={api} onSuccess={applySuccess} onConflict={handleConflict} onReread={handleBlockReread} unitChrome />)}
          </div>;
        }) : null}
        {schemaOk && currentUnit ? <nav aria-label="学习单元导航" className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4">
          {currentIndex > 0 ? <button type="button" className={ui.quiet} disabled={positionBusy} onClick={() => { const previous = units[currentIndex - 1]; if (previous) void navigateUnit(previous); }}><ArrowLeft size={14} aria-hidden />回看上一单元</button> : <span />}
          {units[currentIndex + 1] ? <button type="button" className={currentQuestionId ? ui.secondary : ui.primary} disabled={positionBusy || (!questionSubmitted && liveActivity.status !== "completed")} onClick={() => { const next = units[currentIndex + 1]; if (next) void navigateUnit(next); }} data-teaching-primary-advance={currentQuestionId ? "false" : "true"}>{positionBusy ? "正在保存位置…" : !questionSubmitted && liveActivity.status !== "completed" ? "先提交本题，再继续" : units[currentIndex + 1]?.questionBlockId ? "进入练习" : "下一单元"}<ArrowRight size={14} aria-hidden /></button> : null}
        </nav> : null}
        {currentQuestionId && units[currentIndex + 1] ? <p className="text-xs leading-6 text-zinc-500">保存原答案后可继续；也可从提纲回看其他内容。原草稿保留，浏览位置不代表题目已完成。</p> : null}
        <details open={currentIndex === units.length - 1 || liveActivity.status === "completed"} className="border-t border-zinc-200 pt-4"><summary className="cursor-pointer text-xs font-medium text-zinc-600">本次学习与小结</summary><div className="mt-3"><ActivityEndControl activity={liveActivity} api={api} onActivityUpdated={updateLiveActivity} /></div></details>
      </div>
    </StudyToolsPanel>
  </section>;
}


/** wait_init action visibility — no endless client-init retry when nothing is in flight. */
export function waitInitActionVisibility(input: {
  jobGate: "ready" | "in_flight" | "unknown" | "stale" | null | undefined;
  canCompile: boolean;
}): { showCompile: boolean; showRetryFetch: boolean; showBack: boolean } {
  const inFlight = input.jobGate === "in_flight";
  return {
    showCompile: input.canCompile,
    showRetryFetch: inFlight,
    showBack: true,
  };
}

/**
 * V2-14 continue entry: show LearningResume card, then mount TeachingWorkspace.
 * Prefers resume.clientInit when present; null clientInit → re-fetch / wait (fail-soft).
 * Does **not** route through ConversationResume.
 */
export type TeachingContinueEntryProps = {
  activity: TeachingActivity;
  /** Prefetched resume (optional; card fetches if omitted). */
  resume?: LearningResume | null;
  localUnsent?: LocalUnsentDraft[];
  assistantHref?: string | null;
  timeZone?: string;
  api?: OpeningApi;
  /** When true, skip card and open workspace immediately if usable clientInit given. */
  startInWorkspace?: boolean;
  initialClientInit?: ActivitySpecClientInit | null;
  onActivityUpdated?: (activity: TeachingActivity) => void;
  /**
   * When false, hide 「生成主讲内容」 (compiler off / capabilities).
   * Default true preserves prior call sites; Today wires the real switch.
   */
  teachingCompileEnabled?: boolean;
  contextualTools?: ContextualTeachingTools;
};

export function TeachingContinueEntry({
  activity: activityProp,
  resume: resumeProp = null,
  localUnsent,
  assistantHref,
  timeZone = "Asia/Shanghai",
  api: apiProp,
  startInWorkspace = false,
  initialClientInit = null,
  onActivityUpdated,
  teachingCompileEnabled = true,
  contextualTools,
}: TeachingContinueEntryProps) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [activity, setActivity] = useState(activityProp);
  const [phase, setPhase] = useState<"card" | "workspace" | "wait_init">(
    startInWorkspace &&
      initialClientInit &&
      isTeachingWorkspaceContentUsable(activityProp, initialClientInit)
      ? "workspace"
      : "card",
  );
  const [workspaceInit, setWorkspaceInit] = useState<ActivitySpecClientInit | null>(
    initialClientInit,
  );
  const [waitError, setWaitError] = useState<string | null>(null);
  const [waitBusy, setWaitBusy] = useState(false);
  const [liveResume, setLiveResume] = useState<LearningResume | null>(resumeProp);

  useEffect(() => {
    setActivity(activityProp);
  }, [activityProp]);

  useEffect(() => {
    if (resumeProp) setLiveResume(resumeProp);
  }, [resumeProp]);

  const openWorkspaceFromResume = useCallback(
    async (resume: LearningResume) => {
      setLiveResume(resume);
      setActivity(previous => ({ ...previous, status: resume.status, generateStatus: resume.generateStatus, contentVersion: resume.contentVersion, pathVersion: resume.pathVersion }));
      setWaitError(null);

      // Prefer resume.clientInit when present and usable.
      if (
        resume.clientInit &&
        isTeachingWorkspaceContentUsable(
          { generateStatus: resume.generateStatus },
          resume.clientInit,
        )
      ) {
        setWorkspaceInit(resume.clientInit);
        setPhase("workspace");
        return;
      }

      // clientInit null or not usable — fail-soft: try client-init fetch / show wait.
      if (resume.gates.job === "in_flight" || resume.gates.job === "unknown") {
        setPhase("wait_init");
        return;
      }

      setWaitBusy(true);
      setPhase("wait_init");
      try {
        const init = await api.getTeachingClientInit(activity.id);
        if (
          isTeachingWorkspaceContentUsable(
            { generateStatus: resume.generateStatus },
            init,
          )
        ) {
          setWorkspaceInit(init);
          setPhase("workspace");
        } else {
          setWaitError("主讲内容尚未可用；请稍后再继续。断点与草稿仍保留。");
        }
      } catch (err) {
        setWaitError(
          err instanceof Error
            ? err.message
            : "无法拉取 client-init；不会伪造讲义。",
        );
      } finally {
        setWaitBusy(false);
      }
    },
    [activity, api],
  );

  const backToCard = useCallback(() => {
    setPhase("card");
    setWaitError(null);
  }, []);

  // Re-read the resume so a finished job is seen; the cached one still says in_flight.
  const retryFromFreshResume = useCallback(async () => {
    setWaitBusy(true);
    try {
      const fresh = await api.getTeachingResume(activity.id);
      setWaitBusy(false);
      await openWorkspaceFromResume(fresh);
    } catch (err) {
      setWaitBusy(false);
      setWaitError(err instanceof Error ? err.message : "无法刷新断点；不会伪造讲义。");
    }
  }, [activity.id, api, openWorkspaceFromResume]);

  const requestCompile = useCallback(async () => {
    setWaitBusy(true);
    setWaitError(null);
    try {
      const next = await api.requestTeachingCompile(activity.id, `compile:${Date.now().toString(36)}`);
      setActivity(next);
      onActivityUpdated?.(next);
      setLiveResume(await api.getTeachingResume(activity.id));
    } catch (err) {
      setWaitError(err instanceof Error ? err.message : "无法开始生成主讲内容。");
    } finally {
      setWaitBusy(false);
    }
  }, [activity.id, api, onActivityUpdated]);

  if (activity.status === "completed" && phase !== "workspace") {
    return <div className="p-5" data-teaching-continue-entry="completed"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} /></div>;
  }
  if (phase === "workspace" && workspaceInit) {
    return (
      <div data-teaching-continue-entry="workspace">
        <TeachingWorkspace
          activity={activity}
          clientInit={workspaceInit}
          assistantHref={assistantHref}
          timeZone={timeZone}
          api={api}
          contextualTools={contextualTools}
          onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }}
        />
      </div>
    );
  }

  if (phase === "wait_init") {
    const canCompile = canRequestTeachingCompile(liveResume ?? activity, {
      compilerEnabled: teachingCompileEnabled,
    });
    const actions = waitInitActionVisibility({
      jobGate: liveResume?.gates.job,
      canCompile,
    });
    const waitingInFlight = liveResume?.gates.job === "in_flight";
    return (
      <section
        className="flex h-full min-h-0 flex-col px-5 py-5"
        data-teaching-continue-entry="wait_init"
        data-resume-client-init="null"
      >
        <h2 className="text-sm font-semibold text-zinc-900">
          {waitingInFlight ? "正在准备学习内容" : "主讲内容暂不可用"}
        </h2>
        <p className="mt-2 text-xs leading-5 text-zinc-600">
          {waitingInFlight
            ? "学习位置与草稿已保留，内容仍在准备中。稍后可刷新状态。"
            : "学习位置与草稿已保留，当前还没有可用的讲解。可以重新准备内容，或返回学习断点。"}
        </p>
        {liveResume ? (
          <details className="mt-2 text-[11px] tabular-nums text-zinc-500"><summary className="cursor-pointer">诊断信息</summary><p>
            jobGate={liveResume.gates.job} · materials={liveResume.gates.materials} · cv{" "}
            {liveResume.contentVersion}
          </p></details>
        ) : null}
        {waitError ? (
          <p className={`mt-3 text-xs ${tone.danger}`} role="alert">
            {waitError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.showCompile ? (
            <button
              type="button"
              className={ui.primary}
              disabled={waitBusy}
              data-teaching-request-compile="true"
              onClick={() => void requestCompile()}
            >
              {waitBusy ? "正在提交…" : "重新生成主讲内容"}
            </button>
          ) : null}
          {actions.showRetryFetch ? (
            <button
              type="button"
              className={ui.secondary}
              disabled={waitBusy}
              data-resume-retry-client-init="true"
              onClick={() => void retryFromFreshResume()}
            >
              {waitBusy ? "正在读取…" : "刷新准备状态"}
            </button>
          ) : null}
          {actions.showBack ? (
            <button
              type="button"
              className={ui.quiet}
              data-resume-back-to-card="true"
              onClick={backToCard}
            >
              返回断点卡片
            </button>
          ) : null}
        </div>
        <div className="mt-5"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} /></div>
      </section>
    );
  }

  return (
    <div data-teaching-continue-entry="card">
      <ResumeCard
        activity={activity}
        resume={liveResume}
        localUnsent={localUnsent}
        api={api}
        onContinue={(resume) => void openWorkspaceFromResume(resume)}
        onActivityUpdated={(next) => {
          setActivity(next);
          onActivityUpdated?.(next);
        }}
        onResumeUpdated={setLiveResume}
      />
      <div className="px-5 pb-5"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} /></div>
    </div>
  );
}

