"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationResume, SourceRecord, TurnRecord } from "@aistudy/contracts";
import { OpeningApiError, createOpeningApi, type JobStatusResponse, type OpeningApi } from "../client/api";
import { Composer, type ComposerSubmit } from "./composer";
import { MessageList } from "./message-list";
import { resolveChatMessages } from "./message-model";
import { SourcePageControls } from "./source-page-controls";
import { formatTurnError, pageForSubmit } from "./turn-errors";
import { UploadStrip } from "./upload-strip";

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

export function assistantContextHint(selectedSourceIds: string[]): string {
  return selectedSourceIds.length === 0
    ? "自由交流"
    : `已选材料：${selectedSourceIds.length} 份`;
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
      const hasPending = nextTurns.some((t) => t.status === "pending");
      setPendingHint(
        hasPending
          ? "存在尚未完成的回答轮次；当前 DTO 未提供其 job 关联，暂不自动轮询。"
          : "",
      );
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

  const display = useMemo(
    () => resolveChatMessages({ resume, turns }),
    [resume, turns],
  );

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const created = await api.createConversation({
      title: "学习对话",
      courseId: null,
    });
    setConversationId(created.id);
    return created.id;
  }

  async function handleSubmit(input: ComposerSubmit) {
    setError("");
    let page: number | null | undefined;
    try {
      page = pageForSubmit(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "页码无效");
      return;
    }

    setPending(true);
    let jobSubmitted = false;
    try {
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
      setDraft("");
      await refreshConversation(id);
    } catch (err) {
      if (!jobSubmitted) setPending(false);
      if (
        err instanceof OpeningApiError &&
        err.code === "page_not_in_sources" &&
        currentPage.trim() !== ""
      ) {
        setCurrentPage("");
      }
      setError(formatTurnError(err));
    }
  }

  return (
    <div className="flex h-full min-h-[28rem] flex-col rounded-xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-3 py-2">
        <h1 className="text-base font-semibold text-zinc-900">助理（M1 薄聊天）</h1>
        <p className="text-xs text-zinc-500">
          {assistantContextHint(selectedSourceIds)}。不开放敏感记忆。
        </p>
      </header>
      <UploadStrip api={api} onUploaded={refreshSources} disabled={pending} />
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
        onDraftChange={setDraft}
        pending={pending}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
