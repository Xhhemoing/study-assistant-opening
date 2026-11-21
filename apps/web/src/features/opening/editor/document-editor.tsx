"use client";

import { zh } from "@blocknote/core/locales";
import { promotionResponseSchema, type WritingWorkspaceResponse } from "@aistudy/contracts";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import { ArrowLeft, Check, Clock3, GitBranch, PanelRight, Redo2, Save, Undo2 } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useMemo, useRef, useState } from "react";
import { createEditorApi, EditorApiError, type EditorDocument } from "./editor-api";
import { BacklinksPanel } from "./backlinks-panel";
import { DEFAULT_LIBRARY_BASE_PATH, libraryNotePath, type LibraryBasePath } from "./library-paths";
import { createDocumentRelationsApi } from "./document-relations-api";
import { DraftConflictPanel } from "./draft-conflict-panel";
import { createKnowledgeLinksApi } from "./knowledge-links-api";
import {
  buildSavePayload,
  documentToDraft,
  planDraftRestore,
  planSaveAsNewNote,
  resolveEditorSaveResult,
  revisionToApiBlocks,
  summarizeDraftDiff,
  type DraftConflict,
} from "./document-editor-model";
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
import { RevisionReviewPanel } from "../../revision-review/revision-review-panel";

import { Inspector } from "../design/inspector";
import { LoadError, LoadingRows, ui } from "../design/ui";
import { useAppearancePreferences } from "../settings/appearance-preferences";
import { AssetLearningLinks } from "../learning-links/asset-learning-links";
import { WritingVariantsPanel, type WritingEditorBlockOption } from "./writing-variants-panel";
import { createWritingWorkspaceApi } from "./writing-workspace-api";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

function extractDraftBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractDraftBlockText).join("");
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if ("content" in obj) return extractDraftBlockText(obj.content);
  }
  return "";
}

