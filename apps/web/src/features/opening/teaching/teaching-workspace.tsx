"use client";


import { ArrowLeft, ArrowRight, BookOpen, Focus, Maximize2 } from "lucide-react";
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
import { ContentBlock, ContentGrid, ui, tone } from "../design/ui";
import { useWorkspaceLayout } from "../shell/workspace-layout-context";
import { ConversationCompanionTabs } from "./conversation-companion-tabs";
import { conversationObjectHref } from "../assistant/conversation-links";
import { canCompleteObservation } from "../learning/stage-action-bar";
import { createOpeningApi, type OpeningApi } from "../client/api";
import {
  BlockCommands,
  isBranchStackEmpty,
} from "./block-commands";
import { TeachingBlockItem } from "./teaching-block-item";
import { returnToMainline } from "./return-to-mainline";
import {
  isKnownSchemaVersion,
  readSchemaVersion,
  normalizeToCatalogId,
} from "./component-catalog";
import {
  canRequestTeachingCompile,
  formatActivityUpdatedAt,

  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";

import { RestoredPositionNotice } from "./restored-position-notice";
import { ResumeCard, type LocalUnsentDraft } from "./resume-card";
import { TeachingGoalGuidance } from "./goal-guidance";
import { ActivityEndControl } from "./activity-end-control";

import { sourceViewerHref } from "../inbox/source-viewer";
import { StudyToolsPanel, StudyToolsToggle } from "./study-tools-panel";
import { StudyContextTools } from "./study-context-tools";
import { useStudyAssistantContext } from "../assistant/current-study-context";
import { teachingAssistantContext } from "./lesson-assistant-context";
import { SelectionAsk } from "./selection-ask";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { studentCopy } from "./student-copy";
import { buildTeachingStudyUnits, saveTeachingUnitPosition, teachingStudyUnitText, teachingUnitForBlock, type TeachingStudyUnit } from "./study-unit-focus";
import { unitProgress } from "./unit-progress";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
  companionSection?: "chat" | "notes";
  askRequest?: { id: string; text: string };
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
  headerLeading?: ReactNode;
  previousToolsAction?: ReactNode;
  /** The originating ordinary conversation stays separate from this activity or attempt. */
  originalConversationId?: string | null;
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
  timeZone = "Asia/Shanghai",
  clientInit: clientInitProp,


  api: apiProp,
  onActivityUpdated,
  sourceNameById: sourceNameByIdProp = null,
  contextualTools,
  headerLeading,
  previousToolsAction,
  originalConversationId = null,
}: TeachingWorkspaceProps) {
  const diagnostics = useDiagnosticsEnabled();
  const { focusMode, toggleFocusMode, setFocusMode } = useWorkspaceLayout();
  const outlineMenu = useRef<HTMLDetailsElement>(null);
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
  const [panel, setPanel] = useState<string | null>(originalConversationId !== null ? "chat" : null);
  const [askRequest, setAskRequest] = useState<{ id: string; text: string; scope: string } | null>(null);
  const askSequence = useRef(0);
  useEffect(() => {
    if (originalConversationId !== null) setPanel("chat");
  }, [originalConversationId]);
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; markSnapshot(); };
  }, [markSnapshot]);

  const sendCommand = useCallback(async (id: string, input: Parameters<OpeningApi["postTeachingCommand"]>[1], ownsNavigation = false) => {
    if ((positionInFlight.current && !ownsNavigation) || commandInFlight.current) throw new Error("另一项学习操作仍在保存，请稍后再试。");
    const latest = positionSnapshot.current;
    if (id !== latest.activityId || input.expectedVersion !== latest.contentVersion || (input.expectedPathVersion != null && input.expectedPathVersion !== latest.pathVersion)) throw new Error("学习内容已切换，请重新读取当前内容后再操作。");
    commandInFlight.current = true;
    markSnapshot();
    commandSnapshot.current = { ...positionSnapshot.current };
    try { return await api.postTeachingCommand(id, input); }
    finally { commandInFlight.current = false; }
  }, [api, markSnapshot]);
  const commandApi = useMemo<OpeningApi>(() => ({ ...api, postTeachingCommand: (id, input) => sendCommand(id, input) }), [api, sendCommand]);

  // Sync when parent passes a new activity/init identity (e.g. today dashboard reload).
  useEffect(() => {
    const incomingVersion = clientInitProp.contentVersion ?? activity.contentVersion;
    const latest = positionSnapshot.current;
    if (latest.activityId === activity.id && (incomingVersion < latest.contentVersion || activity.pathVersion < latest.pathVersion)) {
      setPositionError("收到的是较早的课程内容，已保留当前学习位置。请重新读取后继续。");
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
  const unitPosition = useMemo(() => unitProgress({ id: liveActivity.id, contentVersion }, {
    activityId: liveActivity.id, contentVersion, clientInit: liveInit,
  }), [liveActivity.id, contentVersion, liveInit]);
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
    if (!sameWorkspaceSnapshot(started, positionSnapshot.current)) throw new Error("重新读取时学习进度又有变化，较早的内容没有采用。请再读取一次，草稿仍保留。");
    const freshVersion = freshInit.contentVersion ?? freshActivity.contentVersion;
    if (freshVersion < started.contentVersion || freshActivity.pathVersion < started.pathVersion) throw new Error("读取到较早的课程内容，已保留当前学习位置。请稍后重新读取。");
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
        userFacingMessage(err, "重新拉取失败"),
      );
      throw err;
    }
  }, [reread]);

  const navigateUnit = useCallback(async (unit: TeachingStudyUnit) => {
    if (positionInFlight.current || !schemaOk) return;
    if (commandInFlight.current) { setPositionError("学习操作仍在保存，请稍后切换单元。"); return; }
    positionInFlight.current = true; setPositionBusy(true); setPositionError(null);
    let started = { ...positionSnapshot.current };
    try {
      let checkpoint = liveInit.checkpointJson;
      if (!isBranchStackEmpty(checkpoint)) {
        // Hold the navigation lock while unwinding; no target cursor is saved until every return is confirmed.
        await returnToMainline({ api: { ...api, postTeachingCommand: (id, input) => sendCommand(id, input, true) },
          activityId: started.activityId, contentVersion: started.contentVersion, pathVersion: started.pathVersion, checkpoint,
          isCurrent: () => mounted.current && (sameWorkspaceSnapshot(started, positionSnapshot.current)
            || Boolean(commandSnapshot.current && sameWorkspaceSnapshot(commandSnapshot.current, positionSnapshot.current))),
          accept: result => {
            const commandStarted = commandSnapshot.current;
            const current = Boolean(commandStarted && sameWorkspaceSnapshot(commandStarted, positionSnapshot.current)
              && result.contentVersion >= commandStarted.contentVersion && result.pathVersion >= commandStarted.pathVersion);
            applySuccess(result);
            if (current) { checkpoint = result.checkpointJson; started = { ...positionSnapshot.current }; }
            return current;
          }, onConflict: handleConflict });
        if (!isBranchStackEmpty(checkpoint)) throw new Error("原学习位置尚未确认，请重新读取后再切换单元。");
      }
      if (!mounted.current || !sameWorkspaceSnapshot(started, positionSnapshot.current)) return;
      await saveCurrentTeachingUnitPosition(api, started, () => positionSnapshot.current, unit.questionBlockId ?? unit.id, result => {
        markSnapshot({ contentVersion: result.contentVersion });
        setLiveInit(previous => ({ ...previous, contentVersion: result.contentVersion, checkpointJson: result.checkpointJson }));
        setContentVersion(result.contentVersion);
        setVisitedUnits(previous => new Set([...previous, unit.id]));
        setPanel(null);
        requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>('[data-study-unit-current="true"] h3')?.focus({ preventScroll: true }));
      });
    } catch (error) { if (mounted.current) setPositionError(userFacingMessage(error, "学习位置保存未确认，请重新读取后继续。")); }
    finally { positionInFlight.current = false; if (mounted.current) setPositionBusy(false); }
  }, [api, markSnapshot, schemaOk, liveInit.checkpointJson, sendCommand, applySuccess, handleConflict]);

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
  const currentObservation = observations[`${liveActivity.id}:${currentQuestionId}:${contentVersion}`];
  const questionSubmitted = !currentQuestionId || Boolean(currentObservation && canCompleteObservation(currentObservation));
  const canAdvance = questionSubmitted || liveActivity.status === "completed";


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
      completionAction: units[currentIndex + 1] ? {
        label: units[currentIndex + 1]?.questionBlockId ? "下一题" : "下一单元",
        disabled: positionBusy,
        onClick: () => { const next = units[currentIndex + 1]; if (next) void navigateUnit(next); },
      } : { label: "结束练习", href: conversationObjectHref(liveActivity.courseId ? `/opening/courses/${liveActivity.courseId}` : "/opening/courses", originalConversationId) },
    }),
    [liveActivity, contentVersion, liveInit.generationConfig, updateLiveActivity, onAttemptReady, onObservationReady, units, currentIndex, positionBusy, navigateUnit, originalConversationId],
  );

  const showBlockCommands = liveActivity.status !== "completed" && schemaOk;
  const askScope = `${liveActivity.id}:${contentVersion}:${currentUnit?.id ?? ""}`;
  const currentAskRequest = askRequest?.scope === askScope ? askRequest : undefined;
  const askInCompanion = (text: string) => {
    setAskRequest({ id: `${askScope}:${++askSequence.current}`, text: `请补充解释这段内容：\n${text}`, scope: askScope });
    setFocusMode(false);
    setPanel("chat");
  };
  const toolsContext = useMemo<TeachingToolsContext>(() => ({
    activity: { ...liveActivity, contentVersion, pathVersion },
    blockId: currentQuestionId ?? blockFocus.currentBlockId,
    contentVersion,
    unitTitle: currentUnit?.title ?? liveActivity.intentSummary,
    unitText: teachingStudyUnitText(currentUnit),
    sourceRefs: liveInit.sourceRefs,
    sourceNameById,
    isQuestion: Boolean(currentQuestionId),
    companionSection: panel === "notes" ? "notes" : "chat",
    askRequest: currentAskRequest,
    learningAttempt: currentQuestionId ? attempts[`${liveActivity.id}:${currentQuestionId}:${contentVersion}`] ?? null : null,
  }), [liveActivity, contentVersion, pathVersion, currentQuestionId, blockFocus.currentBlockId, currentUnit, liveInit.sourceRefs, sourceNameById, attempts, panel, currentAskRequest]);
  const assistantContext = useMemo(() => ({ ...teachingAssistantContext(toolsContext), ...(!schemaOk ? { blockedReason: "当前学习内容暂不可核实，请重新读取后再提问。" } : {}) }), [toolsContext, schemaOk]);
  useStudyAssistantContext(assistantContext);
  const contextualContent = typeof contextualTools === "function" ? contextualTools(toolsContext) : contextualTools;
  const toggleWholeLesson = () => {
    if (!showAll) setVisitedUnits(previous => new Set([...previous, ...units.map(unit => unit.id)]));
    setShowAll(value => !value);
  };
  const legacyPanels = [
    { id: "outline", label: "目录", content: <div className="space-y-4">
      <p className="text-sm font-medium">学习目录</p><TeachingGoalGuidance focus={liveActivity.learnerFocus} /><p className="text-xs leading-6 text-text-3">回看完整知识单元，切换位置会保存阅读断点。</p>
      <ol className="space-y-1">{units.map((unit, index) => <li key={unit.id}><button type="button" className={`${ui.quiet} h-auto w-full justify-start whitespace-normal py-2 text-left ${unit.id === currentUnitId ? "bg-accent-soft text-accent" : ""}`} aria-current={unit.id === currentUnitId ? "step" : undefined} disabled={positionBusy} onClick={() => { void navigateUnit(unit).then(() => { if (outlineMenu.current) outlineMenu.current.open = false; }); }}>{index + 1}. {unit.title}</button></li>)}</ol>
      <button type="button" className={ui.secondary} onClick={toggleWholeLesson} aria-pressed={showAll}>{showAll ? "只看当前单元" : "查看整节内容"}</button>
      {liveInit.goals.length ? <details className="text-xs leading-6 text-text-2"><summary className="cursor-pointer">本节目标</summary><ul className="mt-2 list-disc space-y-1 pl-4">{liveInit.goals.map(goal => <li key={goal.goalId}>{goal.statement}</li>)}</ul></details> : null}
    </div> },
    { id: "help", label: "学习帮助", content: currentUnit && showBlockCommands ? <BlockCommands key={toolsContext.blockId} activityId={liveActivity.id} blockId={toolsContext.blockId ?? currentUnit.id} contentVersion={contentVersion} pathVersion={pathVersion} returnDisabled={returnDisabled} disabled={positionBusy} whyAvailable={WHY_ASSIST_AVAILABLE} api={commandApi} onSuccess={applySuccess} onConflict={handleConflict} onReread={handleBlockReread} explanationContext={assistantContext.context} onAskExplanation={askInCompanion} defaultOpen compact /> : <p className="text-xs leading-6 text-text-3">当前没有可以调整的学习内容。</p> },
    { id: "materials", label: "资料与引用", content: <div className="space-y-3">
      {liveInit.sourceRefs.length ? <ul className="space-y-3">{liveInit.sourceRefs.map((ref, index) => {
        const label = formatTeachingSourceLabel(ref, sourceNameById);
        const numericVersion = ref.version == null || (typeof ref.version === "string" && !/^\d+$/.test(ref.version.trim())) ? null : Number(ref.version);
        const version = numericVersion != null && Number.isInteger(numericVersion) && numericVersion >= 0 ? numericVersion : null;
        return <li key={`${ref.sourceId}:${index}`} className="space-y-1 text-xs leading-6" data-source-ref={ref.sourceId}>
          {version != null ? <a className="break-words font-medium text-accent underline underline-offset-4" href={sourceViewerHref(ref.sourceId, version, { page: ref.page })}>{label.primary}{ref.page != null ? ` · 第 ${ref.page} 页` : ""}</a> : <p className="break-words font-medium text-text">{label.primary}{ref.page != null ? ` · 第 ${ref.page} 页` : ""} · 引用版本待确认</p>}
          <details className="text-text-3"><summary className="cursor-pointer">来源详情</summary><p className="break-all">资料标识：{ref.sourceId}</p><p>引用版本：{ref.version ?? "未知"}</p>{ref.chunkId ? <p className="break-all">原始片段：{ref.chunkId}</p> : null}</details>
        </li>;
      })}</ul> : <p className="text-xs leading-6 text-text-3">本节没有附带可定位的资料引用。</p>}
      <p className="text-xs leading-6 text-text-3">打开引用后可返回原学习单元。历史引用使用原来的资料版本。</p>
    </div> },
  ];

  const sharedContextContent = <ConversationCompanionTabs conversationId={originalConversationId} section={panel === "notes" ? "notes" : "chat"} tutorRequestKey={currentAskRequest?.id} tutorLabel={currentQuestionId ? "本题辅导" : "本节提问"}>
    <div className="flex h-full min-h-0 flex-col gap-4">{contextualContent ?? <StudyContextTools context={assistantContext.context} isQuestion={assistantContext.isQuestion}
      learningAttempt={assistantContext.learningAttempt} questionBlockedReason={assistantContext.blockedReason}
      section={panel === "notes" ? "notes" : "chat"} askRequest={currentAskRequest} />}
      <details hidden={panel === "notes"} className="shrink-0"><summary className="cursor-pointer py-2 text-xs text-text-2">学习帮助</summary><div className="pt-2">{legacyPanels.find(item => item.id === "help")?.content}</div></details>
    </div>
  </ConversationCompanionTabs>;
  const panels = [
    { id: "chat", label: "对话", mountKey: "context", content: sharedContextContent },
    { id: "notes", label: "笔记", mountKey: "context", content: sharedContextContent },
    { id: "materials", label: "资料", content: <>{previousToolsAction}{legacyPanels.find(item => item.id === "materials")?.content}
      {diagnostics ? <details className="mt-4 space-y-2 text-xs leading-6 text-text-3"><summary className="cursor-pointer">诊断信息</summary>
        <p>阅读进度只记录位置；掌握判断继续依据独立作答与后续练习。</p>
        <p>最近更新 {formatActivityUpdatedAt(liveActivity.updatedAt, timeZone)}</p>{/* learner-copy-ignore: version metadata appears only inside explicitly enabled diagnostics */}<p>内容版本 {contentVersion} · 路径版本 {pathVersion} · 校验 {liveInit.verificationStatus ?? "未知"}</p>
        <p className="break-all">活动标识：{liveActivity.id}</p><p className="break-all">当前位置：{blockFocus.currentBlockId ?? "未设置"}</p>
        <p>界面开关不改变 AI 介入偏好。个人答案与草稿继续使用原有保存流程。</p>
      </details> : null}</> },
  ];
  const returningToMainline = useRef(false);
  const restoreMainline = async () => {
    if (returningToMainline.current || positionInFlight.current || commandInFlight.current) {
      setPositionError("学习操作仍在保存，请稍后再关闭追问。"); return;
    }
    returningToMainline.current = true; setPositionBusy(true);
    try {
      await returnToMainline({ api: commandApi, activityId: liveActivity.id, contentVersion, pathVersion, checkpoint: liveInit.checkpointJson,
        isCurrent: () => mounted.current && positionSnapshot.current.activityId === liveActivity.id,
        accept: result => {
          const started = commandSnapshot.current;
          const current = Boolean(started && sameWorkspaceSnapshot(started, positionSnapshot.current)
            && result.contentVersion >= started.contentVersion && result.pathVersion >= started.pathVersion);
          applySuccess(result); return current;
        }, onConflict: handleConflict });
    } catch (error) { if (mounted.current) setPositionError(userFacingMessage(error, "原学习位置尚未确认，请重新读取后继续。")); }
    finally { returningToMainline.current = false; if (mounted.current) setPositionBusy(false); }
  };
  const changePanel = (next: string | null) => {
    if (next && focusMode) setFocusMode(false);
    if (next === null && panel !== null && !returnDisabled) void restoreMainline();
    setPanel(next);
  };

  return <section className="flex h-full min-h-0 min-w-0 flex-col" aria-labelledby="teaching-workspace-heading" data-teaching-workspace="true" data-study-question={currentQuestionId ? "true" : "false"} data-content-version={contentVersion} data-path-version={pathVersion}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-2">{headerLeading}<BookOpen size={16} aria-hidden className="shrink-0 text-accent" />
        <details ref={outlineMenu} className="relative min-w-0">
          <summary aria-label="选择学习单元" className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-2 focus-visible:ring-2 focus-visible:ring-accent">
            <h2 id="teaching-workspace-heading" className="truncate text-sm font-semibold text-text">{currentUnit?.title ?? "本次学习"}</h2>
            {unitPosition ? <span className="text-xs text-text-3">单元 {unitPosition.current} / {unitPosition.total}</span> : null}
          </summary>
          <div className="absolute left-0 top-full z-20 max-h-80 w-72 max-w-[80vw] overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-lg">{legacyPanels.find(item => item.id === "outline")?.content}</div>
        </details>
      </div>
      <div className="flex items-center gap-2"><span className={`text-xs ${generateTone}`}>{liveActivity.status === "completed" ? "已结束" : liveActivity.generateStatus === "ready" || liveActivity.generateStatus === "needs_check" ? teachingActivityStatusLabel(liveActivity.status) : liveActivity.generateStatus === "queued" || liveActivity.generateStatus === "generating" ? "正在准备" : teachingActivityGenerateStatusLabel(liveActivity.generateStatus, { contentVersion })}</span><button type="button" className={ui.icon} aria-label={focusMode ? "退出专注" : "专注"} aria-pressed={focusMode} onClick={toggleFocusMode}>{focusMode ? <Maximize2 size={16} aria-hidden /> : <Focus size={16} aria-hidden />}</button><StudyToolsToggle panels={panels} activePanel={panel} onPanelChange={changePanel} suspended={focusMode} /></div>
    </header>
    {unitPosition ? <div role="progressbar" aria-label="学习位置" aria-valuemin={0} aria-valuemax={unitPosition.total} aria-valuenow={unitPosition.current} className="grid h-0.5 shrink-0 grid-flow-col auto-cols-fr gap-px bg-line">{units.map((unit, index) => <span key={unit.id} className={index <= currentIndex ? "bg-accent" : "bg-line"} />)}</div> : null}
    <RestoredPositionNotice key={`${activity.id}:${clientInitProp.contentVersion}:${String(clientInitProp.checkpointJson?.currentBlockId ?? "")}`} restored={typeof clientInitProp.checkpointJson?.currentBlockId === "string"} />
    {liveActivity.generateStatus === "needs_check" ? <p className="mb-4 text-xs leading-6 text-text-3" role="note" data-teaching-needs-check="true">这节内容还在核对引用，可以先学。</p> : null}
    {workspaceConflict ? <div className={`${tone.warning} mb-4 space-y-2 rounded-lg px-3 py-2 text-xs leading-6`} role="status" data-workspace-command-conflict={workspaceConflict.conflict}><p>{studentCopy.lessonUpdated}</p><button type="button" className={ui.secondary} onClick={() => { void handleBlockReread().catch(() => undefined); }}>继续学习</button>{diagnostics ? <details><summary className="cursor-pointer">技术信息</summary><p>{workspaceConflict.conflict}：{workspaceConflict.message}</p></details> : null}</div> : null}
    {rereadError || positionError ? <div className="mb-4 space-y-2 text-xs leading-6 text-danger" role="alert"><p>{studentCopy.lessonRetry}</p><button type="button" className={ui.secondary} onClick={() => { void handleBlockReread().then(() => setPositionError(null)).catch(() => undefined); }}>{studentCopy.retry}</button>{diagnostics ? <details><summary className="cursor-pointer">技术信息</summary><p>{rereadError ?? positionError}</p></details> : null}</div> : null}
    {!schemaOk ? <div className={`${tone.warning} mb-4 rounded-lg px-3 py-2 text-xs leading-6`} role="status" data-workspace-schema-fail="true">{studentCopy.lessonUnavailable}{diagnostics ? <details><summary className="cursor-pointer">技术信息</summary>{/* learner-copy-ignore: unsupported schema details appear only inside explicitly enabled diagnostics */}<p>schema 版本不受支持：{schemaVersion}</p></details> : null}</div> : null}
    <div className="min-h-0 flex-1 pb-4"><StudyToolsPanel showToolbar={false} fillHeight preferContentOnNarrowEntry={originalConversationId !== null} contentClassName="px-4 sm:px-8" toolbarClassName="px-4 sm:px-8" panels={panels} activePanel={panel} onPanelChange={changePanel} suspended={focusMode}>
      <ContentGrid><div ref={contentRef} className="min-w-0 space-y-6 pb-4" data-teaching-blocks="true" data-lesson-shortcuts="true" data-current-block-id={blockFocus.currentBlockId ?? ""}>
        {schemaOk ? units.map(unit => {
          const current = unit.id === currentUnitId;
          if (!showAll && !current && !visitedUnits.has(unit.id)) return null;
          return <div key={unit.id} hidden={!showAll && !current} className={current ? "space-y-5" : "space-y-5 [&_[data-inline-attempt]]:hidden"} data-study-unit={unit.id} data-study-unit-current={current ? "true" : "false"}>
            <ContentBlock width="prose"><h3 tabIndex={-1} className="break-words text-lg font-semibold leading-8 text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{unit.title}</h3></ContentBlock>
            <SelectionAsk binding={current ? assistantContext : null} onAsk={askInCompanion}>{unit.blocks.filter(block => block.role !== "answer_key" && block.blockType !== "answer_key").map(block => <ContentBlock key={block.blockId} width={["math", "matrix_transform", "vector_diagram"].includes(normalizeToCatalogId(block.blockType, block.role)) ? "wide" : "prose"}><TeachingBlockItem block={block} focusStatus={blockFocus.statusById.get(block.blockId) ?? "upcoming"} schemaVersion={schemaVersion} sourceRefs={liveInit.sourceRefs} attemptContext={attemptContext} showCommands={false} activityId={liveActivity.id} contentVersion={contentVersion} pathVersion={pathVersion} returnDisabled={returnDisabled} whyAvailable={WHY_ASSIST_AVAILABLE} api={api} onSuccess={applySuccess} onConflict={handleConflict} onReread={handleBlockReread} explanationContext={current && !unit.questionBlockId ? assistantContext.context : undefined} onAskExplanation={askInCompanion} unitChrome /></ContentBlock>)}</SelectionAsk>
          </div>;
        }) : null}
        {schemaOk && currentUnit ? <nav aria-label="学习单元导航" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          {currentIndex > 0 ? <button type="button" className={ui.quiet} disabled={positionBusy} onClick={() => { const previous = units[currentIndex - 1]; if (previous) void navigateUnit(previous); }}><ArrowLeft size={14} aria-hidden />回看上一单元</button> : <span />}
          {!currentQuestionId && units[currentIndex + 1] ? <button type="button" className={ui.primary} disabled={positionBusy || !canAdvance} onClick={() => { const next = units[currentIndex + 1]; if (next) void navigateUnit(next); }} data-teaching-primary-advance="true">{positionBusy ? "正在保存位置…" : units[currentIndex + 1]?.questionBlockId ? "进入练习" : "下一单元"}<ArrowRight size={14} aria-hidden /></button> : null}
        </nav> : null}
        {currentQuestionId && units[currentIndex + 1] && !canAdvance ? <p className="text-xs leading-6 text-text-3">{currentObservation ? "先核对本题结果，再继续下一单元；也可以从提纲回看讲解。" : "先提交你的想法，再继续下一单元；也可以从提纲回看讲解。"}</p> : null}
        <details open={currentIndex === units.length - 1 || liveActivity.status === "completed"} className="border-t border-line pt-4"><summary className="cursor-pointer text-xs font-medium text-text-2">本次学习与小结</summary><div className="mt-3"><ActivityEndControl activity={liveActivity} api={api} onActivityUpdated={updateLiveActivity} /></div></details>
      </div></ContentGrid>
    </StudyToolsPanel></div>
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
  headerLeading?: ReactNode;
  previousToolsAction?: ReactNode;
  onWorkspaceVisibilityChange?: (visible: boolean) => void;
  /** The originating ordinary conversation stays separate from this activity or attempt. */
  originalConversationId?: string | null;
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
  headerLeading,
  previousToolsAction,
  onWorkspaceVisibilityChange,
  originalConversationId = null,
}: TeachingContinueEntryProps) {
  const diagnostics = useDiagnosticsEnabled();
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
  const workspaceVisible = phase === "workspace" && Boolean(workspaceInit)
    && activity.status !== "completed" && activity.status !== "skipped";
  useEffect(() => {
    onWorkspaceVisibilityChange?.(workspaceVisible);
    return () => onWorkspaceVisibilityChange?.(false);
  }, [workspaceVisible, onWorkspaceVisibilityChange]);
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
            : "这节讲解暂时打不开，请稍后再试。",
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
      setWaitError(userFacingMessage(err, "无法刷新断点；不会伪造讲义。"));
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
      setWaitError(userFacingMessage(err, "无法开始生成主讲内容。"));
    } finally {
      setWaitBusy(false);
    }
  }, [activity.id, api, onActivityUpdated]);

  if (activity.status === "completed" && phase !== "workspace") {
    return <div className="p-5" data-teaching-continue-entry="completed"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} /></div>;
  }
  if (phase === "workspace" && workspaceInit) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-teaching-continue-entry="workspace">
        <TeachingWorkspace
          activity={activity}
          clientInit={workspaceInit}
          assistantHref={assistantHref}
          timeZone={timeZone}
          api={api}
          contextualTools={contextualTools}
          headerLeading={headerLeading}
          previousToolsAction={previousToolsAction}
          originalConversationId={originalConversationId}
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
        <h2 className="text-sm font-semibold text-text">
          {waitingInFlight ? "正在准备学习内容" : "主讲内容暂不可用"}
        </h2>
        <p className="mt-2 text-xs leading-5 text-text-2">
          {waitingInFlight
            ? "正在为你准备讲解，稍后就可以继续。"
            : "这节讲解还没准备好，可以再试一次或先回去。"}
        </p>
        {liveResume && diagnostics ? (
          <details className="mt-2 text-xs tabular-nums text-text-3"><summary className="cursor-pointer">诊断信息</summary><p>
            jobGate={liveResume.gates.job} · materials={liveResume.gates.materials} · cv{" "}
            {liveResume.contentVersion}
          </p></details>
        ) : null}
        {waitError ? (
          <div className={`mt-3 text-xs ${tone.danger}`} role="alert">
            <p>{studentCopy.lessonRetry}</p>
            {diagnostics ? <details><summary className="cursor-pointer">技术信息</summary><p>{waitError}</p></details> : null}
          </div>
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

