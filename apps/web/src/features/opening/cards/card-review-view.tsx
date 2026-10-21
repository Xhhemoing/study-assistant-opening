"use client";

import type { GradeReviewResponse, ReviewGrade, ReviewQueueItem } from "@aistudy/contracts";
import { Check, CircleHelp, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LearnerStateCard } from "../teaching/learner-state-card";
import { studyConversationHref } from "../assistant/study-conversation-context";
import { OpeningApiError } from "../client/api";
import { EmptyState, LoadError, LoadingRows, PageHeader, secondaryButtonClass, ui } from "../design/ui";
import { interactionMotionReduced, successfulInteractionHaptic } from "../design/haptics";
import { CardStack } from "./card-stack";
import {
  createOpeningCardsClient,
  resolveCardGradeIdentity,
  type CardGradeIdentity,
  type OpeningCardsClient,
} from "./cards-client";

const gradeOptions: Array<{ grade: ReviewGrade; label: string; icon: typeof Check }> = [
  { grade: "again", label: "重来", icon: RotateCcw },
  { grade: "hard", label: "困难", icon: CircleHelp },
  { grade: "good", label: "记得", icon: Check },
  { grade: "easy", label: "轻松", icon: Sparkles },
];

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; items: ReviewQueueItem[]; index: number; flipped: boolean }
  | { kind: "error"; message: string }
  | { kind: "loggedOut" };

/** The SRS review always saves; say so when it could not also become a learning fact. */
export function cardEvidenceNotice(evidence: GradeReviewResponse["evidence"]): string {
  if (evidence === "skipped_course_archived") return "上一张的复习已保存，但所属课程已归档，没有计入学习记录。";
  if (evidence === "skipped_source_unavailable") return "上一张的复习已保存，但关联材料暂不可用（已删除、排除或正在重新解析），没有计入学习记录。";
  return "";
}

export function advanceGradedCard(state: ReadState, cardId: string, queueRequest: number, activeQueueRequest: number): ReadState {
  if (state.kind !== "ready" || queueRequest !== activeQueueRequest || state.items[state.index]?.card.id !== cardId) return state;
  return { ...state, index: state.index + 1, flipped: false };
}