export function DocumentEditor({
  documentId,
  basePath = DEFAULT_LIBRARY_BASE_PATH,
  focusBlockId,
  activityId,
}: {
  documentId: string;
  basePath?: LibraryBasePath;
  focusBlockId?: string;
  activityId?: string;
}) {
  const { resolvedTheme } = useAppearancePreferences();
  const api = useMemo(() => createEditorApi(), []);
  const knowledgeLinksApi = useMemo(() => createKnowledgeLinksApi(), []);
  const writingApi = useMemo(() => createWritingWorkspaceApi(), []);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraft] = useState<LocalNoteDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saving");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [writingOpen, setWritingOpen] = useState(false);
  const [writingResponse, setWritingResponse] = useState<WritingWorkspaceResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [sourceExplorationId, setSourceExplorationId] = useState<string | null>(null);
  const draftRef = useRef<LocalNoteDraft | null>(null);
  const editVersionRef = useRef(0);
  const linkIndexQueueRef = useRef(Promise.resolve());
  const [conflict, setConflict] = useState<DraftConflict["reason"] | null>(null);
  const conflictRef = useRef<DraftConflict["reason"] | null>(null);
  const [diff, setDiff] = useState<ReturnType<typeof summarizeDraftDiff> | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [savedAsNewHref, setSavedAsNewHref] = useState<string | null>(null);
  const [relationNote, setRelationNote] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const saveShortcut = useRef(saveDocument);
  saveShortcut.current = saveDocument;

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || window.document.querySelector('dialog[open],[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      void saveShortcut.current();
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, []);

  function enterConflict(reason: DraftConflict["reason"] | null) {
    conflictRef.current = reason;
    setConflict(reason);
    setDiff(null);
    setConfirmingDiscard(false);
    if (reason) {
      setSavedAsNewHref(null);
      setRelationNote(null);
    }
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    api.fetchDocument(documentId)
      .then((nextDocument) => {
        if (!active) return;
        // Chosen by base revision, never by clock (G1).
        const plan = planDraftRestore(nextDocument, loadLocalDraft(documentId));
        draftRef.current = plan.draft;
        editVersionRef.current += 1;
        enterConflict(plan.conflict?.reason ?? null);
        setDocument(nextDocument);
        setDraft(plan.draft);
        setSaveState(plan.state);
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

  useEffect(() => {
    if (basePath !== "/opening/library") {
      setWritingResponse(null);
      return;
    }
    let active = true;
    writingApi.get(documentId, { focusBlockId: focusBlockId ?? null, activityId: activityId ?? null })
      .then((response) => {
        if (!active) return;
        setWritingResponse(response);
        if (response.initialized) {
          setWritingOpen(true);
        }
      })
      .catch(() => {
        if (active) setWritingResponse(null);
      });
    return () => { active = false; };
  }, [activityId, basePath, documentId, focusBlockId, reloadToken, writingApi]);

  const writingFocusBlockId = writingResponse?.initialized && writingResponse.workspace.focusRestore.status === "exact"
    ? writingResponse.workspace.focusRestore.blockId
    : null;
  useEffect(() => {
    if (!writingFocusBlockId || !document) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(writingFocusBlockId)
      : writingFocusBlockId.replace(/"/g, '\\"');
    const target = window.document.querySelector(`[data-id="${escaped}"]`);
    if (target && typeof (target as HTMLElement).scrollIntoView === "function") {
      (target as HTMLElement).scrollIntoView({ block: "center" });
    }
  }, [document, writingFocusBlockId]);

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
    // While in conflict the copy keeps its old base; edits are kept, saving stays blocked.
    setSaveState(saveLocalDraft(documentId, nextDraft) ? (conflictRef.current ? "conflict" : "unsaved") : "error");
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
    if (!document || !draft || saveState === "saved" || saveState === "saving" || saveInFlight.current || conflictRef.current) return;
    saveInFlight.current = true;
    const requestVersion = editVersionRef.current;
    setSaveState("saving");
    setNotice("");
    try {
      // expected = the draft's base revision, not the latest server revision (G1).
      const saved = await api.saveDocument(documentId, buildSavePayload({
        ...draft,
        blocks: editorBlocksToDraftBlocks(editor.document),
      }));
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
      if (error instanceof EditorApiError && error.code === "CONFLICT") {
        enterConflict("server-conflict");
        setSaveState("conflict");
      } else {
        setSaveState("error");
      }
    } finally {
      saveInFlight.current = false;
    }
  }

  async function restoreRevision(revision: EditorRevision) {
    if (!document || saveState === "saving" || conflictRef.current) return;
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
        enterConflict("server-conflict");
        setSaveState("conflict");
      } else {
        setSaveState("error");
      }
      throw error;
    }
  }

  async function viewDiff() {
    const local = draftRef.current;
    if (!local) return;
    setConflictBusy(true);
    try {
      const latest = await api.fetchDocument(documentId);
      setDiff(summarizeDraftDiff(local, documentToDraft(latest)));
    } catch {
      setNotice("暂时无法读取服务器最新版本");
    } finally {
      setConflictBusy(false);
    }
  }

  async function saveAsNewNote() {
    const local = draftRef.current;
    if (!local) return;
    setConflictBusy(true);
    try {
      const created = await api.createDocument(planSaveAsNewNote({ ...local, blocks: editorBlocksToDraftBlocks(editor.document) }));
      setSavedAsNewHref(libraryNotePath(basePath, created.id));
      try {
        // Existing relations API supports document → document derived_from.
        await createDocumentRelationsApi().create(created.id, { type: "document", id: documentId }, "derived_from");
        setRelationNote("已记录来源：派生自原笔记");
      } catch {
        setRelationNote("副本已保存，但未能记录来源关系");
      }
      // The copy is on the server now, so the local draft may go; this note reloads the latest server version.
      discardLocalAndReload(false);
    } catch {
      setNotice("另存失败，本地草稿仍保留");
    } finally {
      setConflictBusy(false);
    }
  }

  function requestDiscard() {
    if (!confirmingDiscard) {
      setConfirmingDiscard(true);
      return;
    }
    discardLocalAndReload(true);
  }

  /** Only reachable from an explicit user choice (confirmed discard or after save-as-new). */
  function discardLocalAndReload(resetCopyLink: boolean) {
    try {
      window.localStorage.removeItem(createLocalDraftStorageKey(documentId));
    } catch {
      // A reload still gives the user the latest server document if storage is unavailable.
    }
    conflictRef.current = null;
    setConflict(null);
    setDiff(null);
    setConfirmingDiscard(false);
    if (resetCopyLink) setSavedAsNewHref(null);
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
    return <LoadingRows label="正在准备编辑器…" />;
  }

  const statusText = {
    saved: "已保存",
    unsaved: "有未同步修改",
    saving: "正在保存...",
    error: "本地副本或服务器保存失败",
    conflict: "保存冲突：本地修改已保留，请选择处理方式",
  }[saveState];
  const writingBlocks: WritingEditorBlockOption[] = draft.blocks.map((block) => ({
    id: block.id,
    text: extractDraftBlockText(block.content),
  }));
  const writingFocusRestore = writingResponse?.initialized ? writingResponse.workspace.focusRestore : null;

  const fullText = writingBlocks.map((block) => block.text).join("\n").trim();
  const englishWords = fullText ? (fullText.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/g)?.length ?? 0) : 0;

  return <div className="flex h-full min-h-0 flex-col bg-bg text-text">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line/80 bg-surface/95 px-3.5 py-2 backdrop-blur-sm">
      <Link className={ui.quiet} href={basePath} aria-label="返回知识库"><ArrowLeft aria-hidden="true" size={14} /><span className="hidden sm:inline">知识库</span></Link>
      <label className="min-w-28 flex-1"><span className="sr-only">笔记标题</span><input className={`${ui.input} border-transparent bg-transparent font-serif text-base font-semibold hover:bg-surface-2/60 focus-visible:bg-surface`} value={draft.title} onChange={(event) => updateSafetyCopy({ ...draft, title: event.target.value, updatedAt: new Date().toISOString() })} /></label>
      <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-text-3" role="status" aria-live="polite">{saveState === "saved" ? <Check aria-hidden="true" size={13} className="text-accent" /> : null}{notice || statusText}</span>
      <div className="flex items-center gap-1"><button className={ui.icon} type="button" onClick={() => { editor.undo(); updateBlocks(editor.document); }} aria-label="撤销" title="撤销"><Undo2 aria-hidden="true" size={15} /></button><button className={ui.icon} type="button" onClick={() => { editor.redo(); updateBlocks(editor.document); }} aria-label="重做" title="重做"><Redo2 aria-hidden="true" size={15} /></button><button className={ui.icon} type="button" onClick={() => { setHistoryOpen(true); setPropertiesOpen(false); setWritingOpen(false); }} aria-label="打开版本历史" title="版本历史"><Clock3 aria-hidden="true" size={15} /></button>{basePath === "/opening/library" ? <button className={`${ui.icon} ${writingOpen ? "bg-accent-soft text-accent" : ""}`} type="button" onClick={() => { setWritingOpen(!writingOpen); setPropertiesOpen(false); setHistoryOpen(false); }} aria-label="多稿写作与润色" aria-expanded={writingOpen} title="多稿写作"><GitBranch aria-hidden="true" size={15} /></button> : null}<button className={`${ui.icon} ${propertiesOpen ? "bg-accent-soft text-accent" : ""}`} type="button" onClick={() => { setPropertiesOpen(!propertiesOpen); setHistoryOpen(false); setWritingOpen(false); }} aria-label="笔记属性与关联" aria-expanded={propertiesOpen}><PanelRight aria-hidden="true" size={15} /></button></div>
      <button className={ui.primary} title="保存 · Ctrl / ⌘ S" type="button" onClick={saveDocument} disabled={saveState === "saving" || conflict !== null}><Save aria-hidden="true" size={14} />保存</button>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-[780px] px-4 py-6 sm:px-8"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h1 className="text-xs font-medium tabular-nums text-text-3" title="本地保留安全副本；保存会创建服务器版本。">编辑笔记 · v{document.currentRevisionNumber}</h1><div className="flex items-center gap-3">{fullText ? <span className="text-xs tabular-nums text-text-3">{englishWords >= 10 ? `${englishWords} 词 · ${fullText.length} 字` : `${fullText.length} 字`}</span> : null}{sourceExplorationId && basePath === "/library" ? <Link className={ui.quiet} href={`/explore/${sourceExplorationId}`}>返回来源探索</Link> : null}</div></div>
        {writingFocusRestore?.status === "block_missing" ? <p role="status" className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-xs leading-5 text-warn">{writingFocusRestore.message}</p> : null}
        {conflict ? <DraftConflictPanel reason={conflict} diff={diff} busy={conflictBusy} confirmingDiscard={confirmingDiscard} savedAsNewHref={savedAsNewHref} relationNote={relationNote} onViewDiff={() => void viewDiff()} onSaveAsNew={() => void saveAsNewNote()} onDiscard={requestDiscard} onCancelDiscard={() => setConfirmingDiscard(false)} /> : null}
        {!conflict && savedAsNewHref ? <p className="mb-4 text-xs text-text-2" role="status">本地修改已另存为新笔记：<Link className="underline" href={savedAsNewHref}>打开副本</Link>{relationNote ? `（${relationNote}）` : ""}</p> : null}
        <section className="min-h-80 rounded-card border border-line bg-surface px-5 py-6 text-base leading-8 shadow-card sm:px-9 sm:py-8 [&_.bn-container]:bg-surface [&_.bn-container]:font-sans [&_.bn-editor]:min-h-80 [&_.bn-editor]:bg-surface [&_.bn-editor]:px-0 [&_.bn-editor]:text-[15px] [&_.bn-editor]:leading-8 [&_.bn-editor]:text-text" aria-label="笔记编辑器"><BlockNoteViewRaw editor={editor} theme={resolvedTheme} onChange={(nextEditor) => updateBlocks(nextEditor.document)} /></section>
      </div></div>
      {basePath === "/opening/library" ? <Inspector open={writingOpen} onClose={() => setWritingOpen(false)} title="多稿写作与润色" id="document-writing-variants"><WritingVariantsPanel documentId={documentId} currentRevisionNumber={document.currentRevisionNumber} blocks={writingBlocks} basePath={basePath} focusBlockId={focusBlockId ?? null} activityId={activityId ?? null} hasUnsavedEdits={saveState === "unsaved" || saveState === "saving" || conflict !== null} api={writingApi} initialResponse={writingResponse} onWorkspaceLoaded={setWritingResponse} onDocumentUpdated={() => { void (async () => { if (saveState === "saved") { const requestVersion = editVersionRef.current; const expectedBaseRevision = document.currentRevisionNumber; try { const synced = await api.fetchDocument(documentId); if (editVersionRef.current === requestVersion && draftRef.current?.baseRevisionNumber === expectedBaseRevision) { saveLocalDraft(documentId, documentToDraft(synced)); } } catch { /* Reload below preserves recovery if pre-sync fails. */ } } setReloadToken((value) => value + 1); })(); }} /></Inspector> : null}
      <Inspector open={propertiesOpen} onClose={() => setPropertiesOpen(false)} title="笔记属性与关联" id="document-properties"><div className="space-y-4">{basePath === "/opening/library" ? <AssetLearningLinks assetType="document" assetId={documentId} /> : null}<PropertiesPanel documentId={documentId} /><ReadOnlyPropertiesPanel documentId={documentId} /><RelationAuthoringPanel documentId={documentId} basePath={basePath} /><BacklinksPanel documentId={documentId} basePath={basePath} /><RevisionReviewPanel documentId={documentId} /></div></Inspector>
      <VersionHistoryDrawer documentId={documentId} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestore={restoreRevision} api={api} />
    </div>
  </div>;
}

export function DocumentLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section aria-label="笔记读取失败" className="mx-auto max-w-lg p-5"><LoadError message={message} onRetry={onRetry} /></section>;
}
