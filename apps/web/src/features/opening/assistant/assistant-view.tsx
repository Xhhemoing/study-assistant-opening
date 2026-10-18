"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { terminalTurnStatusForJobError, type ConversationResume, type ConversationSummary, type LearningAttempt, type SourceRecord, type TutorMode, type TurnRecord } from "@aistudy/contracts";
import { OpeningApiError, createOpeningApi, type JobStatusResponse, type OpeningApi } from "../client/api";
import { Composer, type ComposerPrivacy, type ComposerSubmit } from "./composer";
import { CLARIFY_FOLLOW_UP, MessageList } from "./message-list";
import { ephemeralHistoryFromMessages, resolveChatMessages, type ChatMessageView } from "./message-model";
import { SourcePageControls } from "./source-page-controls";
import { formatTurnError, pageForSubmit } from "./turn-errors";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Plus, ShieldCheck } from "lucide-react";
import { LoadingRows, secondaryButtonClass } from "../design/ui";
import { ResponsiveInspector } from "../design/inspector";
import { TaskContext } from "./task-context";
import { replacePromptDraft, type StudyTask } from "../planning/study-task";
import { MemoryPanel } from "./memory-panel";
import { prepareSnippetDraft, type SelectedExcerpt } from "./save-snippet";
import { SaveSnippetDialog } from "./save-snippet-dialog";
import { CreateCardDialog } from "../cards/create-card-dialog";
import { UploadStrip } from "./upload-strip";
import { createMaterialOrganizationClient, type MaterialOrganization } from "../library/material-organization-client";
import {
  addSelectedSourceIds,
  hasReadyMembershipMaterials,
  membershipSourceIdsForCourse,
  resolveAssistantCourseId,
  uniqueCappedSourceIds,
} from "./course-source-selection";
import { AiReadinessChecklist } from "./ai-readiness";
import type { ThinTutorAction } from "@aistudy/domain";
import { tutorActionIntent, type TutorActionIntent } from "../learning/tutor-action-intents";
import { nodeIdForSkillLabel } from "../learning/knowledge-node-lookup";
import { turnsWithKnownOutcome, unknownTurnQuestion, unknownTurnRecovery } from "./unknown-turn-recovery";
import { UnknownTurnNotice } from "./unknown-turn-notice";
import { shouldRefreshSources } from "../inbox/source-refresh";
import { startSourceProcessingRefresh } from "./source-processing-refresh";
import { createQuestionDraftStore } from "./question-drafts";
import { pinnedStudySourceProblem, questionWithStudyContext, studyContextReturnHref, studyConversationIdentity, type StudyConversationContext } from "./study-conversation-context";
import { createConversationReader } from "./conversation-reader";
import { createJobPoller, TERMINAL_JOB_STATUSES } from "./job-poller";

export { createJobPoller } from "./job-poller";

type Props = {
  api?: OpeningApi;
  initialConversationId?: string | null;
  /** Course page / shell query binding (Package B) — not only learningAttempt. */
  initialCourseId?: string | null;
  learningAttempt?: LearningAttempt;
  task?: StudyTask | null;
  initialTitle?: string;
  startFresh?: boolean;
  initialSourceIds?: string[];
  initialPage?: number | null;
  initialDraft?: string;
  embedded?: boolean;
  studyContext?: StudyConversationContext;
  studyContextError?: string;
};

export function jobStatusHint(job: JobStatusResponse): string {
  if (job.status === "queued") return "回答任务已排队。";
  if (job.status === "running") return "回答任务生成中。";
  if (job.status === "failed") {
    // LAB-U01: a page refusal (nextAction clarify) is a Clarify follow-up, not a failure.
    if (terminalTurnStatusForJobError(job.error) === "clarify") return job.error?.message ?? CLARIFY_FOLLOW_UP;
    return `回答任务失败：${job.error?.message ?? "服务未提供失败原因"}`;
  }
  if (job.status === "cancelled") return "回答任务已取消。";
  if (job.status === "outcome_unknown") {
    return "回答结果状态未知，原请求不会自动重发。请查看回答恢复提示。";
  }
  return "";
}

export type PendingJobDiscovery =
  | { kind: "none" }
  | { kind: "unavailable"; message: string }
  | { kind: "active"; activeJobId: string; pending: true; hint: string }
  | { kind: "unknown"; pending: false; hint: string };

/** Null is no pending job. A lookup error must stay unavailable, not empty. */
export function pendingJobDiscoveryState(
  result: { ok: true; job: JobStatusResponse | null } | { ok: false; error: unknown },
): PendingJobDiscovery {
  if (!result.ok) {
    const message = result.error instanceof Error ? result.error.message : "服务暂时不可用";
    return { kind: "unavailable", message };
  }
  if (!result.job) return { kind: "none" };
  if (result.job.status === "outcome_unknown") {
    return { kind: "unknown", pending: false, hint: jobStatusHint(result.job) };
  }
  if (result.job.status !== "queued" && result.job.status !== "running") {
    return { kind: "none" };
  }
  return {
    kind: "active",
    activeJobId: result.job.id,
    pending: true,
    hint: jobStatusHint(result.job),
  };
}

export function pageIntentValue(currentPage: string): number | null {
  try {
    return pageForSubmit(currentPage) ?? null;
  } catch {
    return null;
  }
}

export function assistantContextHint(selectedSourceIds: string[]): string {
  return selectedSourceIds.length === 0
    ? "自由交流"
    : `已选材料：${selectedSourceIds.length} 份`;
}

