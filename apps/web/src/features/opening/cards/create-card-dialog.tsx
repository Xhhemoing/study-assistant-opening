"use client";

import type { SnippetCreateInput } from "@aistudy/contracts";
import { Check, LoaderCircle, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { OpeningApiError } from "../client/api";
import { buttonClass, secondaryButtonClass, textareaClass, ui } from "../design/ui";
import { createOpeningCardsClient, type OpeningCardsClient } from "./cards-client";

type Props = {
  draft: SnippetCreateInput;
  api: Pick<OpeningApi, "createSnippet">;
  cards?: OpeningCardsClient;
  onClose: () => void;
};

function suggestSides(text: string): { front: string; back: string } {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    front: firstLine.slice(0, 200) || trimmed.slice(0, 200),
    back: trimmed,
  };
}

export function CreateCardDialog({ draft, api, cards: supplied, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const frontId = useId();
  const backId = useId();
  const cards = useMemo(() => supplied ?? createOpeningCardsClient(), [supplied]);
  const suggested = useMemo(() => suggestSides(draft.text), [draft.text]);
  const [front, setFront] = useState(suggested.front);
  const [back, setBack] = useState(suggested.back);
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

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
    if (busy || saved || !valid) return;
    setBusy(true);
    setError("");
    try {
      let documentId = sourceDocumentId;
      if (!documentId) {
        const snippet = await api.createSnippet({
          title: draft.title,
          text: draft.text,
          provenanceId: draft.provenanceId,
        });
        documentId = snippet.documentId;
        setSourceDocumentId(documentId);
      }
      await cards.createCard({
        front: front.trim(),
        back: back.trim(),
        sourceDocumentId: documentId,
      });
      setSaved(true);
    } catch (err) {
      if (err instanceof OpeningApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "制成卡片失败，请重试。");
      }
    } finally {
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
            <p>先把当前回答存为关联笔记，再编辑正反面制成记忆卡片。</p>
            <p>记忆卡片与补测分开；评分只影响复习调度，不写入学习观察或证据。</p>
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
