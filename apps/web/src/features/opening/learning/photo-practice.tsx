"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { LearningAttempt, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { ContentBlock, ContentGrid, PageHeader, ui } from "../design/ui";
import { sourcePreviewHref } from "../inbox/source-viewer";
import { LearningAttemptForm } from "./attempt-form";
import { preparePhotoPractice, type PreparedPhotoPractice } from "./photo-practice-client";
import { runPracticeRequest } from "./practice-draft";
import { ConversationCompanionTabs } from "../teaching/conversation-companion-tabs";
import { AssistantSession } from "../assistant/assistant-session";
import { assistantEntry } from "../assistant/assistant-entry";
import { studyConversationHref } from "../assistant/study-conversation-context";
import { StudyToolsPanel } from "../teaching/study-tools-panel";
import { PhotoRecognitionEditor } from "./photo-recognition-editor";
import { useWorkspaceLayout } from "../shell/workspace-layout-context";

const draftSchema = z.object({ sourceVersion: z.number().int().nonnegative(), stem: z.string().max(2000), confirmed: z.boolean() }).strict();
const storageKey = (sourceId: string) => `study:photo-practice:v1:${sourceId}`;

type PhotoPracticeProps = { sourceId: string; conversationId?: string; conversationError?: string };

export function PhotoPractice(props: PhotoPracticeProps) {
  return <PhotoPracticeContent key={props.sourceId} {...props} />;
}

