"use client";

import type { ObservationCardDraft, SnippetCreateInput } from "@aistudy/contracts";
import { Check, LoaderCircle, X } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { OpeningApiError } from "../client/api";
import { buttonClass, secondaryButtonClass, textareaClass, ui } from "../design/ui";
import { createOpeningCardsClient, type OpeningCardsClient } from "./cards-client";
import { isCardDraftPending, readCardDraftReceipt, setCardDraftPending, subscribeCardDraftReceipt, writeCardDraftReceipt } from "./create-card-dialog-draft";
import { readSnippetSaveReceipt, saveSnippetWithReceipt, subscribeSnippetSave } from "../assistant/snippet-save-receipt";
import { createOpeningLearningClient } from "../client/learning-client";
import { userFacingMessage } from "../../../lib/user-facing-error";

export type StudyCardDraft = { identity: string; front: string; back: string; sourceLabel: string; courseId?: string; createSource: () => Promise<string> };

type Props = {
  cards?: OpeningCardsClient;
  onClose: () => void;
} & ({ draft: SnippetCreateInput; api: Pick<OpeningApi, "createSnippet">; initial?: never; studyDraft?: never }
  | { initial: ObservationCardDraft; draft?: never; api?: never; studyDraft?: never }
  | { studyDraft: StudyCardDraft; initial?: never; draft?: never; api?: never });

function suggestSides(text: string): { front: string; back: string } {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    front: firstLine.slice(0, 200) || trimmed.slice(0, 200),
    back: trimmed,
  };
}

