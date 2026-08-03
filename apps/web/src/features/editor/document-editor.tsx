"use client";

import { zh } from "@blocknote/core/locales";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import { ArrowLeft, Check, Clock3, Redo2, RefreshCw, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createEditorApi, type EditorDocument } from "./editor-api";
import { BacklinksPanel } from "./backlinks-panel";
import { documentToDraft, draftToApiBlocks, revisionToApiBlocks } from "./document-editor-model";
import {
  draftBlocksToEditorBlocks,
  editorBlocksToDraftBlocks,
  loadLocalDraft,
  saveLocalDraft,
  type LocalNoteDraft,
} from "./local-draft";
import { VersionHistoryDrawer } from "./version-history-drawer";
import type { EditorRevision } from "./version-history";
import { useStudyProvider } from "../../lib/data/react";
import { PropertiesPanel } from "./properties-panel";
import { extractWikiLinks } from "./link-utils";

type SaveState = "saved" | "unsaved" | "saving" | "error";

export function DocumentEditor({ documentId }: { documentId: string }) {
  const api = useMemo(() => createEditorApi(), []);
  const provider = useStudyProvider();
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraft] = useState<LocalNoteDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saving");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError("");
    api.fetchDocument(documentId)
      .then((nextDocument) => {
        if (!active) return;
        const local = loadLocalDraft(documentId);
        const serverTime = Date.parse(nextDocument.updatedAt ?? "");
        const localTime = Date.parse(local?.updatedAt ?? "");
        const usableLocal = local && (!serverTime || localTime > serverTime) ? local : null;
        setDocument(nextDocument);
        setDraft(usableLocal ?? documentToDraft(nextDocument));
        setSaveState(usableLocal ? "unsaved" : "saved");
      })
      .catch(() => {
        if (active) setLoadError("暂时无法读取这篇笔记，请稍后重试。");
      });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  const initialContent = useMemo(
    () => (draft ? draftBlocksToEditorBlocks(draft.blocks) : undefined),
    [draft?.draftId],
  );
  const editor = useCreateBlockNote(
    { dictionary: zh, initialContent, defaultStyles: true },
    [draft?.draftId],
  );

  function updateSafetyCopy(nextDraft: LocalNoteDraft) {
    setDraft(nextDraft);
    setNotice("");
    setSaveState(saveLocalDraft(documentId, nextDraft) ? "unsaved" : "error");
  }

  function updateBlocks(nextBlocks: unknown[]) {
    if (!draft) return;
    updateSafetyCopy({
      ...draft,
      blocks: editorBlocksToDraftBlocks(nextBlocks),
      updatedAt: new Date().toISOString(),
    });
  }

  async function saveDocument() {
    if (!draft || saveState === "saving") return;
    setSaveState("saving");
    setNotice("");
    try {
      const saved = await api.saveDocument(documentId, {
        title: draft.title,
        blocks: draftToApiBlocks(editorBlocksToDraftBlocks(editor.document)),
        reason: "manual-save",
      });
      const nextDraft = documentToDraft(saved);
      setDocument(saved);
      setDraft(nextDraft);
      setSaveState(saveLocalDraft(documentId, nextDraft) ? "saved" : "error");
      void indexLinks(saved.title, nextDraft.blocks);
    } catch {
      setSaveState("error");
    }
  }

  async function restoreRevision(revision: EditorRevision) {
    const saved = await api.saveDocument(documentId, {
      title: revision.title,
      blocks: revisionToApiBlocks(revision),
      reason: `restore-v${revision.revisionNumber}`,
    });
    const nextDraft = documentToDraft(saved);
    setDocument(saved);
    setDraft(nextDraft);
    setSaveState(saveLocalDraft(documentId, nextDraft) ? "saved" : "error");
    setNotice(`已恢复到 v${revision.revisionNumber}`);
    void indexLinks(saved.title, nextDraft.blocks);
  }

  async function indexLinks(title: string, blocks: LocalNoteDraft["blocks"]) {
    if (!provider) return;
    try {
      await provider.indexDocumentLinks(documentId, title, extractWikiLinks(blocks));
    } catch {
      // Link indexing is auxiliary; it must not turn a successful document save into an error.
    }
  }

  if (loadError) return <DocumentLoadError message={loadError} onRetry={() => setReloadToken((value) => value + 1)} />;
  if (!document || !draft) {
    return <div className="flex min-h-screen items-center justify-center bg-ink p-6 text-text-dim" role="status">正在准备编辑器...</div>;
  }

  const statusText = {
    saved: "已保存",
    unsaved: "有未同步修改",
    saving: "正在保存...",
    error: "本地副本或服务器保存失败",
  }[saveState];

  return (
    <div className="min-h-screen bg-ink text-text">
      <header className="sticky top-0 z-10 border-b border-line bg-ink/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-text-dim hover:text-text" href="/library" aria-label="返回知识库">
            <ArrowLeft aria-hidden="true" size={17} />
            知识库
          </Link>
          <span className="h-5 w-px bg-line" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">服务端编辑器</span>
          <label className="min-w-[12rem] flex-1">
            <span className="sr-only">笔记标题</span>
            <input className="w-full border-0 bg-transparent px-1 py-1 text-lg font-semibold text-text outline-none placeholder:text-text-dim focus:ring-2 focus:ring-primary/60" value={draft.title} onChange={(event) => updateSafetyCopy({ ...draft, title: event.target.value, updatedAt: new Date().toISOString() })} />
          </label>
          <span className="inline-flex items-center gap-1.5 text-xs text-text-dim" role="status" aria-live="polite">
            {saveState === "saved" ? <Check aria-hidden="true" size={14} className="text-success" /> : null}
            {notice || statusText}
          </span>
          <button className="rounded-md p-2 text-text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40" type="button" onClick={() => { editor.undo(); updateBlocks(editor.document); }} aria-label="撤销" title="撤销"><Undo2 aria-hidden="true" size={17} /></button>
          <button className="rounded-md p-2 text-text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40" type="button" onClick={() => { editor.redo(); updateBlocks(editor.document); }} aria-label="重做" title="重做"><Redo2 aria-hidden="true" size={17} /></button>
          <button className="rounded-md p-2 text-text-dim hover:bg-surface-2 hover:text-text" type="button" onClick={() => setHistoryOpen(true)} aria-label="打开版本历史" title="版本历史"><Clock3 aria-hidden="true" size={17} /></button>
          <button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-ink hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50" type="button" onClick={saveDocument} disabled={saveState === "saving"}><Save aria-hidden="true" size={16} />保存</button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">编辑笔记</h1>
          </div>
          <p className="max-w-md text-right text-sm text-text-dim">本地会保留最近的安全副本，保存时写入新的服务器版本。</p>
        </div>
        <section className="rounded-lg border border-line bg-surface p-3 shadow-2xl shadow-black/20 sm:p-6" aria-label="笔记编辑器">
          <BlockNoteViewRaw editor={editor} theme="dark" onChange={(nextEditor) => updateBlocks(nextEditor.document)} />
        </section>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <PropertiesPanel documentId={documentId} provider={provider} />
          <BacklinksPanel targetTitle={draft.title} provider={provider} />
        </div>
      </main>
      <VersionHistoryDrawer documentId={documentId} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestore={restoreRevision} api={api} />
    </div>
  );
}

export function DocumentLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="flex min-h-screen items-center justify-center bg-ink p-6"><section className="space-y-4" role="alert"><p className="text-danger">{message}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onRetry} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
}
