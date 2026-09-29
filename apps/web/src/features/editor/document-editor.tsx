"use client";

import { zh } from "@blocknote/core/locales";
import { promotionResponseSchema } from "@aistudy/contracts";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import { ArrowLeft, Check, Clock3, PanelRight, Redo2, RefreshCw, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createEditorApi, EditorApiError, type EditorDocument } from "./editor-api";
import { BacklinksPanel } from "./backlinks-panel";
import { createKnowledgeLinksApi } from "./knowledge-links-api";
import { documentToDraft, draftToApiBlocks, resolveEditorSaveResult, revisionToApiBlocks } from "./document-editor-model";
import {
  createLocalDraftStorageKey,
  draftBlocksToEditorBlocks,
  editorBlocksToDraftBlocks,
  loadLocalDraft,
  saveLocalDraft,
  type LocalNoteDraft,
} from "./local-draft";
import { VersionHistoryDrawer } from "./version-history-drawer";
import type { EditorRevision } from "./version-history";
import { PropertiesPanel } from "./properties-panel";
import { ReadOnlyPropertiesPanel } from "./read-only-properties-panel";
import { RelationAuthoringPanel } from "./relation-authoring-panel";
import { extractWikiLinks } from "./link-utils";
import { RevisionReviewPanel } from "../revision-review/revision-review-panel";

import { Inspector } from "../opening/design/inspector";
import { LoadError, ui } from "../opening/design/ui";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