function PhotoPracticeContent({ sourceId, conversationId, conversationError }: PhotoPracticeProps) {
  const { focusMode, toggleFocusMode, setFocusMode } = useWorkspaceLayout();
  const [activePanel, setActivePanel] = useState<string | null>(() => conversationId ? "chat" : null);
  const [tutoring, setTutoring] = useState<LearningAttempt[]>([]);
  const [selectedTutoringId, setSelectedTutoringId] = useState<string | null>(null);
  const [tutorRequestKey, setTutorRequestKey] = useState(0);
  function selectPanel(panel: string | null) {
    if (panel) setFocusMode(false);
    setActivePanel(panel);
  }
  function askAttempt(attempt: LearningAttempt) {
    setTutoring(current => current.some(item => item.id === attempt.id) ? current : [...current, attempt]);
    setSelectedTutoringId(attempt.id); setTutorRequestKey(value => value + 1);
    selectPanel("chat");
  }
  const panels = [{ id: "chat", label: "对话", content: <ConversationCompanionTabs conversationId={conversationId ?? null} tutorRequestKey={tutorRequestKey}>
    {tutoring.length ? tutoring.map(attempt => {
      const anchor = attempt.contextAnchor;
      const entry = assistantEntry(studyConversationHref({ courseId: attempt.courseId, attemptId: attempt.id,
        itemVersionId: attempt.itemVersionId ?? undefined, activityId: anchor?.activityId ?? undefined,
        blockId: anchor?.blockId ?? undefined, contentVersion: anchor?.contentVersion ?? undefined,
        sourceId: anchor?.sourceId ?? undefined, sourceVersion: anchor?.sourceVersion ?? undefined,
        page: anchor?.page ?? undefined, chunkId: anchor?.chunkId ?? undefined,
        kcMappingVersion: anchor?.kcMappingVersion ?? undefined, purpose: "learning_help", label: "本题辅导" }), "/opening/practice");
      const selected = attempt.id === selectedTutoringId;
      return <div key={attempt.id} data-photo-tutoring={attempt.id} hidden={!selected} inert={!selected} className={selected ? "flex h-full min-h-0 flex-col" : "hidden"}>
        <AssistantSession entry={{ ...entry, learningAttempt: attempt }} />
      </div>;
    }) : <p className="text-sm leading-6 text-text-2">确认题干后，可从“问本题”打开辅导。</p>}
  </ConversationCompanionTabs> }];
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [stem, setStem] = useState("");
  const [prepared, setPrepared] = useState<PreparedPhotoPractice | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [revision, setRevision] = useState(0);

  function save(value: z.infer<typeof draftSchema>) {
    try { window.sessionStorage.setItem(storageKey(sourceId), JSON.stringify(value)); }
    catch { setStorageWarning(true); }
  }

  useEffect(() => {
    let active = true;
    setLoading(true); setPrepared(null); setError("");
    void (async () => {
      const sources = await createOpeningApi().listSources();
      const actual = sources.find(row => row.id === sourceId && row.uploadState === "uploaded");
      if (!actual || !["image/jpeg", "image/png", "image/webp"].includes(actual.mime)) throw new Error("题图不可用，请重新上传一张题目照片。");
      if (!active) return;
      setSource(actual);
      let stored: z.infer<typeof draftSchema> | null = null;
      try {
        const raw = window.sessionStorage.getItem(storageKey(sourceId));
        if (raw) {
          const parsed = draftSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) throw new Error("保存的题干暂时无法读取，请重新确认题干。");
          stored = parsed.data; setStem(stored.stem);
        }
      } catch (reason) { setError(reason instanceof Error ? reason.message : "题干未恢复，请重新确认。"); return; }
      if (stored && stored.sourceVersion !== actual.version) throw new Error("题图已更新，之前的题干已保留。请核对当前题图，再确认开始。");
      if (stored?.confirmed && stored.stem.trim()) {
        const result = await runPracticeRequest(`photo-practice:${sourceId}:v${actual.version}`, () => preparePhotoPractice({ sourceId, sourceVersion: actual.version }));
        if (active) setPrepared(result);
      }
    })().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "无法读取题图，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceId, revision]);

  async function begin() {
    if (!source || !stem.trim() || pending) return;
    setPending(true); setError("");
    save({ sourceVersion: source.version, stem, confirmed: true });
    try {
      const result = await runPracticeRequest(`photo-practice:${sourceId}:v${source.version}`, () => preparePhotoPractice({ sourceId, sourceVersion: source.version }));
      setPrepared(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法开始作答，题干已保留。"); }
    finally { setPending(false); }
  }

  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-4" data-study-workspace="photo" data-focus-mode={focusMode ? "true" : "false"}>
    <PageHeader title="拍题练习" action={<div className="flex flex-wrap gap-2"><Link className={ui.secondary} href="/opening/today">换一道题</Link><button type="button" className={ui.quiet} aria-pressed={focusMode} onClick={toggleFocusMode}>{focusMode ? "退出专注" : "专注"}</button></div>} />
    <StudyToolsPanel panels={panels} activePanel={activePanel} onPanelChange={selectPanel} suspended={focusMode} preferContentOnNarrowEntry={Boolean(conversationId)} fillHeight contentClassName="space-y-6 pb-4">
    {conversationError ? <p role="alert" className="text-sm text-warn">{conversationError}</p> : null}
    {loading ? <p role="status" className="text-sm text-text-2">正在恢复题图与作答…</p> : null}
    {source ? <ContentGrid>
      <ContentBlock width="full"><figure className="space-y-2 rounded-lg bg-reader-mat p-3">
        <figcaption className="text-sm font-medium text-text">题图 · {source.name}</figcaption>
        {/* Native image keeps the original colors and the exact saved source version. */}
        <img src={sourcePreviewHref(source.id, source.version)} alt="本次练习的题目照片" className="max-h-[60dvh] w-full object-contain [color-scheme:light]" />
      </figure></ContentBlock>
      <ContentBlock width="prose">{prepared ? <LearningAttemptForm courseId={prepared.courseId}
        initialFocus={{ skillLabel: "随手练习", requirementKey: null }}
        initialProblem={{ sourceId, sourceVersion: prepared.sourceVersion, stem }} onRecorded={() => {}} onAskAttempt={askAttempt} />
        : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void begin(); }}>
          <PhotoRecognitionEditor key={`${source.id}:${source.version}`} sourceId={source.id} sourceVersion={source.version} disabled={pending || loading} onUse={proposal => {
            setStem(proposal.stem); save({ sourceVersion: source.version, stem: proposal.stem, confirmed: false });
          }} />
          <label className="block space-y-2 text-sm text-text">题干
            <textarea value={stem} maxLength={2000} rows={5} disabled={pending || loading} className={ui.input} onChange={event => {
              setStem(event.target.value); save({ sourceVersion: source.version, stem: event.target.value, confirmed: false });
            }} />
          </label>
          <p className="text-xs leading-6 text-text-2">对照题图核对识别结果，或手动填写完整题干。这是题目；我的解答会在开始后单独填写或上传。</p>
          <button className={ui.primary} disabled={loading || pending || !stem.trim()}>{pending ? "正在准备…" : "确认题干，开始作答"}</button>
        </form>}</ContentBlock>
    </ContentGrid> : null}
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-warn">{error}</p><button type="button" className={ui.secondary} disabled={loading || pending} onClick={() => setRevision(value => value + 1)}>重新读取题图与作答</button></div> : null}
    {storageWarning ? <p role="status" className="text-xs text-warn">题干暂时仅在本页保留，刷新前请复制。</p> : null}
    </StudyToolsPanel>
  </div>;
}