export function CardReviewView({ client: supplied, embedded = false, compact = false, onRemainingChange, onGraded, onBusyChange, returnTo = "/opening/review?tab=cards" }: { client?: OpeningCardsClient; embedded?: boolean; compact?: boolean; onRemainingChange?: (remaining: number | null) => void; onGraded?: (cardId: string, result: GradeReviewResponse) => void; onBusyChange?: (busy: boolean) => void; returnTo?: string }) {
  const client = useMemo(() => supplied ?? createOpeningCardsClient(), [supplied]);
  const [state, setState] = useState<ReadState>({ kind: "loading" });
  const [grading, setGrading] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [gradeError, setGradeError] = useState("");
  const [evidenceNotice, setEvidenceNotice] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const gradeIdentity = useRef<CardGradeIdentity | null>(null);
  const gradeInFlight = useRef(false);
  // Guards against a late response from a superseded load overwriting newer state.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setState({ kind: "loading" });
    setGradeError("");
    gradeIdentity.current = null;
    try {
      const items = await client.listDue("auto");
      if (request !== requestId.current) return;
      setState({ kind: "ready", items, index: 0, flipped: false });
    } catch (error) {
      if (request !== requestId.current) return;
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
    return () => { requestId.current++; };
  }, [refresh, retryToken]);

  const current = state.kind === "ready" ? state.items[state.index] ?? null : null;
  useEffect(() => {
    onRemainingChange?.(state.kind === "ready" ? Math.max(0, state.items.length - state.index) : null);
  }, [onRemainingChange, state]);

  const gradeCard = useCallback(async (grade: ReviewGrade) => {
    if (state.kind !== "ready" || !current || !state.flipped || grading || gradeInFlight.current) return;
    gradeInFlight.current = true;
    const queueRequest = requestId.current;
    setGrading(true);
    onBusyChange?.(true);
    setGradeError("");
    setEvidenceNotice("");
    const identity = resolveCardGradeIdentity(
      gradeIdentity.current,
      current.card.id,
      grade,
      createIdempotencyKey,
    );
    gradeIdentity.current = identity;
    try {
      const result = await client.grade({
        cardId: current.card.id,
        grade,
        idempotencyKey: identity.key,
      });
      if (queueRequest !== requestId.current) return;
      successfulInteractionHaptic();
      setEvidenceNotice(cardEvidenceNotice(result.evidence));
      gradeIdentity.current = null;
      if (!interactionMotionReduced()) {
        setExiting(true);
        await new Promise<void>(resolve => window.setTimeout(resolve, 200));
        if (queueRequest !== requestId.current) return;
      }
      setState((currentState) => advanceGradedCard(currentState, current.card.id, queueRequest, requestId.current));
      onGraded?.(current.card.id, result);
    } catch (error) {
      if (queueRequest !== requestId.current) return;
      setGradeError(
        error instanceof Error ? error.message : "评分保存失败，请保持当前卡片并重试。",
      );
    } finally {
      gradeInFlight.current = false;
      setExiting(false);
      setGrading(false);
      onBusyChange?.(false);
    }
  }, [client, current, grading, state, onGraded, onBusyChange]);

  const headerActions = <div className="flex flex-wrap gap-2">
    {state.kind !== "loggedOut" && state.kind !== "loading" ? <button type="button" className={secondaryButtonClass} disabled={grading} onClick={() => setRetryToken(value => value + 1)}><RefreshCw size={14} aria-hidden />重新读取</button> : null}
    {!embedded ? <Link href="/opening/today" className={secondaryButtonClass}>返回今天</Link> : null}
  </div>;

  return (
    <section aria-label={compact ? "当前记忆卡片" : undefined} className={embedded ? compact ? "space-y-3" : "space-y-5" : "flex h-full min-h-0 w-full flex-col bg-bg"}>
      {embedded ? !compact ? <header className="space-y-1"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">记忆卡片</h2>{headerActions}</div><p className="text-xs leading-5 text-text-2">翻面后自评，不作为独立正确的证明。</p></header> : null : <PageHeader
        title="记忆卡片"
        description="复习你制成的卡片。关联课程的评分按自报写入学习记录，不作为独立正确的证明；未关联课程只安排复习。"
        action={headerActions}
      />}
      <div className={embedded ? "space-y-4" : "min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7"}>
        {state.kind === "loading" ? <LoadingRows label="正在读取到期记忆卡片…" /> : null}
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
              <Link href="/opening/assistant" className={ui.primary}>
                去助理制成卡片
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
          <div className={`mx-auto flex w-full max-w-3xl flex-col ${compact ? "gap-2" : "gap-5"}`}>
            <progress value={state.index} max={state.items.length} aria-label="本组卡片已完成" className="h-[3px] w-full overflow-hidden rounded-full border-0 bg-surface-2 text-accent [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent" />
            <div className="flex items-end justify-between gap-3">
              <p className="text-xs text-text-3">正面 → 揭示 → 四档评分</p>
              <span className="text-sm tabular-nums text-text-3">
                第 {Math.min(state.index + 1, state.items.length)}/{state.items.length} 张
              </span>
            </div>
            {grading ? <p role="status" className="text-xs text-text-2">正在保存评分…</p> : null}
            {gradeError ? (
              <p className="text-sm text-danger" role="alert">
                {gradeError}
              </p>
            ) : null}
            {evidenceNotice ? (
              <p className="text-xs leading-6 text-warn" role="status">
                {evidenceNotice}
              </p>
            ) : null}
            <CardStack front={current.card.front} back={current.card.back} flipped={state.flipped} disabled={grading} remaining={state.items.length - state.index} exiting={exiting} entering={state.index > 0}
              onFlip={() => setState(currentState => currentState.kind === "ready" ? { ...currentState, flipped: !currentState.flipped } : currentState)}
              onGrade={gradeCard} />
            <Link className={ui.quiet} href={studyConversationHref({ courseId: current.card.courseId ?? undefined, purpose: "card_answer", label: current.card.skillLabel ?? "当前记忆卡片", fragment: `${current.card.front}${state.flipped ? `\n参考内容：${current.card.back}` : ""}`.slice(0, 4000), returnTo })}>围绕这张卡片提问</Link>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {gradeOptions.map(({ grade, label, icon: Icon }) => (
                <button
                  key={grade}
                  type="button"
                  className={ui.secondary}
                  disabled={!state.flipped || grading}
                  onClick={() => void gradeCard(grade)}
                >
                  <Icon size={16} aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {state.kind === "ready" && !compact ? <details className="mx-auto max-w-3xl text-xs text-text-2"><summary className="cursor-pointer py-2">评分如何计入学习记录</summary><p className="py-2 leading-5">关联课程的评分按自报写入学习记录，不作为独立正确的证明；未关联课程只安排复习。</p><LearnerStateCard courseId={current?.card.courseId ?? undefined} revision={state.index} /></details> : null}
      </div>
    </section>
  );
}