export function CreateCardDialog({ draft, initial, studyDraft, api, cards: supplied, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const frontId = useId();
  const backId = useId();
  const courseInputId = useId();
  const skillInputId = useId();
  const identity = initial ? `observation:${initial.observationId}` : studyDraft ? `study:${studyDraft.identity}` : `snippet:${draft.savedTurnId ? `saved:${draft.savedTurnId}` : draft.provenanceId}:${draft.text}`;
  const [recovery] = useState(() => {
    // SSR does not inspect browser receipts. The client reads on its first render.
    if (typeof window === "undefined") return { receipt: null, blocked: false };
    try { return { receipt: readCardDraftReceipt(identity), blocked: false }; }
    catch { return { receipt: null, blocked: true }; }
  });
  const cardIdentity = useRef<{ intent: string; id: string } | null>(recovery.receipt ? {
    intent: JSON.stringify(Object.fromEntries(Object.entries(recovery.receipt.input).filter(([key]) => key !== "cardId"))), id: recovery.receipt.input.cardId,
  } : null);
  const inFlight = useRef(false);
  const cards = useMemo(() => supplied ?? createOpeningCardsClient(), [supplied]);
  const suggested = useMemo(() => initial ?? studyDraft ?? suggestSides(draft?.text ?? ""), [draft?.text, initial, studyDraft]);
  const [reviewKind, setReviewKind] = useState<"question" | "concept">(recovery.receipt?.input.reviewKind ?? (initial ? "question" : "concept"));
  const [front, setFront] = useState(recovery.receipt?.input.front ?? suggested.front);
  const [back, setBack] = useState(recovery.receipt?.input.back ?? suggested.back);
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(recovery.receipt?.input.sourceDocumentId ?? null);
  const [busy, setBusy] = useState(() => isCardDraftPending(identity));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(recovery.receipt?.stage === "card" && recovery.receipt.status === "saved");
  const [sourceUnknown, setSourceUnknown] = useState(recovery.receipt?.stage === "source" && recovery.receipt.status === "unknown");
  const [retryOnly, setRetryOnly] = useState(Boolean(recovery.receipt?.stage === "card" && recovery.receipt.status !== "saved"));
  const sourceIdentity = `card-source:${identity}`;
  const [courseId, setCourseId] = useState(recovery.receipt ? recovery.receipt.input.courseId ?? "" : initial?.courseId ?? studyDraft?.courseId ?? "");
  const [skillLabel, setSkillLabel] = useState(recovery.receipt ? recovery.receipt.input.skillLabel ?? "" : initial?.skillLabel ?? "");
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    let current = true;
    void createOpeningLearningClient().listRevisionCourses().then(
      (items) => { if (current) setCourses(items); },
      () => { if (current) setError("课程列表暂不可用，可保留原课程或不关联课程。"); },
    );
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const update = () => {
      const receipt = readCardDraftReceipt(identity);
      setBusy(isCardDraftPending(identity));
      if (!receipt) return;
      cardIdentity.current = { id: receipt.input.cardId, intent: JSON.stringify(Object.fromEntries(Object.entries(receipt.input).filter(([key]) => key !== "cardId"))) };
      setSourceDocumentId(receipt.input.sourceDocumentId ?? null);
      setSaved(receipt.stage === "card" && receipt.status === "saved");
      setRetryOnly(receipt.stage === "card" && receipt.status !== "saved");
      if (receipt.stage === "source" && receipt.status === "unknown") setSourceUnknown(true);
    };
    const unsubscribe = subscribeCardDraftReceipt(identity, update);
    return unsubscribe;
  }, [identity]);
  useEffect(() => {
    if (!draft) return;
    const update = () => {
      try {
        const receipt = readSnippetSaveReceipt(sourceIdentity);
        setSourceUnknown(receipt?.status === "unknown");
        if (receipt?.status === "pending") setBusy(true);
        if (receipt?.status === "saved") setSourceDocumentId(receipt.documentId);
      } catch { setSourceUnknown(true); setError("暂时无法确认来源笔记是否已保存，请先到笔记列表看一下。"); }
    };
    const unsubscribe = subscribeSnippetSave(sourceIdentity, update); update(); return unsubscribe;
  }, [sourceIdentity, draft]);

  const valid = front.trim().length > 0 && back.trim().length > 0;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  async function submit() {
    if (inFlight.current || isCardDraftPending(identity) || saved || sourceUnknown || recovery.blocked || !valid) return;
    inFlight.current = true;
    setCardDraftPending(identity, true);
    setBusy(true);
    setError("");
    try {
      let documentId = sourceDocumentId;
      if (!documentId && (draft || studyDraft)) {
        cardIdentity.current ??= { id: crypto.randomUUID(), intent: "" };
        writeCardDraftReceipt(identity, { input: { reviewKind, front: front.trim(), back: back.trim(), sourceDocumentId: null,
          courseId: courseId || null, skillLabel: skillLabel.trim() || null, cardId: cardIdentity.current.id }, stage: "source", status: "pending" });
      }
      if (!documentId && draft && api) {
        const snippet = await saveSnippetWithReceipt(sourceIdentity, draft, input => api.createSnippet(input));
        if (!snippet || snippet.kind !== "saved") {
          if (snippet?.kind === "unknown") {
            setSourceUnknown(true);
            const captured = readCardDraftReceipt(identity);
            if (captured) writeCardDraftReceipt(identity, { ...captured, status: "unknown" });
          } else {
            const captured = readCardDraftReceipt(identity);
            if (captured) writeCardDraftReceipt(identity, { ...captured, status: "editing" });
          }
          throw new Error(snippet?.kind === "failed" ? snippet.message : "来源笔记的保存结果尚未确认，请先检查笔记列表。本次草稿已保留，未继续创建卡片。");
        }
        documentId = snippet.documentId;
        setSourceDocumentId(documentId);
      }
      if (!documentId && studyDraft) { documentId = await studyDraft.createSource(); setSourceDocumentId(documentId); }
      if (documentId) {
        const captured = readCardDraftReceipt(identity);
        if (captured?.stage === "source") writeCardDraftReceipt(identity, { ...captured, input: { ...captured.input, sourceDocumentId: documentId }, status: "saved" });
      }
      const input = { reviewKind, front: front.trim(), back: back.trim(), sourceDocumentId: documentId,
        courseId: courseId || null, skillLabel: skillLabel.trim() || null,
        ...(initial ? { observationId: initial.observationId } : {}) };
      const intent = JSON.stringify(input);
      if (!cardIdentity.current || (!retryOnly && cardIdentity.current.intent !== intent)) cardIdentity.current = { intent, id: crypto.randomUUID() };
      const captured = { ...input, cardId: cardIdentity.current.id };
      writeCardDraftReceipt(identity, { input: captured, stage: "card", status: "pending" });
      try { await cards.createCard(captured); }
      catch (reason) {
        // A lost response may already have created this exact card. Keep the
        // visible intent fixed and reuse its server-supported identity.
        const unknown = !(reason instanceof OpeningApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408);
        setRetryOnly(unknown);
        if (unknown) writeCardDraftReceipt(identity, { input: captured, stage: "card", status: "unknown" });
        else writeCardDraftReceipt(identity, { input: captured, stage: "source", status: "editing" });
        throw reason;
      }
      setSaved(true);
      try { writeCardDraftReceipt(identity, { input: captured, stage: "card", status: "saved" }); }
      catch { /* The persisted pending receipt still retains this same server identity. */ }
    } catch (err) {
      if (err instanceof OpeningApiError) {
        setError(err.message);
      } else {
        setError(userFacingMessage(err, "制成卡片失败，请重试。"));
      }
    } finally {
      inFlight.current = false;
      setCardDraftPending(identity, false);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-line bg-surface p-0 text-text shadow-xl backdrop:bg-ink/30"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 id={headingId} className="text-sm font-semibold">
            制成记忆卡片
          </h2>
          <button
            type="button"
            className={ui.icon}
            aria-label="关闭制成卡片"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="space-y-4 px-5 py-4">
          <div id={descriptionId} className="space-y-1 text-xs leading-6 text-text-2">
            <p>{draft || studyDraft ? "编辑正反面后加入卡组；确认时保存关联来源笔记。" : "题干与参考内容已预填，请核对并编辑后再创建；背面为空时请补充参考答案。"}</p>
            <p>定义与术语用卡片回忆，题目会换一道新变式来复习。</p>
          </div>
          <p className="text-xs leading-6 text-text-2">来源：{studyDraft?.sourceLabel || draft?.title || "当前作答记录"} · 默认卡组：记忆卡片</p>
          {recovery.blocked ? <p role="alert" className="text-xs leading-6 text-warn">暂时无法确认卡片是否已保存，先不重复保存。草稿可以复制，请到卡组看一下。</p> : null}
          {sourceUnknown ? <p role="alert" className="text-xs leading-6 text-warn">来源笔记的保存结果尚未确认，可能已经保存。请先检查笔记列表；本次不会再创建来源或卡片。</p> : null}
          {retryOnly ? <p role="status" className="text-xs leading-6 text-warn">保存结果尚未确认。草稿内容已锁定，重试会核对同一张卡片，不会另建一张。</p> : null}
          {saved ? (
            <div
              role="status"
              className="space-y-2 rounded-md border border-accent/30 bg-accent-soft p-3 text-sm text-accent"
            >
              <p className="flex items-center gap-2">
                <Check size={16} aria-hidden />
                已制成记忆卡片。
              </p>
              <p className="text-xs leading-6">可到记忆卡片页复习到期队列。</p>
            </div>
          ) : (
            <>
              <label className="block space-y-1.5 text-sm">复习方式
                <select className={textareaClass} value={reviewKind} disabled={busy || retryOnly || sourceUnknown || Boolean(initial)} onChange={event => setReviewKind(event.target.value as "question" | "concept")}>
                  <option value="concept">定义或术语：翻卡回忆</option><option value="question">题目：做新变式</option>
                </select>
              </label>
              <div className="space-y-1.5">
                <label className={ui.label} htmlFor={frontId}>
                  正面
                </label>
                <textarea
                  id={frontId}
                  className={`${textareaClass} min-h-24`}
                  value={front}
                  maxLength={4000}
                  disabled={busy || retryOnly || sourceUnknown}
                  onChange={(event) => setFront(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className={ui.label} htmlFor={backId}>
                  背面
                </label>
                <textarea
                  id={backId}
                  className={`${textareaClass} min-h-32`}
                  value={back}
                  maxLength={4000}
                  disabled={busy || retryOnly || sourceUnknown}
                  onChange={(event) => setBack(event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className={ui.label} htmlFor={courseInputId}>所属课程（可选）</label>
                  <select id={courseInputId} className={textareaClass} value={courseId} disabled={busy || retryOnly || sourceUnknown} onChange={(event) => setCourseId(event.target.value)}>
                    <option value="">不关联课程</option>
                    {courseId && !courses.some((course) => course.id === courseId) ? <option value={courseId}>原所属课程</option> : null}
                    {courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className={ui.label} htmlFor={skillInputId}>知识点（可选）</label>
                  <input id={skillInputId} className={textareaClass} value={skillLabel} maxLength={200} disabled={busy || retryOnly || sourceUnknown} onChange={(event) => setSkillLabel(event.target.value)} />
                </div>
              </div>
              {!valid ? (
                <p className="text-xs leading-5 text-warn">正反面都不能为空。</p>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-xs leading-6 text-danger">
              制成卡片未完成：{error}
            </p>
          ) : null}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onClose}>
            {saved ? "关闭" : "取消"}
          </button>
          {!saved ? (
            <button type="submit" className={buttonClass} disabled={busy || sourceUnknown || recovery.blocked || !valid}>
              {busy ? (
                <LoaderCircle
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {busy ? "正在保存…" : retryOnly ? "重试加入同一卡片" : "加入卡组"}
            </button>
          ) : (
            <Link href="/opening/cards" className={buttonClass}>
              去复习
            </Link>
          )}
        </footer>
      </form>
    </dialog>
  );
}
