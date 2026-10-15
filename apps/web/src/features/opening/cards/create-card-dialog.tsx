"use client";

import type { ObservationCardDraft, SnippetCreateInput } from "@aistudy/contracts";
import { Check, LoaderCircle, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { OpeningApiError } from "../client/api";
import { buttonClass, secondaryButtonClass, textareaClass, ui } from "../design/ui";
import { createOpeningCardsClient, type OpeningCardsClient } from "./cards-client";
import { createOpeningLearningClient } from "../client/learning-client";

type Props = {
  cards?: OpeningCardsClient;
  onClose: () => void;
} & ({ draft: SnippetCreateInput; api: Pick<OpeningApi, "createSnippet">; initial?: never }
  | { initial: ObservationCardDraft; draft?: never; api?: never });

function suggestSides(text: string): { front: string; back: string } {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    front: firstLine.slice(0, 200) || trimmed.slice(0, 200),
    back: trimmed,
  };
}

export function CreateCardDialog({ draft, initial, api, cards: supplied, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const frontId = useId();
  const backId = useId();
  const courseInputId = useId();
  const skillInputId = useId();
  const cardIdentity = useRef<{ intent: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const cards = useMemo(() => supplied ?? createOpeningCardsClient(), [supplied]);
  const suggested = useMemo(() => initial ?? suggestSides(draft?.text ?? ""), [draft?.text, initial]);
  const [front, setFront] = useState(suggested.front);
  const [back, setBack] = useState(suggested.back);
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [courseId, setCourseId] = useState(initial?.courseId ?? "");
  const [skillLabel, setSkillLabel] = useState(initial?.skillLabel ?? "");
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    let current = true;
    void createOpeningLearningClient().listRevisionCourses().then(
      (items) => { if (current) setCourses(items); },
      () => { if (current) setError("课程列表暂不可用，可保留原课程或不关联课程。"); },
    );
    return () => { current = false; };
  }, []);

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
    if (inFlight.current || saved || !valid) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let documentId = sourceDocumentId;
      if (!documentId && draft && api) {
        const snippet = await api.createSnippet({
          title: draft.title,
          text: draft.text,
          provenanceId: draft.provenanceId,
        });
        documentId = snippet.documentId;
        setSourceDocumentId(documentId);
      }
      const input = { front: front.trim(), back: back.trim(), sourceDocumentId: documentId,
        courseId: courseId || null, skillLabel: skillLabel.trim() || null,
        ...(initial ? { observationId: initial.observationId } : {}) };
      const intent = JSON.stringify(input);
      if (cardIdentity.current?.intent !== intent) cardIdentity.current = { intent, id: crypto.randomUUID() };
      await cards.createCard({ ...input, cardId: cardIdentity.current.id });
      setSaved(true);
    } catch (err) {
      if (err instanceof OpeningApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "制成卡片失败，请重试。");
      }
    } finally {
      inFlight.current = false;
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
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-zinc-200 bg-white p-0 text-zinc-800 shadow-xl backdrop:bg-zinc-950/30"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
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
          <div id={descriptionId} className="space-y-1 text-xs leading-6 text-zinc-600">
            <p>{draft ? "先把当前回答存为关联笔记，再编辑正反面制成记忆卡片。" : "题干与参考内容已预填，请核对并编辑后再创建；背面为空时请补充参考答案。"}</p>
            <p>关联课程的复习会记入学习记录，结果按自报保存，不作为独立正确的证明；未关联课程只安排复习。</p>
          </div>
          {saved ? (
            <div
              role="status"
              className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
            >
              <p className="flex items-center gap-2">
                <Check size={16} aria-hidden />
                已制成记忆卡片。
              </p>
              <p className="text-xs leading-6">可到记忆卡片页复习到期队列。</p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className={ui.label} htmlFor={frontId}>
                  正面
                </label>
                <textarea
                  id={frontId}
                  className={`${textareaClass} min-h-24`}
                  value={front}
                  maxLength={4000}
                  disabled={busy}
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
                  disabled={busy}
                  onChange={(event) => setBack(event.target.value)}
                  required
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className={ui.label} htmlFor={courseInputId}>所属课程（可选）</label>
                  <select id={courseInputId} className={textareaClass} value={courseId} disabled={busy} onChange={(event) => setCourseId(event.target.value)}>
                    <option value="">不关联课程</option>
                    {initial?.courseId && !courses.some((course) => course.id === initial.courseId) ? <option value={initial.courseId}>原所属课程</option> : null}
                    {courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className={ui.label} htmlFor={skillInputId}>知识点（可选）</label>
                  <input id={skillInputId} className={textareaClass} value={skillLabel} maxLength={200} disabled={busy} onChange={(event) => setSkillLabel(event.target.value)} />
                </div>
              </div>
              {!valid ? (
                <p className="text-xs leading-5 text-amber-800">正反面都不能为空。</p>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-xs leading-6 text-red-700">
              制成卡片未完成：{error}
            </p>
          ) : null}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onClose}>
            {saved ? "关闭" : "取消"}
          </button>
          {!saved ? (
            <button type="submit" className={buttonClass} disabled={busy || !valid}>
              {busy ? (
                <LoaderCircle
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {busy ? "正在保存…" : "确认制成卡片"}
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
