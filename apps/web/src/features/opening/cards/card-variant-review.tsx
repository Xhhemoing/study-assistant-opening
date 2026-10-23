"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CardVariantReview as Variant, GradeReviewResponse, LearningObservation } from "@aistudy/contracts";
import { LearningProse } from "../assistant/learning-prose";
import { InlineAttempt } from "../teaching/inline-attempt";
import { ui } from "../design/ui";
import type { OpeningCardsClient } from "./cards-client";

export function CardVariantReview({ cardId, client, onComplete, onBusyChange }: {
  cardId: string; client: OpeningCardsClient; onComplete(result: GradeReviewResponse): void; onBusyChange?(busy: boolean): void;
}) {
  const [review, setReview] = useState<Variant | null>(null);
  const [observation, setObservation] = useState<LearningObservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true), inFlight = useRef(false);
  const load = useCallback(async (retry = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { const value = await client.startVariant(cardId, retry); if (active.current) setReview(value); }
    catch { if (active.current) setError("题目还没准备好，请再试一次。"); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }, [cardId, client]);
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, [load]);
  useEffect(() => {
    if (!review || !["generating", "queued"].includes(review.activity.generateStatus)) return;
    const timer = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(timer);
  }, [review, load]);
  const block = review?.clientInit?.blocks.find(block => block.role === "prompt");
  const content = block?.content && typeof block.content === "object" ? block.content as Record<string, unknown> : {};
  const accepted = observation && ["correct", "incorrect"].includes(observation.outcome)
    && ["ai_graded", "deterministic"].includes(observation.verdictSource);
  async function finish() {
    if (!accepted || !observation || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); onBusyChange?.(true);
    try { const result = await client.completeVariant(cardId, observation.id); if (active.current) onComplete(result); }
    catch { if (active.current) setError("复习还没保存好。请确认批改已经完成，再试一次。"); }
    finally { inFlight.current = false; if (active.current) setBusy(false); onBusyChange?.(false); }
  }
  return <section className="space-y-4" aria-label="变式复习">
    <p className="text-sm text-text-2">换一道题试试同一个知识点。卡住时可以看提示。</p>
    {review?.activity.generateStatus === "ready" && block ? <>
      <LearningProse text={String(content.text ?? "")} />
      <InlineAttempt key={review.activity.id} blockId={block.blockId} prompt={String(content.text ?? "")} context={{
        ...review.activity, questionSkillLabel: String(content.skillLabel ?? "题目复习"),
        onCourseAssociated: activity => setReview(value => value ? { ...value, activity } : value),
        onObservationReady: (_blockId, value) => setObservation(value),
      }} />
      <button type="button" className={ui.primary} disabled={!accepted || busy} onClick={() => void finish()}>
        {busy ? "正在保存…" : "完成复习，继续下一张"}
      </button>
      {observation && !accepted ? <p role="status" className="text-xs text-text-2">批改完成后就能继续；也可以稍后回来接着做。</p> : null}
    </> : <>
      <p role="status" className="text-sm text-text-2">{busy || review && ["generating", "queued"].includes(review.activity.generateStatus)
        ? "正在准备一道新题…" : review?.activity.generateStatus === "failed" ? "题目还没准备好，请检查模型设置后再试一次。" : "题目尚未准备完成，请稍后查看。"}</p>
      <button type="button" className={ui.secondary} disabled={busy} onClick={() => void load(review?.activity.generateStatus === "failed")}>再试一次</button>
    </>}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </section>;
}
