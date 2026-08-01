"use client";

import { zh } from "@blocknote/core/locales";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import { ArrowLeft, Check, Redo2, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createEmptyLocalDraft,
  draftBlocksToEditorBlocks,
  editorBlocksToDraftBlocks,
  loadLocalDraft,
  saveLocalDraft,
  type LocalNoteDraft,
} from "./local-draft";

export function LocalNoteEditor() {
  const [draft, setDraft] = useState<LocalNoteDraft | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "error">("unsaved");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("auth");
        const body = await response.json() as { user?: { workspaceId?: string } };
        if (!body.user?.workspaceId) throw new Error("workspace");
        if (active) setWorkspaceId(body.user.workspaceId);
      })
      .catch(() => {
        if (active) setLoadError("暂时无法准备笔记，请刷新后重试。");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const stored = loadLocalDraft(workspaceId);
    setDraft(stored ?? createEmptyLocalDraft());
    setSaveState(stored ? "saved" : "unsaved");
  }, [workspaceId]);

  const initialContent = useMemo(
    () => (draft ? draftBlocksToEditorBlocks(draft.blocks) : undefined),
    [draft?.draftId],
  );
  const editor = useCreateBlockNote(
    {
      dictionary: zh,
      initialContent,
      defaultStyles: true,
    },
    [draft?.draftId],
  );

  function markUnsaved() {
    setSaveState("unsaved");
  }

  function updateDraft(update: (current: LocalNoteDraft) => LocalNoteDraft) {
    setDraft((current) => (current ? update(current) : current));
    markUnsaved();
  }

  function saveDraft() {
    if (!draft) return;
    const nextDraft: LocalNoteDraft = {
      ...draft,
      blocks: editorBlocksToDraftBlocks(editor.document),
      updatedAt: new Date().toISOString(),
    };
    setDraft(nextDraft);
    setSaveState(workspaceId && saveLocalDraft(workspaceId, nextDraft) ? "saved" : "error");
  }

  if (loadError) {
    return <div className="editor-loading" role="alert">{loadError}</div>;
  }

  if (!draft) {
    return <div className="editor-loading" role="status">正在准备编辑器...</div>;
  }

  return (
    <div className="editor-page">
      <header className="editor-toolbar">
        <div className="editor-toolbar__leading">
          <Link className="editor-back" href="/library" aria-label="返回知识库">
            <ArrowLeft aria-hidden="true" size={18} />
            <span>知识库</span>
          </Link>
          <span className="editor-divider" aria-hidden="true" />
          <span className="editor-mode">本地草稿</span>
        </div>
        <label className="editor-title-label">
          <span className="sr-only">笔记标题</span>
          <input
            className="editor-title"
            value={draft.title}
            onChange={(event) => {
              const title = event.target.value;
              updateDraft((current) => ({ ...current, title }));
            }}
            aria-label="笔记标题"
          />
        </label>
        <div className="editor-toolbar__actions">
          <span className="editor-save-status" role="status" aria-live="polite">
            {saveState === "saved" ? <><Check aria-hidden="true" size={15} /> 已保存到本机</> : null}
            {saveState === "unsaved" ? "有未保存修改" : null}
            {saveState === "error" ? "本机存储不可用" : null}
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={() => { editor.undo(); markUnsaved(); }}
            aria-label="撤销"
            title="撤销"
          >
            <Undo2 aria-hidden="true" size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => { editor.redo(); markUnsaved(); }}
            aria-label="重做"
            title="重做"
          >
            <Redo2 aria-hidden="true" size={17} />
          </button>
          <button className="button editor-save" type="button" onClick={saveDraft}>
            <Save aria-hidden="true" size={17} /> 保存草稿
          </button>
        </div>
      </header>

      <main className="editor-main">
        <header className="editor-page-header">
          <div>
            <p className="workspace-page__eyebrow">本地编辑器</p>
            <h1>新建笔记</h1>
          </div>
          <p>先把想法写下来，块结构会保留在本机草稿中，后续可无损接入服务器版本。</p>
        </header>
        <div className="editor-notice" role="note">
          当前内容只保存在本机浏览器。服务器同步和版本历史将在后端编辑协议完成后接入。
        </div>
        <section className="editor-surface" aria-label="笔记编辑器">
          <BlockNoteViewRaw
            editor={editor}
            theme="dark"
            onChange={(nextEditor) => {
              updateDraft((current) => ({
                ...current,
                blocks: editorBlocksToDraftBlocks(nextEditor.document),
                updatedAt: new Date().toISOString(),
              }));
            }}
          />
        </section>
      </main>
    </div>
  );
}
