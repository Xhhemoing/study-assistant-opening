"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { snippetCreateInputSchema, type SnippetCreateInput } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { buttonClass, inputClass, secondaryButtonClass, textareaClass, ui } from "../design/ui";
import { type SnippetDraft, type SnippetSaveResult } from "./save-snippet";
import { readSnippetSaveReceipt, saveSnippetWithReceipt, snippetSaveIdentity, startAnotherSnippetSave, subscribeSnippetSave } from "./snippet-save-receipt";
import { libraryNotePath } from "../editor/library-paths";
import { userFacingMessage } from "../../../lib/user-facing-error";

type Props = { draft: SnippetDraft; api: Pick<OpeningApi, "createSnippet">; onClose: () => void };

export function SaveSnippetDialog({ draft, api, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), descriptionId = useId(), titleId = useId(), textId = useId();
  const identity = `note:${snippetSaveIdentity(draft.input)}`;
  const [recovery] = useState(() => {
    if (typeof window === "undefined") return { receipt: null, blocked: false };
    try { return { receipt: readSnippetSaveReceipt(identity), blocked: false }; }
    catch { return { receipt: null, blocked: true }; }
  });
  const [title, setTitle] = useState(recovery.receipt?.input.title ?? draft.input.title);
  const [text, setText] = useState(recovery.receipt?.input.text ?? draft.input.text);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SnippetSaveResult | null>(recovery.receipt?.status === "saved" ? { kind: "saved", documentId: recovery.receipt.documentId } : recovery.receipt?.status === "unknown" ? { kind: "unknown" } : null);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const update = () => {
      try {
        const receipt = readSnippetSaveReceipt(identity);
        setBusy(receipt?.status === "pending");
        if (receipt?.status === "saved") setResult({ kind: "saved", documentId: receipt.documentId });
        if (receipt?.status === "unknown") setResult({ kind: "unknown" });
      } catch { setStorageError("暂时无法确认是否已保存，先不重复保存。请到笔记列表看一下。"); }
    };
    const unsubscribe = subscribeSnippetSave(identity, update); update(); return unsubscribe;
  }, [identity]);
  const locked = result?.kind === "saved" || result?.kind === "unknown";
  const input: SnippetCreateInput = { ...draft.input, title, text };
  const valid = snippetCreateInputSchema.safeParse(input).success;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  async function confirm() {
    if (busy || locked || recovery.blocked || storageError || !valid) return;
    setBusy(true);
    setResult(null);
    try { setResult(await saveSnippetWithReceipt(identity, input, value => api.createSnippet(value))); }
    catch (reason) { setStorageError(userFacingMessage(reason, "无法保留保存请求，尚未发送。")); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} aria-labelledby={headingId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-line bg-surface p-0 text-text shadow-xl backdrop:bg-ink/30">
    <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id={headingId} className="text-sm font-semibold">保存对话片段</h2>
        <button type="button" className={ui.icon} aria-label="关闭保存片段" disabled={busy} onClick={onClose}><X size={16} aria-hidden /></button>
      </header>
      <div className="space-y-4 px-5 py-4">
        {recovery.blocked || storageError ? <p role="alert" className="text-xs text-warn">{storageError || "暂时无法确认是否已保存，先不重复保存。请到笔记列表看一下。"}</p> : null}
        {draft.notice ? <p role="status" className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-xs leading-6 text-warn">{draft.notice}</p> : null}
        <div id={descriptionId} className="space-y-1 text-xs leading-6 text-text-2">
          <p>保存为关联笔记；原材料的隐私限制继续适用。</p>
          <p>仅保存下方确认的片段，不保存整段对话。修改片段不会解除来源关联；确认前的预览与编辑仅留在当前页面。</p>
        </div>
        {result?.kind === "saved" ? <div role="status" className="space-y-3 rounded-md border border-accent/25 bg-accent-soft p-3 text-sm text-accent">
          <p className="flex items-center gap-2"><Check size={16} aria-hidden />已保存为关联笔记。</p><button type="button" className={secondaryButtonClass} onClick={() => {
            try { startAnotherSnippetSave(identity); setResult(null); }
            catch { setStorageError("无法开始新笔记，请检查浏览器存储后重试。"); }
          }}>另存为新笔记</button>
          <div className="flex flex-wrap gap-2"><Link className={secondaryButtonClass} href={libraryNotePath("/opening/library", result.documentId)}>打开笔记</Link><Link className={secondaryButtonClass} href="/opening/library?tab=notes">查看全部笔记</Link></div>
        </div> : <>
          <div className="space-y-1.5"><label className={ui.label} htmlFor={titleId}>笔记标题</label>
            <input id={titleId} className={inputClass} value={title} maxLength={200} disabled={busy || locked} onChange={(event) => setTitle(event.target.value)} required />
          </div>
          <div className="space-y-1.5"><label className={ui.label} htmlFor={textId}>要保存的片段</label>
            <textarea id={textId} className={`${textareaClass} min-h-48`} value={text} maxLength={20_000} disabled={busy || locked} onChange={(event) => setText(event.target.value)} required />
            <p className="text-xs text-text-3">{text.length.toLocaleString()} / 20,000 字符。可删减或编辑后再确认。</p>
          </div>
          {!valid ? <p className="text-xs leading-5 text-warn">请填写标题和片段；标题最多 200 字符，片段最多 20,000 字符。</p> : null}
        </>}
        {result?.kind === "failed" ? <p role="alert" className="text-xs leading-6 text-danger">保存未完成：{result.message}</p> : null}
        {result?.kind === "unknown" ? <div role="alert" className="space-y-2 rounded-md border border-warn/25 bg-warn-soft p-3 text-xs leading-6 text-warn">
          <p>保存结果尚未确认，可能已经保存。请先到笔记列表核对，避免重复保存；本次不会自动重试。</p>
          <Link className={secondaryButtonClass} href="/opening/library?tab=notes">检查笔记列表</Link>
        </div> : null}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onClose}>{locked ? "关闭" : "取消"}</button>
        {!locked ? <button type="submit" className={buttonClass} disabled={busy || recovery.blocked || Boolean(storageError) || !valid}>{busy ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}{busy ? "正在保存…" : "确认保存为笔记"}</button> : null}
      </footer>
    </form>
  </dialog>;
}