export function DocumentEditor({ documentId }: { documentId: string }) {
  const api = useMemo(() => createEditorApi(), []);
  const knowledgeLinksApi = useMemo(() => createKnowledgeLinksApi(), []);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraft] = useState<LocalNoteDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saving");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [sourceExplorationId, setSourceExplorationId] = useState<string | null>(null);
  const draftRef = useRef<LocalNoteDraft | null>(null);
  const editVersionRef = useRef(0);
  const linkIndexQueueRef = useRef(Promise.resolve());

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
        const nextDraft = usableLocal ?? documentToDraft(nextDocument);
        draftRef.current = nextDraft;
        editVersionRef.current += 1;
        setDocument(nextDocument);
        setDraft(nextDraft);
        setSaveState(usableLocal ? "unsaved" : "saved");
      })
      .catch(() => {
        if (active) setLoadError("暂时无法读取这篇笔记，请稍后重试。");
      });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  useEffect(() => {
    let active = true;
    fetch(`/api/documents/${documentId}/promotion-source`)
      .then(async (response) => response.ok ? promotionResponseSchema.parse(await response.json()).promotion : null)
      .then((promotion) => { if (active) setSourceExplorationId(promotion?.explorationId ?? null); })
      .catch(() => { if (active) setSourceExplorationId(null); });
    return () => { active = false; };
  }, [documentId]);

  const initialContent = useMemo(
    () => (draft ? draftBlocksToEditorBlocks(draft.blocks) : undefined),
    [draft?.draftId, reloadToken],
  );
  const editor = useCreateBlockNote(
    { dictionary: zh, initialContent, defaultStyles: true },
    [draft?.draftId, reloadToken],
  );

  function updateSafetyCopy(nextDraft: LocalNoteDraft) {
    draftRef.current = nextDraft;
    editVersionRef.current += 1;
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
    if (!document || !draft || saveState === "saving") return;
    const requestVersion = editVersionRef.current;
    setSaveState("saving");
    setNotice("");
    try {
      const saved = await api.saveDocument(documentId, {
        expectedRevisionNumber: document.currentRevisionNumber,
        title: draft.title,
        blocks: draftToApiBlocks(editorBlocksToDraftBlocks(editor.document)),
        reason: "manual-save",
      });
      const currentDraft = draftRef.current ?? draft;
      if (!currentDraft) return;
      const result = resolveEditorSaveResult(
        saved,
        currentDraft,
        requestVersion,
        editVersionRef.current,
      );
      draftRef.current = result.draft;
      setDocument(saved);
      setDraft(result.draft);
      setSaveState(saveLocalDraft(documentId, result.draft)
        ? result.hasUnsavedChanges ? "unsaved" : "saved"
        : "error");
      if (!result.hasUnsavedChanges) {
        queueLinkIndex(result.draft.blocks, editVersionRef.current);
      }
    } catch (error) {
      setSaveState(error instanceof EditorApiError && error.code === "CONFLICT" ? "conflict" : "error");
    }
  }

  async function restoreRevision(revision: EditorRevision) {
    if (!document || saveState === "saving") return;
    const requestVersion = editVersionRef.current;
    setSaveState("saving");
    setNotice("");
    try {
      const saved = await api.saveDocument(documentId, {
        expectedRevisionNumber: document.currentRevisionNumber,
        title: revision.title,
        blocks: revisionToApiBlocks(revision),
        reason: `restore-v${revision.revisionNumber}`,
      });
      const currentDraft = draftRef.current ?? draft;
      if (!currentDraft) return;
      const result = resolveEditorSaveResult(
        saved,
        currentDraft,
        requestVersion,
        editVersionRef.current,
      );
      draftRef.current = result.draft;
      setDocument(saved);
      setDraft(result.draft);
      setSaveState(saveLocalDraft(documentId, result.draft)
        ? result.hasUnsavedChanges ? "unsaved" : "saved"
        : "error");
      setNotice(result.hasUnsavedChanges ? "版本已恢复，本地修改仍待保存" : `已恢复到 v${revision.revisionNumber}`);
      if (!result.hasUnsavedChanges) {
        queueLinkIndex(result.draft.blocks, editVersionRef.current);
      }
    } catch (error) {
      if (error instanceof EditorApiError && error.code === "CONFLICT") {
        setSaveState("conflict");
      } else {
        setSaveState("error");
      }
      throw error;
    }
  }

  function reloadLatestDocument() {
    try {
      window.localStorage.removeItem(createLocalDraftStorageKey(documentId));
    } catch {
      // A reload still gives the user the latest server document if storage is unavailable.
    }
    setDocument(null);
    setDraft(null);
    setNotice("");
    setSaveState("saving");
    setReloadToken((value) => value + 1);
  }

  function queueLinkIndex(blocks: LocalNoteDraft["blocks"], version: number) {
    const task = linkIndexQueueRef.current.then(async () => {
      if (version !== editVersionRef.current) return;
      try {
        await knowledgeLinksApi.index(documentId, extractWikiLinks(blocks));
      } catch {
        // Link indexing is auxiliary; it must not turn a successful document save into an error.
      }
    });
    linkIndexQueueRef.current = task.catch(() => undefined);
  }

  if (loadError) return <DocumentLoadError message={loadError} onRetry={() => setReloadToken((value) => value + 1)} />;
  if (!document || !draft) {
    return <div className="flex min-h-screen items-center justify-center bg-white p-6 text-zinc-500" role="status">正在准备编辑器...</div>;
  }

  const statusText = {
    saved: "已保存",
    unsaved: "有未同步修改",
    saving: "正在保存...",
    error: "本地副本或服务器保存失败",
    conflict: "服务器已有更新版本，当前修改尚未覆盖",
  }[saveState];

  return <div className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2">
      <Link className={ui.quiet} href="/library" aria-label="返回知识库"><ArrowLeft aria-hidden="true" size={14} /><span className="hidden sm:inline">知识库</span></Link>
      <label className="min-w-28 flex-1"><span className="sr-only">笔记标题</span><input className={`${ui.input} border-transparent font-medium`} value={draft.title} onChange={(event) => updateSafetyCopy({ ...draft, title: event.target.value, updatedAt: new Date().toISOString() })} /></label>
      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500" role="status" aria-live="polite">{saveState === "saved" ? <Check aria-hidden="true" size={13} className="text-emerald-700" /> : null}{notice || statusText}</span>
      <div className="flex items-center gap-1"><button className={ui.icon} type="button" onClick={() => { editor.undo(); updateBlocks(editor.document); }} aria-label="撤销" title="撤销"><Undo2 aria-hidden="true" size={15} /></button><button className={ui.icon} type="button" onClick={() => { editor.redo(); updateBlocks(editor.document); }} aria-label="重做" title="重做"><Redo2 aria-hidden="true" size={15} /></button><button className={ui.icon} type="button" onClick={() => { setHistoryOpen(true); setPropertiesOpen(false); }} aria-label="打开版本历史" title="版本历史"><Clock3 aria-hidden="true" size={15} /></button><button className={`${ui.icon} ${propertiesOpen ? "bg-emerald-50 text-emerald-800" : ""}`} type="button" onClick={() => { setPropertiesOpen(!propertiesOpen); setHistoryOpen(false); }} aria-label="笔记属性与关联" aria-expanded={propertiesOpen}><PanelRight aria-hidden="true" size={15} /></button></div>
      {saveState === "conflict" ? <button className={ui.secondary} type="button" onClick={reloadLatestDocument}><RefreshCw aria-hidden="true" size={14} />重新加载最新版本</button> : null}
      <button className={ui.primary} type="button" onClick={saveDocument} disabled={saveState === "saving"}><Save aria-hidden="true" size={14} />保存</button>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-4xl px-5 py-5 sm:px-8"><div className="mb-5 flex flex-wrap items-center justify-between gap-2"><h1 className="text-xs font-medium text-zinc-500">编辑笔记 · v{document.currentRevisionNumber}</h1>{sourceExplorationId ? <Link className={ui.quiet} href={`/explore/${sourceExplorationId}`}>返回来源探索</Link> : null}<p className="text-xs leading-6 text-zinc-500">本地保留安全副本；保存会创建服务器版本。</p></div>
        <section className="min-h-80 text-sm leading-7 [&_.bn-container]:bg-white [&_.bn-container]:font-sans [&_.bn-editor]:min-h-80 [&_.bn-editor]:bg-white [&_.bn-editor]:px-0 [&_.bn-editor]:text-sm [&_.bn-editor]:leading-7 [&_.bn-editor]:text-zinc-800" aria-label="笔记编辑器"><BlockNoteViewRaw editor={editor} theme="light" onChange={(nextEditor) => updateBlocks(nextEditor.document)} /></section>
      </div></main>
      <Inspector open={propertiesOpen} onClose={() => setPropertiesOpen(false)} title="笔记属性与关联" id="document-properties"><div className="space-y-4"><PropertiesPanel documentId={documentId} /><ReadOnlyPropertiesPanel documentId={documentId} /><RelationAuthoringPanel documentId={documentId} /><BacklinksPanel documentId={documentId} /><RevisionReviewPanel documentId={documentId} /></div></Inspector>
      <VersionHistoryDrawer documentId={documentId} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestore={restoreRevision} api={api} />
    </div>
  </div>;
}

export function DocumentLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="mx-auto max-w-lg p-5"><LoadError message={message} onRetry={onRetry} /></main>;
}