/** Soft honesty when course-bound (or ready membership materials) but none selected this turn. */
export function shouldConfirmEmptyCourseSources(input: {
  sourceIds: readonly string[];
  courseId: string | null | undefined;
  hasReadyCourseMaterials?: boolean;
}): boolean {
  if (input.sourceIds.length > 0) return false;
  return Boolean(input.courseId) || Boolean(input.hasReadyCourseMaterials);
}

export const EMPTY_COURSE_SOURCES_CONFIRM =
  "当前课程有材料，尚未选入本轮。仍要继续发送？\n\n确定：继续（一般说明）\n取消：打开参考资料再选材料";


/** Notice when server auto-filled/narrowed sources (Package C). Empty/omitted → no hint. */
export function autoSelectSourcesNotice(effectiveSourceIds: readonly string[] | undefined | null): string | null {
  const n = effectiveSourceIds?.length ?? 0;
  if (n <= 0) return null;
  return `已按问题自动选入 ${n} 份课程材料`;
}

/**
 * Apply server-echoed effectiveSourceIds: unique capped list + notice.
 * Trust only the server field; do not fabricate ids.
 */
export function applyEffectiveSourceIds(
  effectiveSourceIds: readonly string[] | undefined | null,
): { sourceIds: string[] | null; notice: string | null } {
  if (!effectiveSourceIds?.length) {
    return { sourceIds: null, notice: null };
  }
  const sourceIds = uniqueCappedSourceIds(effectiveSourceIds);
  return {
    sourceIds,
    notice: autoSelectSourcesNotice(sourceIds),
  };
}

const TUTOR_ACTION_LABELS: Record<ThinTutorAction["kind"], string> = {
  clarify: "选择材料或页码",
  guided: "开始引导提示",
  worked_example: "看完整例题",
  independent_variant: "独立做变式题",
  delayed_retest: "开始到期复习",
};

export function tutorActionLabel(kind: ThinTutorAction["kind"]): string {
  return TUTOR_ACTION_LABELS[kind];
}

/** Chip prefill text per action kind; sent only after the user confirms. */
export function presetPromptForMode(mode: "hint" | "explain"): string {
  return mode === "hint"
    ? "请只给下一步提示，不要直接给完整答案。"
    : "请给一道完整例题讲解，并标明材料依据。";
}
export function mergeChatMessages(
  saved: ChatMessageView[],
  ephemeral: ChatMessageView[],
): ChatMessageView[] {
  return [...saved, ...ephemeral];
}

export function appendEphemeralResponseIfActive(
  current: ChatMessageView[],
  input: {
    clientKey: string;
    text: string;
    /** Selected materials for this turn — drives hadMaterialContext / general badge. */
    sourceIds?: readonly string[];
    output: {
      requestId: string | null;
      text: string;
      historyDiscarded?: boolean;
      provenanceId?: string | null;
      citations?: ChatMessageView["citations"];
    };
  },
  signal: AbortSignal,
): ChatMessageView[] {
  if (signal.aborted) return current;
  const citations = [...(input.output.citations ?? [])];
  const hadMaterialContext = (input.sourceIds?.length ?? 0) > 0;
  return [...(input.output.historyDiscarded ? [] : current),
    { id: `ephemeral-user-${input.clientKey}`, role: "user", text: input.text, citations: [], citationLabels: [], origin: "ephemeral", provenanceId: input.output.provenanceId ?? null },
    {
      id: `ephemeral-assistant-${input.output.requestId ?? input.clientKey}`,
      role: "assistant",
      text: input.output.text,
      citations,
      citationLabels: citations.map((citation) => citation.label),
      status: "complete",
      origin: "ephemeral",
      provenanceId: input.output.provenanceId ?? null,
      hadMaterialContext,
    },
  ];
}

export function learningAttemptTurnContext(attempt?: LearningAttempt) {
  return attempt ? { learningSessionId: attempt.sessionId, attemptId: attempt.id } : {};
}

export function shouldLoadConversationList(learningAttempt?: LearningAttempt): boolean {
  return !learningAttempt;
}

export function shouldRefreshCurrentConversation(learningAttempt: LearningAttempt | undefined, conversationId: string | null): boolean {
  return Boolean(learningAttempt && conversationId);
}

export function canReuseAssistantConversation(
  conversationId: string | null,
  learningAttempt?: LearningAttempt,
  resume?: ConversationResume | null,
  boundCourseId?: string | null,
): boolean {
  if (!conversationId) return false;
  if (learningAttempt) {
    return resume === null || resume === undefined || resume.courseId === learningAttempt.courseId;
  }
  if (boundCourseId && resume) {
    return resume.courseId === boundCourseId;
  }
  return true;
}

export function conversationForAssistant(
  listed: readonly ConversationSummary[],
  initialConversationId: string | null,
  attemptCourseId?: string,
): ConversationSummary | null {
  const eligible = attemptCourseId ? listed.filter((row) => row.courseId === attemptCourseId) : listed;
  return eligible.find((row) => row.id === initialConversationId) ?? eligible[0] ?? null;
}

export function selectionForResumedConversation(resume: ConversationResume, attempt?: LearningAttempt, entry?: { sourceIds: string[]; currentPage: number | null }) {
  if (attempt) return { sourceIds: attempt.sourceIds, currentPage: null };
  if (entry?.sourceIds.length) return entry;
  return { sourceIds: resume.sourceIds, currentPage: resume.currentPage ?? null };
}

export function assistantSessionIndex(session: { identity: string; count: number }, identity: string): number {
  return session.identity === identity ? session.count : 0;
}

