"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationResume, SourceRecord, TurnRecord } from "@aistudy/contracts";
import { OpeningApiError, createOpeningApi, type OpeningApi } from "../client/api";
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
        hasPending ? "回答任务仍在排队（当前 job 仅 pending，稍后刷新可见）。" : "",
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
  }, []);

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
    if (selectedSourceIds.length === 0) {
      setError("请先指定至少一份已上传材料");
      return;
    }

    let page: number | null | undefined;
    try {
      page = pageForSubmit(currentPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "页码无效");
      return;
    }

    setPending(true);
    try {
      const id = await ensureConversation();
      await api.submitTurn({
        conversationId: id,
        text: input.text,
        sourceIds: selectedSourceIds,
        mode: input.mode,
        clientKey: input.clientKey,
        privacy: "saved",
        ...(page !== undefined ? { currentPage: page } : {}),
      });
      setDraft("");
      await refreshConversation(id);
    } catch (err) {
      if (
        err instanceof OpeningApiError &&
        err.code === "page_not_in_sources" &&
        currentPage.trim() !== ""
      ) {
        setCurrentPage("");
      }
      setError(formatTurnError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-[28rem] flex-col rounded-xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-3 py-2">
        <h1 className="text-base font-semibold text-zinc-900">助理（M1 薄聊天）</h1>
        <p className="text-xs text-zinc-500">上传 → 指定材料 → 提问。不开放敏感记忆。</p>
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
