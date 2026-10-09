"use client";

import type { ReviewGrade, ReviewQueueItem } from "@aistudy/contracts";
import { Check, CircleHelp, Eye, LoaderCircle, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpeningApiError } from "../client/api";
import { EmptyState, LoadError, PageHeader, secondaryButtonClass, ui } from "../design/ui";
import {
  createOpeningCardsClient,
  resolveCardGradeIdentity,
  type CardGradeIdentity,
  type OpeningCardsClient,
} from "./cards-client";

const gradeOptions: Array<{ grade: ReviewGrade; label: string; icon: typeof Check }> = [
  { grade: "again", label: "忘记", icon: RotateCcw },
  { grade: "hard", label: "困难", icon: CircleHelp },
  { grade: "good", label: "良好", icon: Check },
  { grade: "easy", label: "简单", icon: Sparkles },
];

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; items: ReviewQueueItem[]; index: number; flipped: boolean }
  | { kind: "error"; message: string }
  | { kind: "loggedOut" };

export function CardReviewView({ client: supplied }: { client?: OpeningCardsClient }) {
  const client = useMemo(() => supplied ?? createOpeningCardsClient(), [supplied]);
  const [state, setState] = useState<ReadState>({ kind: "loading" });
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const gradeIdentity = useRef<CardGradeIdentity | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    setGradeError("");
    gradeIdentity.current = null;
    try {
      const items = await client.listDue("auto");
      setState({ kind: "ready", items, index: 0, flipped: false });
    } catch (error) {
      if (error instanceof OpeningApiError && error.status === 401) {
        setState({ kind: "loggedOut" });
        return;
      }
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "暂时无法读取记忆卡片",
      });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, retryToken]);

  const current = state.kind === "ready" ? state.items[state.index] ?? null : null;

  const gradeCard = useCallback(async (grade: ReviewGrade) => {
    if (state.kind !== "ready" || !current || !state.flipped || grading) return;
    setGrading(true);
    setGradeError("");
    const identity = resolveCardGradeIdentity(
      gradeIdentity.current,
      current.card.id,
      grade,
      createIdempotencyKey,
    );
    gradeIdentity.current = identity;
    try {
      await client.grade({
        cardId: current.card.id,
        grade,
        idempotencyKey: identity.key,
      });
      gradeIdentity.current = null;
      setState((currentState) => {
        if (currentState.kind !== "ready") return currentState;
        return {
          ...currentState,
          index: currentState.index + 1,
          flipped: false,
        };
      });
    } catch (error) {
      setGradeError(
        error instanceof Error ? error.message : "评分保存失败，请保持当前卡片并重试。",
      );
    } finally {
      setGrading(false);
    }
  }, [client, current, grading, state]);

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-white">
      <PageHeader
        title="记忆卡片"
        description="复习你从材料或辅导回答制成的卡片。评分只影响记忆调度，不会写入补测或学习证据。"
        action={
          <div className="flex flex-wrap gap-2">
            {state.kind !== "loggedOut" && state.kind !== "loading" ? (
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => setRetryToken((value) => value + 1)}
              >
                <RefreshCw size={14} aria-hidden />
                重新读取
              </button>
            ) : null}
            <Link href="/opening/today" className={secondaryButtonClass}>
              返回今天
            </Link>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        {state.kind === "loading" ? (
          <p role="status" className="text-sm text-zinc-600">
            正在读取到期记忆卡片…
          </p>
        ) : null}
        {state.kind === "loggedOut" ? (
          <>
            <EmptyState title="尚未登录" description="登录后查看属于你的记忆卡片。" />
            <Link href="/login" className={secondaryButtonClass}>
              去登录
            </Link>
          </>
        ) : null}
        {state.kind === "error" ? (
          <LoadError
            message={`记忆卡片暂时无法读取：${state.message}`}
            onRetry={() => setRetryToken((value) => value + 1)}
          />
        ) : null}
        {state.kind === "ready" && state.items.length === 0 ? (
          <EmptyState
            title="今天没有到期的记忆卡片"
            description="可在辅导回答中用「制成卡片」把材料沉淀为记忆卡；到期后会出现在这里。"
            action={
              <Link href="/opening/today" className={secondaryButtonClass}>
                返回今天
              </Link>
            }
          />
        ) : null}
        {state.kind === "ready" && state.items.length > 0 && state.index >= state.items.length ? (
          <EmptyState
            title="这组记忆卡片已经处理完毕"
            description={`本次完成 ${state.items.length} 张。评分已写入服务端调度，不会进入补测队列。`}
            action={
              <Link href="/opening/today" className={secondaryButtonClass}>
                返回今天
              </Link>
            }
          />
        ) : null}
        {state.kind === "ready" && current ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            <div className="flex items-end justify-between gap-3">
              <p className="text-xs text-zinc-500">正面 → 揭示 → 四档评分</p>
              <span className="text-sm tabular-nums text-zinc-500">
                第 {Math.min(state.index + 1, state.items.length)}/{state.items.length} 张
              </span>
            </div>
            {gradeError ? (
              <p className="text-sm text-red-700" role="alert">
                {gradeError}
              </p>
            ) : null}
            <button
              type="button"
              aria-label={state.flipped ? "显示卡片正面" : "显示卡片背面"}
              aria-pressed={state.flipped}
              className="grid min-h-[18rem] gap-4 rounded-xl border border-zinc-200 bg-white p-6 text-left shadow-xs transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              onClick={() =>
                setState((currentState) =>
                  currentState.kind === "ready"
                    ? { ...currentState, flipped: !currentState.flipped }
                    : currentState,
                )
              }
            >
              <span className="text-xs font-semibold text-emerald-700">
                {state.flipped ? "背面" : "正面"}
              </span>
              <span className="self-center whitespace-pre-wrap text-sm font-medium leading-7 text-zinc-900">
                {state.flipped ? current.card.back : current.card.front}
              </span>
              <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
                {state.flipped ? <RotateCcw size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                {state.flipped ? "查看正面" : "显示背面"}
              </span>
            </button>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {gradeOptions.map(({ grade, label, icon: Icon }) => (
                <button
                  key={grade}
                  type="button"
                  className={ui.secondary}
                  disabled={!state.flipped || grading}
                  onClick={() => void gradeCard(grade)}
                >
                  {grading && state.flipped ? (
                    <LoaderCircle
                      size={16}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <Icon size={16} aria-hidden />
                  )}
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