export function AssistantView(props: Props) {
  const identity = `${studyConversationIdentity(props.studyContext)}:${props.initialCourseId ?? ""}:${props.initialConversationId ?? ""}:${[...(props.initialSourceIds ?? [])].sort().join(",")}:${props.initialPage ?? ""}:${props.learningAttempt?.id ?? ""}`;
  const [sessionState, setSession] = useState({ identity, count: 0 });
  const session = assistantSessionIndex(sessionState, identity);
  const [newSelection, setNewSelection] = useState<{ identity: string; sourceIds: string[]; page: number | null } | null>(null);
  const selection = newSelection?.identity === identity ? newSelection : null;
  return <AssistantWorkspace key={`${identity}:${session}`} {...props}
    initialConversationId={session ? null : props.initialConversationId}
    startFresh={session ? true : props.startFresh}
    initialSourceIds={selection?.sourceIds ?? props.initialSourceIds} initialPage={selection ? selection.page : props.initialPage}
    initialDraft={session ? "" : props.initialDraft}
    onNew={(sourceIds, page) => { setNewSelection({ identity, sourceIds, page }); setSession(value => ({ identity, count: assistantSessionIndex(value, identity) + 1 })); }} />;
}
function AssistantWorkspace({ api: apiProp, initialConversationId = null, initialCourseId: courseIdProp = null, learningAttempt, task, initialTitle,
  startFresh = false, initialSourceIds: sourceIdsProp = [], initialPage: pageProp = null, initialDraft = "", embedded = false,
  studyContext, studyContextError, onNew }: Props & { onNew: (sourceIds: string[], page: number | null) => void }) {
  const initialCourseId = studyContext?.courseId ?? courseIdProp;
  const entrySourceKey = sourceIdsProp.join(",");
  const initialSourceIds = useMemo(() => {
    const suppliedIds = entrySourceKey ? entrySourceKey.split(",") : [];
    return studyContext?.sourceId ? addSelectedSourceIds([studyContext.sourceId], suppliedIds) : suppliedIds;
  }, [studyContext?.sourceId, entrySourceKey]);
  const initialPage = studyContext?.page ?? pageProp;
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [conversationId, setConversationIdState] = useState<string | null>(
    learningAttempt ? null : initialConversationId,
  );
  const conversationIdRef = useRef(conversationId);
  const setConversationId = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationIdState(id);
  }, []);
  const conversationReader = useMemo(() => createConversationReader(api), [api]);
  const [resume, setResume] = useState<ConversationResume | null>(null);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const sourceRequestSequence = useRef(0);
  const sourceRefresh = useRef<ReturnType<typeof startSourceProcessingRefresh> | null>(null);
  const [sourceRefreshError, setSourceRefreshError] = useState(false);
  const [organization, setOrganization] = useState<MaterialOrganization | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(learningAttempt?.sourceIds ?? initialSourceIds);
  const [currentPage, setCurrentPage] = useState(initialPage == null ? "" : String(initialPage));
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [draft, setDraftState] = useState(initialDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [reload, setReload] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState("");
  const [pendingHint, setPendingHint] = useState("");
  /** Package C: dismissible / cleared on next submit when server echoes effectiveSourceIds. */
  const [autoSelectNotice, setAutoSelectNotice] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<ComposerPrivacy>("saved");
  const draftStore = useMemo(() => createQuestionDraftStore(), []);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const draftScope = `${studyConversationIdentity(studyContext)}:${initialCourseId ?? ""}:${initialConversationId ?? ""}:${[...initialSourceIds].sort().join(",")}:${initialPage ?? ""}:${learningAttempt?.id ?? ""}`;
  const draftEdited = useRef(false);
  const preserveEntrySelection = useRef(true);
  const setDraft = useCallback((text: string) => {
    draftEdited.current = true;
    setDraftState(text);
    if (privacy === "saved") draftStore.write(draftScope, text);
    else draftStore.remove(draftScope);
    setDraftUnavailable(draftStore.unavailable);
  }, [draftScope, draftStore, privacy]);
  useEffect(() => {
    if (draftEdited.current) return;
    const saved = draftStore.read(draftScope);
    if (saved !== null) setDraftState(saved);
    setDraftUnavailable(draftStore.unavailable);
  }, [draftScope, draftStore]);
  function changePrivacy(next: ComposerPrivacy) {
    setPrivacy(next);
    if (next === "ephemeral") draftStore.remove(draftScope);
    else draftStore.write(draftScope, draftRef.current);
    setDraftUnavailable(draftStore.unavailable);
  }
  const [ephemeralMessages, setEphemeralMessages] = useState<ChatMessageView[]>([]);
  const [ephemeralPrivacyEpoch, setEphemeralPrivacyEpoch] = useState<number>();
  const [snippetDraft, setSnippetDraft] = useState<ReturnType<typeof prepareSnippetDraft>>(null);
  const [cardDraft, setCardDraft] = useState<ReturnType<typeof prepareSnippetDraft>>(null);
  const [tutorActions, setTutorActions] = useState<ThinTutorAction[]>([]);
  const [tutorActionError, setTutorActionError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [modePrefill, setModePrefill] = useState<{ mode: TutorMode; nonce: number } | null>(null);
  const [unknownJob, setUnknownJob] = useState<JobStatusResponse | null>(null);
  const [recoveryNow, setRecoveryNow] = useState(Date.now);
  const [retryDraftVersion, setRetryDraftVersion] = useState(0);
  const draftId = useId();
  const unknownRecovery = unknownTurnRecovery(unknownJob, recoveryNow);
  const waitingForUnknown = unknownRecovery !== null && !unknownRecovery.canRetry;
  const recoveredTurns = useMemo(() => turnsWithKnownOutcome(turns, unknownJob), [turns, unknownJob]);
  const retryQuestion = unknownTurnQuestion(recoveredTurns);

  useEffect(() => () => {
    conversationReader.cancel();
    abortRef.current?.abort();
  }, [conversationReader]);

  useEffect(() => {
    if (!unknownJob) return;
    const update = () => setRecoveryNow(Date.now());
    const readyAt = unknownTurnRecovery(unknownJob, Date.now())?.readyAt ?? Date.now();
    update();
    const timer = window.setTimeout(update, Math.max(0, readyAt - Date.now()));
    document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [unknownJob]);

  const refreshSources = useCallback(async () => {
    const sequence = ++sourceRequestSequence.current;
    const records = await api.listSources();
    if (sequence === sourceRequestSequence.current) { setSources(records); setSourceRefreshError(false); }
  }, [api]);
  const sourcesProcessing = shouldRefreshSources(sources);
  useEffect(() => {
    if (!sourcesProcessing) return;
    let sequence = 0;
    const controller = startSourceProcessingRefresh({
      read: () => { sequence = ++sourceRequestSequence.current; return api.listSources(); },
      accept: records => {
        if (sequence !== sourceRequestSequence.current) return false;
        setSources(records); setSourceRefreshError(false); return true;
      },
      onError: () => { if (sequence === sourceRequestSequence.current) setSourceRefreshError(true); },
    });
    sourceRefresh.current = controller;
    return () => { controller.stop(); if (sourceRefresh.current === controller) sourceRefresh.current = null; };
  }, [api, sourcesProcessing]);

  const refreshOrganization = useCallback(async () => {
    // Client-side membership until Data exposes listReadySourceIdsForCourse on the web API.
    try {
      setOrganization(await createMaterialOrganizationClient().read());
    } catch {
      setOrganization(null);
    }
  }, []);

  const boundCourseId = resolveAssistantCourseId({
    learningAttemptCourseId: learningAttempt?.courseId,
    resumeCourseId: resume?.courseId,
    initialCourseId,
  });
  const membershipIds = useMemo(
    () => membershipSourceIdsForCourse(organization, boundCourseId),
    [organization, boundCourseId],
  );
  const readyCourseMaterials = hasReadyMembershipMaterials(sources, membershipIds);

  const handleUploaded = useCallback(async (savedSourceIds?: string[], knownSources?: SourceRecord[]) => {
    if (knownSources?.length) setSources(current => [...current, ...knownSources.filter(record => !current.some(item => item.id === record.id))]);
    if (savedSourceIds?.length) setSelectedSourceIds(current => addSelectedSourceIds(current, savedSourceIds));
    try { await refreshSources(); } catch { setSourceRefreshError(true); }
    await refreshOrganization();
  }, [refreshOrganization, refreshSources]);

  const refreshTutorActions = useCallback(async () => {
    if (!learningAttempt) {
      setTutorActions([]);
      setTutorActionError("");
      return;
    }
    setTutorActionError("");
    try {
      let nodeId: string | null = null;
      try {
        const knowledge = await api.getCourseKnowledge(learningAttempt.courseId);
        nodeId = nodeIdForSkillLabel(knowledge.snapshot, learningAttempt.skillLabel);
      } catch {
        nodeId = null;
      }
      const result = await api.listTutorActions({
        courseId: learningAttempt.courseId,
        skillLabel: learningAttempt.skillLabel,
        sessionId: learningAttempt.sessionId,
        nodeId,
      });
      setTutorActions(result);
    } catch (err) {
      setTutorActionError(err instanceof Error ? err.message : "无法读取推荐动作");
    }
  }, [api, learningAttempt]);

  const refreshConversation = useCallback(
    async (id: string, signal?: AbortSignal, retryOnUnavailable = false) => {
      const snapshot = await conversationReader.read(id, signal);
      if (!snapshot) return false;
      const { resume: nextResume, turns: nextTurns, pending: discovery } = snapshot;
      if ((learningAttempt && nextResume.courseId !== learningAttempt.courseId)
        || (initialCourseId && !learningAttempt && nextResume.courseId !== initialCourseId)) {
        setConversationId(null); setResume(null); setTurns([]);
        return false;
      }
      setResume(nextResume);
      setTurns(nextTurns);
      const restoredSelection = selectionForResumedConversation(nextResume, learningAttempt, preserveEntrySelection.current ? { sourceIds: initialSourceIds, currentPage: initialPage } : undefined);
      if (learningAttempt || restoredSelection.sourceIds.length > 0) {
        setSelectedSourceIds(restoredSelection.sourceIds);
      }
      if (!learningAttempt && restoredSelection.currentPage != null) {
        setCurrentPage(String(restoredSelection.currentPage));
      }
      if (discovery.kind === "changed") {
        setUnknownJob(null);
        setActiveJobId(null);
        setPending(false);
        setRecoveryRequired(true);
        setPendingHint("对话刚刚发生变化，请重新读取后再恢复提问。");
        return true;
      }
      if (discovery.kind === "unavailable") {
        const discovered = pendingJobDiscoveryState({ ok: false, error: discovery.error });
        if (discovered.kind === "unavailable") {
          setPendingHint(`尚未确认是否有进行中的回答：${discovered.message}`);
          setRecoveryRequired(true);
          if (retryOnUnavailable) throw discovery.error;
        }
        return true;
      }
      const pendingJob = discovery.job;
      setRecoveryRequired(false);
      setUnknownJob(pendingJob?.status === "outcome_unknown" ? pendingJob : null);
      setRecoveryNow(Date.now());
      const discovered = pendingJobDiscoveryState({ ok: true, job: pendingJob });
      if (discovered.kind === "active") {
        setActiveJobId(discovered.activeJobId);
        setPending(discovered.pending);
        setPendingHint(discovered.hint);
      } else if (discovered.kind === "unknown") {
        setActiveJobId(null);
        setPending(false);
        setPendingHint(discovered.hint);
      } else {
        setActiveJobId(null);
        setPending(false);
        setPendingHint("");
      }
      return true;
    },
    [conversationReader, initialCourseId, initialSourceIds, initialPage, learningAttempt, setConversationId],
  );


  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true); setError(""); setRecoveryRequired(false);
    (async () => {
      try {
        await Promise.all([refreshSources(), refreshOrganization(), refreshTutorActions()]);
        if (cancelled) return;
        if (initialConversationId && !learningAttempt) {
          setConversationId(initialConversationId);
          await refreshConversation(initialConversationId, controller.signal);
          return;
        }
        // Creating the first conversation updates this ref without restarting initialization.
        const currentId = conversationIdRef.current;
        if (currentId && await refreshConversation(currentId, controller.signal)) return;
        if (cancelled) return;
        if ((startFresh || studyContext?.activityId || initialSourceIds.length > 0) && !learningAttempt) return;
        // Practice conversations are associated with turns server-side, but the
        // summary/resume contract does not expose that association. Starting a
        // fresh conversation here prevents another practice attempt's tutoring
        // history from being shown as context for this attempt.
        if (!shouldLoadConversationList(learningAttempt)) return;
        const listed = await api.listConversations();
        if (cancelled) return;
        const selected = conversationForAssistant(listed, initialConversationId, learningAttempt?.courseId ?? initialCourseId ?? undefined);
        if (selected && await refreshConversation(selected.id, controller.signal) && !cancelled) {
          setConversationId(selected.id);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败");
          setRecoveryRequired(true);
        }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, initialConversationId, initialCourseId, learningAttempt, refreshConversation, refreshOrganization, refreshSources, refreshTutorActions, reload, setConversationId, startFresh, studyContext?.activityId, initialSourceIds.length]);

  useEffect(() => {
    if (!activeJobId || !conversationId) return;

    const poller = createJobPoller({
      getJob: (signal) => api.getJob(activeJobId, signal),
      onStatus: async (job, signal) => {
        const terminal = TERMINAL_JOB_STATUSES.has(job.status);
        if (!terminal) {
          setPendingHint(jobStatusHint(job));
          return;
        }
        // Keep polling until the completed conversation can actually be restored.
        // The latest conversation job may already be newer than this poll result.
        await refreshConversation(conversationId, signal, true);
      },
      onError: (pollError) => {
        setPendingHint(
          `回答状态暂时无法读取，正在重试：${
            pollError instanceof Error ? pollError.message : "未知错误"
          }`,
        );
      },
    });
    poller.start();
    return () => poller.cancel();
  }, [activeJobId, api, conversationId, refreshConversation]);

  const savedDisplay = useMemo(
    () => resolveChatMessages({ resume, turns: recoveredTurns }),
    [resume, recoveredTurns],
  );
  const display = useMemo(() => privacy === "ephemeral"
    ? { messages: mergeChatMessages(savedDisplay.messages, ephemeralMessages), historyTruncated: savedDisplay.historyTruncated }
    : savedDisplay, [privacy, savedDisplay, ephemeralMessages]);
  const currentVersions = useMemo(() => Object.fromEntries(sources.map((source) => [source.id, source.version])), [sources]);
  const sourceNames = useMemo(() => Object.fromEntries(sources.map((source) => [source.id, source.name])), [sources]);
  const saveSnippet = useCallback((message: ChatMessageView, selectedText?: SelectedExcerpt) => {
    setSnippetDraft(prepareSnippetDraft(message, selectedText));
  }, []);
  const createCard = useCallback((message: ChatMessageView, selectedText?: SelectedExcerpt) => {
    setCardDraft(prepareSnippetDraft(message, selectedText));
  }, []);

  async function ensureConversation(): Promise<string> {
    if (conversationId && canReuseAssistantConversation(conversationId, learningAttempt, resume, initialCourseId)) return conversationId;
    const created = await api.createConversation({
      title: "学习对话",
      courseId: learningAttempt?.courseId ?? initialCourseId ?? null,
    });
    setConversationId(created.id);
    return created.id;
  }

  function cancelCurrentTurn(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    const jobId = activeJobId;
    if (jobId) {
      void api.cancelJob(jobId).then((job) => {
        setActiveJobId(null);
        setPending(false);
        setPendingHint(jobStatusHint(job) || "回答任务已取消；服务端不会继续写入结果。",);
        if (conversationId) void refreshConversation(conversationId);
      }).catch((cancelError) => {
        setPendingHint(`取消请求未确认：${cancelError instanceof Error ? cancelError.message : "服务暂时不可用"}`);
      });
      return;
    }
    setPending(false);
    setPendingHint("本轮已取消；不保存模式的内容不会写入对话。",);
  }

  async function handleSubmit(input: ComposerSubmit): Promise<{ accepted: boolean }> {
    // Check the current clock at the actual send boundary, including background tabs.
    if (unknownTurnRecovery(unknownJob, Date.now())?.canRetry === false) return { accepted: false };
    setError("");
    setAutoSelectNotice(null);
    if (studyContextError) { setError(studyContextError); return { accepted: false }; }
    if (studyContext?.sourceId && studyContext.sourceVersion !== undefined) {
      try {
        const sequence = ++sourceRequestSequence.current;
        const latestSources = await api.listSources();
        if (sequence === sourceRequestSequence.current) setSources(latestSources);
        const problem = pinnedStudySourceProblem(studyContext, latestSources);
        if (problem) { setError(problem); return { accepted: false }; }
      } catch { setError("无法核对指定材料版本，本次未发送；问题草稿已保留。"); return { accepted: false }; }
    }
    const submittedText = questionWithStudyContext(input.text, studyContext);
    if (submittedText.length > 20000) { setError("问题和携入背景合计超过 20000 字，请缩短问题或选中片段后再发送。"); return { accepted: false }; }
    let page: number | null | undefined;
    try {
      page = pageForSubmit(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "页码无效");
      return { accepted: false };
    }

    // Package A soft confirm; Package B supplies membership-ready flag + query courseId.
    if (shouldConfirmEmptyCourseSources({
      sourceIds: selectedSourceIds,
      courseId: boundCourseId,
      hasReadyCourseMaterials: readyCourseMaterials,
    })) {
      if (!window.confirm(EMPTY_COURSE_SOURCES_CONFIRM)) {
        setContextOpen(true);
        return { accepted: false };
      }
    }

    setPending(true);
    let jobSubmitted = false;
    const abortController = new AbortController();
    abortRef.current = abortController;
    try {
      if (input.privacy === "ephemeral" && !learningAttempt) {
        const history = ephemeralHistoryFromMessages(ephemeralMessages);
        const output = await api.replyEphemeral({
          text: submittedText,
          sourceIds: selectedSourceIds,
          mode: input.mode,
          history,
          ...(ephemeralPrivacyEpoch === undefined ? {} : { historyPrivacyEpoch: ephemeralPrivacyEpoch }),
          ...(page !== undefined ? { currentPage: page } : {}),
          ...(studyContext?.chunkId ? { chunkId: studyContext.chunkId } : {}),
          // Package B/C: course scope lets server fill/narrow when sourceIds empty.
          ...(boundCourseId ? { courseId: boundCourseId } : {}),
        }, abortController.signal);
        if (abortController.signal.aborted) return { accepted: false };
        setEphemeralPrivacyEpoch(output.privacyEpoch);
        const applied = applyEffectiveSourceIds(output.effectiveSourceIds);
        const turnSourceIds = applied.sourceIds ?? selectedSourceIds;
        if (applied.sourceIds) {
          setSelectedSourceIds(applied.sourceIds);
        }
        if (applied.notice) {
          setAutoSelectNotice(applied.notice);
        }
        setEphemeralMessages((current) => appendEphemeralResponseIfActive(current, {
          clientKey: input.clientKey,
          text: submittedText,
          sourceIds: turnSourceIds,
          output,
        }, abortController.signal));
        setPendingHint(output.historyDiscarded
          ? "隐私设置已变化或旧临时历史无法验证，已清除旧临时上下文；本次只发送当前输入和允许的材料。"
          : "本轮仅保留在当前标签页；刷新后不会恢复。");
        preserveEntrySelection.current = false;
        setDraft("");
        setPending(false);
        abortRef.current = null;
        return { accepted: true };
      }
      const id = await ensureConversation();
      const submitted = await api.submitTurn({
        conversationId: id,
        text: submittedText,
        sourceIds: selectedSourceIds,
        mode: input.mode,
        clientKey: input.clientKey,
        privacy: "saved",
        ...learningAttemptTurnContext(learningAttempt),
        ...(page !== undefined ? { currentPage: page } : {}),
        ...(studyContext?.chunkId ? { chunkId: studyContext.chunkId } : {}),
      });
      setActiveJobId(submitted.jobId);
      setUnknownJob(null);
      jobSubmitted = true;
      setPendingHint("回答任务已提交，等待状态更新。");
      abortRef.current = null;
      preserveEntrySelection.current = false;
      setDraft("");
      await refreshConversation(id);
      return { accepted: true };
    } catch (err) {
      abortRef.current = null;
      if (abortController.signal.aborted) {
        setPending(false);
        setError("");
        return { accepted: false };
      }
      if (!jobSubmitted) setPending(false);
      if (err instanceof OpeningApiError && err.code === "PRIVACY_CHANGED") {
        setEphemeralMessages([]);
        setEphemeralPrivacyEpoch(undefined);
        setPendingHint("隐私设置已变化，旧临时上下文已清除；本次未发送，请确认材料后重试。");
      }
      if (
        err instanceof OpeningApiError &&
        err.code === "page_not_in_sources" &&
        currentPage.trim() !== ""
      ) {
        setCurrentPage("");
      }
      setError(formatTurnError(err));
      return { accepted: false };
    }
  }

  function handleTutorAction(action: ThinTutorAction): void {
    applyTutorActionIntent(tutorActionIntent(action));
  }

  function applyTutorActionIntent(intent: TutorActionIntent): void {
    if (pending || loading || recoveryRequired) return;
    switch (intent.kind) {
      case "clarify":
        setContextOpen(true);
        return;
      case "guided":
      case "worked_example": {
        // Chips prefill the matching composer mode, per Lab design v2 §4;
        // the user confirms before anything is sent.
        setModePrefill({ mode: intent.mode, nonce: Date.now() });
        setDraft(replacePromptDraft(draft, presetPromptForMode(intent.mode), () => true));
        return;
      }
      case "independent_variant":
        setDraft(replacePromptDraft(draft, intent.draft, () => true));
        setPendingHint("独立做变式题：完成后请在练习表单里提交结果。");
        return;
      case "delayed_retest":
        void acceptDueRetest(intent.action);
        return;
    }
  }

  async function acceptDueRetest(action: ThinTutorAction): Promise<void> {
    setTutorActionError("");
    try {
      const retests = await api.listRetestCandidates();
      // Only an explicit user click accepts; already-accepted due activities
      // are opened instead of re-accepted (Lab design v2 §4).
      const candidates = retests.filter((row) => !row.accepted && row.skillLabel === action.skillLabel);
      if (candidates.length === 0) {
        setPendingHint(`「${action.skillLabel}」没有待接受的重测任务；已接受的请到今日任务队列查看。`);
        return;
      }
      const accepted: string[] = [];
      for (const candidate of candidates) {
        const outcome = await api.acceptRetest(candidate.id, `retest-${crypto.randomUUID()}`);
        accepted.push(outcome.taskId);
      }
      setPendingHint(`已接受 ${accepted.length} 个到期重测任务；到今日任务队列开始。`);
    } catch (err) {
      setTutorActionError(err instanceof Error ? err.message : "无法接受到期重测");
    }
  }

  const setPrompt = useCallback((value: string) => {
    if (pending || loading || recoveryRequired) return;
    setDraft(replacePromptDraft(draftRef.current, value, () => window.confirm("将内容带入输入？已有未发送的草稿将被替换。")));
  }, [pending, loading, recoveryRequired, setDraft]);
  function prepareUnknownQuestion() {
    if (!retryQuestion || pending || loading || recoveryRequired || unknownTurnRecovery(unknownJob, Date.now())?.canRetry !== true) return;
    const next = replacePromptDraft(draft, retryQuestion.text, () => window.confirm("将原问题带回输入框？当前未发送的草稿将被替换。"));
    if (next !== retryQuestion.text) return;
    setDraft(next);
    changePrivacy("saved");
    draftStore.write(draftScope, next);
    setModePrefill({ mode: retryQuestion.mode, nonce: Date.now() });
    // This is an explicit new question, not a replay of an unconfirmed submission key.
    setRetryDraftVersion(value => value + 1);
    setPendingHint("");
    window.requestAnimationFrame(() => document.getElementById(draftId)?.focus());
  }
  const Heading = embedded ? "h2" : "h1";
  const sourceProblem = !loading ? pinnedStudySourceProblem(studyContext, sources) : null;
  const contextProblem = studyContextError ?? sourceProblem;
  const returnHref = studyContextReturnHref(studyContext);
  return <section aria-label="自由探索工作台" className="flex h-full min-h-[400px] min-w-0 overflow-hidden bg-white lg:min-h-0">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 sm:px-5">
        <Heading className="min-w-0 truncate text-sm font-semibold text-zinc-800">{task?.title || initialTitle || (learningAttempt ? "练习辅导" : "自由探索")}</Heading>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={secondaryButtonClass} aria-expanded={contextOpen} aria-controls="exploration-context" onClick={() => setContextOpen(!contextOpen)}><BookOpen size={14} aria-hidden /><span className="hidden sm:inline">{selectedSourceIds.length ? `${selectedSourceIds.length} 份材料` : "参考资料"}</span><span className="sr-only sm:hidden">参考资料</span></button>
          {!learningAttempt ? <button type="button" className={secondaryButtonClass} aria-label="新对话" title="新对话" disabled={pending || loading} onClick={() => { if (draft.trim() && !window.confirm("开始新对话？当前未发送的输入将被清空。")) return; draftStore.remove(draftScope); onNew(selectedSourceIds, pageIntentValue(currentPage)); }}><Plus size={15} aria-hidden /></button> : null}
        </div>
      </header>
      {studyContext ? <div className="space-y-1 border-b border-zinc-100 px-4 py-2 text-xs leading-5 text-zinc-600 sm:px-5">
        <p>提问背景：{studyContext.label || (studyContext.activityId ? "当前学习单元" : "指定材料")}{studyContext.page ? ` · 第 ${studyContext.page} 页` : ""}</p>
        <p>{studyContext.activityId || studyContext.fragment ? "背景将在你发送时作为文字附上；资料依据仍以回答中的真实引用为准。" : "已指定参考材料和位置；回答中的实际引用用于核对依据。"}</p>
        {returnHref && !embedded ? <a href={returnHref} className="text-emerald-800 underline">返回原内容</a> : null}
        <details><summary className="cursor-pointer">上下文详情</summary><dl className="break-all">
          {studyContext.courseId ? <><dt>课程</dt><dd>{studyContext.courseId}</dd></> : null}
          {studyContext.activityId ? <><dt>活动 / 内容版本</dt><dd>{studyContext.activityId} / {studyContext.contentVersion ?? "未指定"}</dd></> : null}
          {studyContext.blockId ? <><dt>学习单元</dt><dd>{studyContext.blockId}</dd></> : null}
          {studyContext.sourceId ? <><dt>材料 / 版本</dt><dd>{studyContext.sourceId} / {studyContext.sourceVersion ?? "提交时当前版本"}</dd></> : null}
          {studyContext.fragment ? <><dt>带入片段</dt><dd className="whitespace-pre-wrap">{studyContext.fragment}</dd></> : null}
        </dl></details>
      </div> : null}
      {contextProblem ? <p role="alert" className="mx-4 mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{contextProblem}{returnHref ? <a href={returnHref} className="ml-2 underline">返回阅读</a> : null}</p> : null}
      {task ? <TaskContext task={task} api={api} disabled={pending || loading || recoveryRequired} onPrompt={setPrompt} /> : null}
      {loading ? <div className="flex-1 p-5"><LoadingRows label="正在恢复学习上下文…" /></div> : recoveryRequired && !display.messages.length ? <p className="flex-1 px-5 py-6 text-sm text-zinc-500">学习上下文暂时无法恢复，请重新读取。</p> : <MessageList disabled={pending || recoveryRequired || waitingForUnknown} messages={display.messages} historyTruncated={display.historyTruncated} currentVersions={currentVersions} sourceNames={sourceNames} onPrompt={setPrompt} onSaveSnippet={saveSnippet} onCreateCard={createCard} />}
      {unknownJob && unknownRecovery ? <UnknownTurnNotice job={unknownJob} canRetry={unknownRecovery.canRetry} disabled={pending || loading || recoveryRequired || !retryQuestion} onRetry={prepareUnknownQuestion} /> : pendingHint ? <p role="status" className="mx-5 mb-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{pendingHint}</p> : null}
      {autoSelectNotice ? (
        <div role="status" className="mx-5 mb-2 flex items-start justify-between gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">
          <p className="min-w-0 flex-1">{autoSelectNotice}</p>
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-emerald-800 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50" onClick={() => setAutoSelectNotice(null)} aria-label="关闭自动选入提示">关闭</button>
        </div>
      ) : null}
      {error || recoveryRequired ? <div className="mx-5 mb-2 border border-red-200 bg-red-50 px-3 py-2">{error ? <p role="alert" className="text-xs leading-5 text-red-800">{error}</p> : null}{recoveryRequired ? <button type="button" className={`${secondaryButtonClass} mt-2`} onClick={() => setReload((value) => value + 1)} disabled={loading}>重新读取对话</button> : null}</div> : null}
      {tutorActionError ? <p role="status" className="mx-5 mb-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{tutorActionError}</p> : null}
      {tutorActions.length > 0 && learningAttempt ? (
        <div className="mx-5 mb-2 flex flex-wrap gap-1.5">
          {tutorActions.map((action) => (
            <button key={action.kind} type="button" className={secondaryButtonClass} title={action.reason} disabled={pending || loading || recoveryRequired} onClick={() => handleTutorAction(action)}>{tutorActionLabel(action.kind)}</button>
          ))}
        </div>
      ) : null}

      {!learningAttempt ? <AiReadinessChecklist className="mx-5 mb-2" /> : null}
      {draftUnavailable && privacy === "saved" ? <p role="status" className="mx-5 mb-2 text-xs leading-5 text-amber-800">问题草稿会保留在当前页面；浏览器无法持久保存，刷新或关闭前请先复制。</p> : null}
      <Composer key={retryDraftVersion} draftId={draftId} practiceMode={Boolean(learningAttempt)} draft={draft} modePrefill={modePrefill} intent={{ sourceIds: selectedSourceIds, currentPage: pageIntentValue(currentPage), chunkId: studyContext?.chunkId }} onContext={() => setContextOpen(true)} contextLabel={assistantContextHint(selectedSourceIds)} onDraftChange={setDraft} pending={pending} disabled={loading || recoveryRequired || waitingForUnknown || !!contextProblem} privacy={privacy} onPrivacyChange={learningAttempt ? undefined : changePrivacy} onCancel={cancelCurrentTurn} onSubmit={handleSubmit} />
    </div>
    {snippetDraft ? <SaveSnippetDialog draft={snippetDraft} api={api} onClose={() => setSnippetDraft(null)} /> : null}
    {cardDraft ? <CreateCardDialog draft={cardDraft.input} api={api} onClose={() => setCardDraft(null)} /> : null}
    <ResponsiveInspector open={contextOpen} onClose={() => setContextOpen(false)} title="参考资料与记忆" id="exploration-context">
      <p className="mb-4 text-xs leading-6 text-zinc-500">{assistantContextHint(selectedSourceIds)}</p>
      {sourceRefreshError ? <div className="mb-3 space-y-2 text-xs text-amber-800"><p role="status">材料状态暂时无法读取；已保留上次状态，会继续核实，尚未标记为解析完成。</p><button type="button" className={secondaryButtonClass} onClick={() => { if (sourceRefresh.current) sourceRefresh.current.retry(); else void refreshSources().catch(() => setSourceRefreshError(true)); }}>重新读取材料状态</button></div> : null}
      <UploadStrip sources={sources} api={api} onUploaded={handleUploaded} disabled={pending || loading || recoveryRequired} courseId={boundCourseId} />
      <SourcePageControls
        sources={learningAttempt ? sources.filter((source) => learningAttempt.sourceIds.includes(source.id)) : sources}
        selectedSourceIds={selectedSourceIds}
        currentPage={currentPage}
        onSelectedSourceIdsChange={value => { preserveEntrySelection.current = false; setSelectedSourceIds(value); }}
        onCurrentPageChange={value => { preserveEntrySelection.current = false; setCurrentPage(value); }}
        disabled={pending || loading}
        membershipSourceIds={learningAttempt || !boundCourseId ? null : membershipIds}
      />
      <Link className={`${secondaryButtonClass} mt-3 w-full justify-between`} href="/opening/library?tab=materials#upload">管理 / 上传材料<ArrowUpRight size={13} aria-hidden /></Link>
      <details className="mt-5 border-t border-zinc-200 pt-2"><summary className="flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 focus-visible:ring-2 focus-visible:ring-emerald-700"><ShieldCheck size={14} aria-hidden />AI 记忆与待确认建议</summary><MemoryPanel api={api} /></details>
    </ResponsiveInspector>
  </section>;
}
