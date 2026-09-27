"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationResume, SourceRecord, TurnRecord } from "@aistudy/contracts";
import { OpeningApiError, createOpeningApi, type JobStatusResponse, type OpeningApi } from "../client/api";
import { Composer, type ComposerPrivacy, type ComposerSubmit } from "./composer";
import { MessageList } from "./message-list";
import { resolveChatMessages, type ChatMessageView } from "./message-model";
import { SourcePageControls } from "./source-page-controls";
import { formatTurnError, pageForSubmit } from "./turn-errors";
import { InboxPanel } from "../inbox/inbox-panel";
import { MemoryPanel } from "./memory-panel";

type Props = {
  api?: OpeningApi;
  initialConversationId?: string | null;
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
  | { kind: "active"; activeJobId: string; pending: true; hint: string };

/** Null is no pending job. A lookup error must stay unavailable, not empty. */
export function pendingJobDiscoveryState(
  result: { ok: true; job: JobStatusResponse | null } | { ok: false; error: unknown },
): PendingJobDiscovery {
  if (!result.ok) {
    const message = result.error instanceof Error ? result.error.message : "服务暂时不可用";
    return { kind: "unavailable", message };
  }
  if (!result.job || (result.job.status !== "queued" && result.job.status !== "running")) {
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

export function mergeChatMessages(
  saved: ChatMessageView[],
  ephemeral: ChatMessageView[],
): ChatMessageView[] {
  return [...saved, ...ephemeral];
}

export function appendEphemeralResponseIfActive(
  current: ChatMessageView[],
  input: { clientKey: string; text: string; output: { requestId: string | null; text: string } },
  signal: AbortSignal,
): ChatMessageView[] {
  if (signal.aborted) return current;
  return [...current,
    { id: `ephemeral-user-${input.clientKey}`, role: "user", text: input.text, citations: [], citationLabels: [] },
    { id: `ephemeral-assistant-${input.output.requestId ?? input.clientKey}`, role: "assistant", text: input.output.text, citations: [], citationLabels: [], status: "complete" },
  ];
}

export function AssistantView({ api: apiProp, initialConversationId = null }: Props) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId,
  );
  const [resume, setResume] = useState<ConversationResume | null>(null);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState("");
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pendingHint, setPendingHint] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<ComposerPrivacy>("saved");
  const [ephemeralMessages, setEphemeralMessages] = useState<ChatMessageView[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSources = useCallback(async () => {
    setSources(await api.listSources());
  }, [api]);

  const refreshConversation = useCallback(
    async (id: string) => {
      const nextResume = await api.resumeConversation(id);
      const nextTurns = await api.listTurns(id).catch(() => [] as TurnRecord[]);
      setResume(nextResume);
      setTurns(nextTurns);
      if (nextResume.sourceIds.length > 0) {
        setSelectedSourceIds(nextResume.sourceIds);
      }
      if (nextResume.currentPage != null) {
        setCurrentPage(String(nextResume.currentPage));
      }
      let pendingJob: JobStatusResponse | null;
      try {
        pendingJob = await api.getPendingJob(id);
      } catch (lookupError) {
        const discovered = pendingJobDiscoveryState({ ok: false, error: lookupError });
        if (discovered.kind === "unavailable") {
          setPendingHint(`尚未确认是否有进行中的回答：${discovered.message}`);
        }
        return;
      }
      const discovered = pendingJobDiscoveryState({ ok: true, job: pendingJob });
      if (discovered.kind === "active") {
        setActiveJobId(discovered.activeJobId);
        setPending(discovered.pending);
        setPendingHint(discovered.hint);
      } else {
        setActiveJobId(null);
        setPending(false);
        setPendingHint("");
      }
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshSources();
        if (cancelled) return;
        if (initialConversationId) {
          setConversationId(initialConversationId);
          await refreshConversation(initialConversationId);
          return;
        }
        const listed = await api.listConversations();
        if (cancelled) return;
        if (listed[0]) {
          setConversationId(listed[0].id);
          await refreshConversation(listed[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, initialConversationId, refreshConversation, refreshSources]);

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
    if (conversationId) return conversationId;
    const created = await api.createConversation({
      title: "学习对话",
      courseId: null,
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
      if (input.privacy === "ephemeral") {
        const history = ephemeralMessages.slice(-16).map((message) => ({
          role: message.role,
          text: message.text,
        }));
        const output = await api.replyEphemeral({
          text: input.text,
          sourceIds: selectedSourceIds,
          mode: input.mode,
          history,
          ...(page !== undefined ? { currentPage: page } : {}),
        }, abortController.signal);
        setEphemeralMessages((current) => appendEphemeralResponseIfActive(current, {
          clientKey: input.clientKey,
          text: input.text,
          output,
        }, abortController.signal));
        setPendingHint("本轮仅保留在当前标签页；刷新后不会恢复。",);
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

  return (
    <div className="flex h-full min-h-[28rem] flex-col rounded-xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-3 py-2">
        <h1 className="text-base font-semibold text-zinc-900">助理（M1 薄聊天）</h1>
        <p className="text-xs text-zinc-500">
          {assistantContextHint(selectedSourceIds)}。保存模式写入对话；不保存本轮只保留在当前标签页。
        </p>
      </header>
      <InboxPanel api={api} sources={sources} onChanged={refreshSources} />
      <MemoryPanel api={api} />
      <SourcePageControls
        sources={sources}
        selectedSourceIds={selectedSourceIds}
        currentPage={currentPage}
        onSelectedSourceIdsChange={setSelectedSourceIds}
        onCurrentPageChange={setCurrentPage}
        disabled={pending}
      />
      <MessageList
        messages={display.messages}
        historyTruncated={display.historyTruncated}
        currentVersions={Object.fromEntries(sources.map((source) => [source.id, source.version]))}
      />
      {pendingHint ? (
        <p className="px-3 text-xs text-amber-800">{pendingHint}</p>
      ) : null}
      {error ? (
        <p className="px-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <Composer
        draft={draft}
        intent={{
          sourceIds: selectedSourceIds,
          currentPage: pageIntentValue(currentPage),
        }}
        onDraftChange={setDraft}
        pending={pending}
        privacy={privacy}
        onPrivacyChange={setPrivacy}
        onCancel={cancelCurrentTurn}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
