"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationResume, ConversationSummary, LearningAttempt, SourceRecord, TutorMode, TurnRecord } from "@aistudy/contracts";
import { OpeningApiError, createOpeningApi, type JobStatusResponse, type OpeningApi } from "../client/api";
import { Composer, type ComposerPrivacy, type ComposerSubmit } from "./composer";
import { MessageList } from "./message-list";
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
import { prepareSnippetDraft } from "./save-snippet";
import { SaveSnippetDialog } from "./save-snippet-dialog";
import { CreateCardDialog } from "../cards/create-card-dialog";
import { UploadStrip } from "./upload-strip";
import { AiReadinessChecklist } from "./ai-readiness";
import type { ThinTutorAction } from "@aistudy/domain";
import { tutorActionIntent, type TutorActionIntent } from "../learning/tutor-action-intents";
import { nodeIdForSkillLabel } from "../learning/knowledge-node-lookup";

type Props = {
  api?: OpeningApi;
  initialConversationId?: string | null;
  learningAttempt?: LearningAttempt;
  task?: StudyTask | null;
  initialTitle?: string;
  startFresh?: boolean;
  initialSourceIds?: string[];
  initialPage?: number | null;
  initialDraft?: string;
  embedded?: boolean;
};

const TERMINAL_JOB_STATUSES = new Set<JobStatusResponse["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

type JobPollerOptions = {
  getJob: () => Promise<JobStatusResponse>;
  onStatus: (job: JobStatusResponse) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
};

export function createJobPoller({
  getJob,
  onStatus,
  onError,
  intervalMs = 1_000,
}: JobPollerOptions) {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const poll = async (): Promise<void> => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const job = await getJob();
      if (!active) return;
      await onStatus(job);
      if (!active || TERMINAL_JOB_STATUSES.has(job.status)) {
        active = false;
        return;
      }
      timer = setTimeout(() => void poll(), intervalMs);
    } catch (error) {
      if (!active) return;
      onError?.(error);
      timer = setTimeout(() => void poll(), intervalMs);
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      void poll();
    },
    cancel() {
      active = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function jobStatusHint(job: JobStatusResponse): string {
  if (job.status === "queued") return "回答任务已排队。";
  if (job.status === "running") return "回答任务生成中。";
  if (job.status === "failed") {
    return `回答任务失败：${job.error?.message ?? "服务未提供失败原因"}`;
  }
  if (job.status === "cancelled") return "回答任务已取消。";
  if (job.status === "outcome_unknown") {
    return `回答结果状态未知：${job.error?.message ?? "服务未提供原因"}。请勿重复提交。`;
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
  input: { clientKey: string; text: string; output: { requestId: string | null; text: string; historyDiscarded?: boolean; provenanceId?: string | null } },
  signal: AbortSignal,
): ChatMessageView[] {
  if (signal.aborted) return current;
  return [...(input.output.historyDiscarded ? [] : current),
    { id: `ephemeral-user-${input.clientKey}`, role: "user", text: input.text, citations: [], citationLabels: [], origin: "ephemeral", provenanceId: input.output.provenanceId ?? null },
    { id: `ephemeral-assistant-${input.output.requestId ?? input.clientKey}`, role: "assistant", text: input.output.text, citations: [], citationLabels: [], status: "complete", origin: "ephemeral", provenanceId: input.output.provenanceId ?? null },
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

export function canReuseAssistantConversation(conversationId: string | null, learningAttempt?: LearningAttempt, resume?: ConversationResume | null): boolean {
  return Boolean(conversationId && (!learningAttempt || resume === null || resume === undefined || resume.courseId === learningAttempt.courseId));
}

export function conversationForAssistant(
  listed: readonly ConversationSummary[],
  initialConversationId: string | null,
  attemptCourseId?: string,
): ConversationSummary | null {
  const eligible = attemptCourseId ? listed.filter((row) => row.courseId === attemptCourseId) : listed;
  return eligible.find((row) => row.id === initialConversationId) ?? eligible[0] ?? null;
}

export function selectionForResumedConversation(resume: ConversationResume, attempt?: LearningAttempt) {
  return attempt
    ? { sourceIds: attempt.sourceIds, currentPage: null }
    : { sourceIds: resume.sourceIds, currentPage: resume.currentPage ?? null };
}

export function AssistantView(props: Props) {
  const [session, setSession] = useState(0);
  return <AssistantWorkspace key={session} {...props} initialConversationId={session ? null : props.initialConversationId}
    initialTitle={session ? undefined : props.initialTitle} startFresh={session ? true : props.startFresh}
    initialSourceIds={session ? [] : props.initialSourceIds} initialPage={session ? null : props.initialPage}
    initialDraft={session ? "" : props.initialDraft}
    onNew={() => setSession((value) => value + 1)} />;
}
function AssistantWorkspace({ api: apiProp, initialConversationId = null, learningAttempt, task, initialTitle,
  startFresh = false, initialSourceIds = [], initialPage = null, initialDraft = "", embedded = false, onNew }: Props & { onNew: () => void }) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [conversationId, setConversationId] = useState<string | null>(
    learningAttempt ? null : initialConversationId,
  );
  const [resume, setResume] = useState<ConversationResume | null>(null);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(learningAttempt?.sourceIds ?? initialSourceIds);
  const [currentPage, setCurrentPage] = useState(initialPage == null ? "" : String(initialPage));
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [draft, setDraft] = useState(initialDraft);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [reload, setReload] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState("");
  const [pendingHint, setPendingHint] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<ComposerPrivacy>("saved");
  const [ephemeralMessages, setEphemeralMessages] = useState<ChatMessageView[]>([]);
  const [ephemeralPrivacyEpoch, setEphemeralPrivacyEpoch] = useState<number>();
  const [snippetDraft, setSnippetDraft] = useState<ReturnType<typeof prepareSnippetDraft>>(null);
  const [cardDraft, setCardDraft] = useState<ReturnType<typeof prepareSnippetDraft>>(null);
  const [tutorActions, setTutorActions] = useState<ThinTutorAction[]>([]);
  const [tutorActionError, setTutorActionError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [modePrefill, setModePrefill] = useState<{ mode: TutorMode; nonce: number } | null>(null);

  const refreshSources = useCallback(async () => {
    setSources(await api.listSources());
  }, [api]);

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
    async (id: string) => {
      const nextResume = await api.resumeConversation(id);
      if (learningAttempt && nextResume.courseId !== learningAttempt.courseId) {
        setConversationId(null); setResume(null); setTurns([]);
        return false;
      }
      const nextTurns = await api.listTurns(id);
      setResume(nextResume);
      setTurns(nextTurns);
      const restoredSelection = selectionForResumedConversation(nextResume, learningAttempt);
      if (learningAttempt || restoredSelection.sourceIds.length > 0) {
        setSelectedSourceIds(restoredSelection.sourceIds);
      }
      if (!learningAttempt && restoredSelection.currentPage != null) {
        setCurrentPage(String(restoredSelection.currentPage));
      }
      let pendingJob: JobStatusResponse | null;
      try {
        pendingJob = await api.getPendingJob(id);
      } catch (lookupError) {
        const discovered = pendingJobDiscoveryState({ ok: false, error: lookupError });
        if (discovered.kind === "unavailable") {
          setPendingHint(`尚未确认是否有进行中的回答：${discovered.message}`);
          setRecoveryRequired(true);
        }
        return true;
      }
      setRecoveryRequired(false);
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
    },
    [api, learningAttempt],
  );


  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setRecoveryRequired(false);
    (async () => {
      try {
        await refreshSources();
        await refreshTutorActions();
        if (cancelled) return;
        if (initialConversationId && !learningAttempt) {
          setConversationId(initialConversationId);
          await refreshConversation(initialConversationId);
          return;
        }
        if (startFresh && !learningAttempt) return;
        if (conversationId && shouldRefreshCurrentConversation(learningAttempt, conversationId)) {
          await refreshConversation(conversationId);
          return;
        }
        // Practice conversations are associated with turns server-side, but the
        // summary/resume contract does not expose that association. Starting a
        // fresh conversation here prevents another practice attempt's tutoring
        // history from being shown as context for this attempt.
        if (!shouldLoadConversationList(learningAttempt)) return;
        const listed = await api.listConversations();
        if (cancelled) return;
        const selected = conversationForAssistant(listed, initialConversationId, learningAttempt?.courseId);
        if (selected && await refreshConversation(selected.id) && !cancelled) {
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
    };
  }, [api, conversationId, initialConversationId, learningAttempt, refreshConversation, refreshSources, refreshTutorActions, reload, startFresh]);

  useEffect(() => {
    if (!activeJobId || !conversationId) return;

    const poller = createJobPoller({
      getJob: () => api.getJob(activeJobId),
      onStatus: async (job) => {
        const terminal = TERMINAL_JOB_STATUSES.has(job.status);
        if (!terminal) {
          setPendingHint(jobStatusHint(job));
          return;
        }
        setPending(false);
        setActiveJobId(null);
        await refreshConversation(conversationId);
        setPendingHint(jobStatusHint(job));
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
    () => resolveChatMessages({ resume, turns }),
    [resume, turns],
  );
  const display = privacy === "ephemeral"
    ? { messages: mergeChatMessages(savedDisplay.messages, ephemeralMessages), historyTruncated: savedDisplay.historyTruncated }
    : savedDisplay;

  async function ensureConversation(): Promise<string> {
    if (conversationId && canReuseAssistantConversation(conversationId, learningAttempt, resume)) return conversationId;
    const created = await api.createConversation({
      title: "学习对话",
      courseId: learningAttempt?.courseId ?? null,
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
    setError("");
    let page: number | null | undefined;
    try {
      page = pageForSubmit(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "页码无效");
      return { accepted: false };
    }

    setPending(true);
    let jobSubmitted = false;
    const abortController = new AbortController();
    abortRef.current = abortController;
    try {
      if (input.privacy === "ephemeral" && !learningAttempt) {
        const history = ephemeralHistoryFromMessages(ephemeralMessages);
        const output = await api.replyEphemeral({
          text: input.text,
          sourceIds: selectedSourceIds,
          mode: input.mode,
          history,
          ...(ephemeralPrivacyEpoch === undefined ? {} : { historyPrivacyEpoch: ephemeralPrivacyEpoch }),
          ...(page !== undefined ? { currentPage: page } : {}),
        }, abortController.signal);
        if (abortController.signal.aborted) return { accepted: false };
        setEphemeralPrivacyEpoch(output.privacyEpoch);
        setEphemeralMessages((current) => appendEphemeralResponseIfActive(current, {
          clientKey: input.clientKey,
          text: input.text,
          output,
        }, abortController.signal));
        setPendingHint(output.historyDiscarded
          ? "隐私设置已变化或旧临时历史无法验证，已清除旧临时上下文；本次只发送当前输入和允许的材料。"
          : "本轮仅保留在当前标签页；刷新后不会恢复。");
        setDraft("");
        setPending(false);
        abortRef.current = null;
        return { accepted: true };
      }
      const id = await ensureConversation();
      const submitted = await api.submitTurn({
        conversationId: id,
        text: input.text,
        sourceIds: selectedSourceIds,
        mode: input.mode,
        clientKey: input.clientKey,
        privacy: "saved",
        ...learningAttemptTurnContext(learningAttempt),
        ...(page !== undefined ? { currentPage: page } : {}),
      });
      setActiveJobId(submitted.jobId);
      jobSubmitted = true;
      setPendingHint("回答任务已提交，等待状态更新。");
      abortRef.current = null;
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

  function setPrompt(value: string) {
    if (pending || loading || recoveryRequired) return;
    setDraft(replacePromptDraft(draft, value, () => window.confirm("将内容带入输入？已有未发送的草稿将被替换。")));
  }
  const Heading = embedded ? "h2" : "h1";
  return <section aria-label="自由探索工作台" className="flex h-full min-h-[400px] min-w-0 overflow-hidden bg-white lg:min-h-0">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 sm:px-5">
        <Heading className="min-w-0 truncate text-sm font-semibold text-zinc-800">{task?.title || initialTitle || (learningAttempt ? "练习辅导" : "自由探索")}</Heading>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={secondaryButtonClass} aria-expanded={contextOpen} aria-controls="exploration-context" onClick={() => setContextOpen(!contextOpen)}><BookOpen size={14} aria-hidden /><span className="hidden sm:inline">{selectedSourceIds.length ? `${selectedSourceIds.length} 份材料` : "参考资料"}</span><span className="sr-only sm:hidden">参考资料</span></button>
          {!learningAttempt ? <button type="button" className={secondaryButtonClass} aria-label="新对话" title="新对话" disabled={pending || loading} onClick={() => { if (draft.trim() && !window.confirm("开始新对话？当前未发送的输入将被清空。")) return; onNew(); }}><Plus size={15} aria-hidden /></button> : null}
        </div>
      </header>
      {task ? <TaskContext task={task} api={api} disabled={pending || loading || recoveryRequired} onPrompt={setPrompt} /> : null}
      {loading ? <div className="flex-1 p-5"><LoadingRows label="正在恢复学习上下文…" /></div> : recoveryRequired && !display.messages.length ? <p className="flex-1 px-5 py-6 text-sm text-zinc-500">学习上下文暂时无法恢复，请重新读取。</p> : <MessageList messages={display.messages} historyTruncated={display.historyTruncated} currentVersions={Object.fromEntries(sources.map((source) => [source.id, source.version]))} onPrompt={setPrompt} onSaveSnippet={(message, selectedText) => setSnippetDraft(prepareSnippetDraft(message, selectedText))} onCreateCard={(message, selectedText) => setCardDraft(prepareSnippetDraft(message, selectedText))} />}
      {pendingHint ? <p role="status" className="mx-5 mb-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{pendingHint}</p> : null}
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
      {!learningAttempt ? <p className="mx-5 mb-2 text-[11px] leading-5 text-zinc-500"><Link href="/opening/settings/connections" className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-800">数据连接与授权</Link>：不可用时显示不可用，不填充示例同步内容。</p> : null}
      <Composer practiceMode={Boolean(learningAttempt)} draft={draft} modePrefill={modePrefill} intent={{ sourceIds: selectedSourceIds, currentPage: pageIntentValue(currentPage) }} onContext={() => setContextOpen(true)} contextLabel={assistantContextHint(selectedSourceIds)} onDraftChange={setDraft} pending={pending} disabled={loading || recoveryRequired} privacy={privacy} onPrivacyChange={learningAttempt ? undefined : setPrivacy} onCancel={cancelCurrentTurn} onSubmit={handleSubmit} />
    </div>
    {snippetDraft ? <SaveSnippetDialog draft={snippetDraft} api={api} onClose={() => setSnippetDraft(null)} /> : null}
    {cardDraft ? <CreateCardDialog draft={cardDraft} api={api} onClose={() => setCardDraft(null)} /> : null}
    <ResponsiveInspector open={contextOpen} onClose={() => setContextOpen(false)} title="参考资料与记忆" id="exploration-context">
      <p className="mb-4 text-xs leading-6 text-zinc-500">{assistantContextHint(selectedSourceIds)}。仅选中的就绪材料用于本轮提问。</p>
      <UploadStrip api={api} onUploaded={refreshSources} disabled={pending || loading || recoveryRequired} />
      <SourcePageControls sources={learningAttempt ? sources.filter((source) => learningAttempt.sourceIds.includes(source.id)) : sources} selectedSourceIds={selectedSourceIds} currentPage={currentPage} onSelectedSourceIdsChange={setSelectedSourceIds} onCurrentPageChange={setCurrentPage} disabled={pending || loading} />
      <Link className={`${secondaryButtonClass} mt-3 w-full justify-between`} href="/opening/library?tab=materials#upload">管理 / 上传材料<ArrowUpRight size={13} aria-hidden /></Link>
      <details className="mt-5 border-t border-zinc-200 pt-2"><summary className="flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 focus-visible:ring-2 focus-visible:ring-emerald-700"><ShieldCheck size={14} aria-hidden />AI 记忆与待确认建议</summary><MemoryPanel api={api} /></details>
      <p className="mt-6 text-[11px] leading-5 text-zinc-500">选择资料不会发送消息。AI 建议需由你确认后才进入后续上下文。</p>
    </ResponsiveInspector>
  </section>;
}
