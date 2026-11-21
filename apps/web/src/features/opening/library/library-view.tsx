"use client";

import { BookOpen, ChevronDown, ClipboardPaste, FilePlus2, Files, Import, Network, Upload } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aistudy/ui";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { PageHeader, ui } from "../design/ui";
import { LibraryDocumentList } from "./library-document-list";
import { libraryNewNotePath, type LibraryBasePath } from "../editor/library-paths";
import { LearnerStateCard } from "../teaching/learner-state-card";
import { CourseNotes } from "../courses/course-note";
import { MaterialLibrary } from "./material-library";
import type { SourceViewerTarget } from "../inbox/source-viewer";
import { openingUploadAccept, uploadFileRejection } from "../inbox/upload-dropzone";
import { ExternalAiCaptureCard } from "../imports-text/external-ai-capture-card";

export type LibraryFileBatch = { id: number; files: File[] };
const tabs = [{ id: "materials", label: "材料", icon: Files }, { id: "notes", label: "笔记", icon: BookOpen }];
const selectedTab = (tab: string) => tab === "notes" ? "notes" : "materials";

export function LibraryView({ tab = "materials", basePath = "/opening/library", api: supplied, courseId = null, initialOpen = null }: { tab?: string; basePath?: LibraryBasePath; api?: OpeningApi; courseId?: string | null; initialOpen?: SourceViewerTarget | null }) {
  const [filterQuery, setFilterQuery] = useState("");
  const [activeCourseId, setActiveCourseId] = useState(courseId);
  const [selected, setSelected] = useState(selectedTab(tab));
  const [incomingFiles, setIncomingFiles] = useState<LibraryFileBatch | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [materialsEmpty, setMaterialsEmpty] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureMounted, setCaptureMounted] = useState(false);
  const captureId = useId();
  const nextBatch = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => setActiveCourseId(courseId), [courseId]);
  useEffect(() => setSelected(selectedTab(tab)), [tab]);
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const opening = basePath === "/opening/library";

  function changeTab(next: string) {
    const value = selectedTab(next);
    setSelected(value);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    // Keep reading identities and filters intact when switching categories.
    window.history.replaceState(window.history.state, "", url);
  }
  function acceptFiles(files: File[]) {
    if (!files.length) return;
    if (uploadBusy || incomingFiles) { setFileError("当前文件仍在上传，请完成后再添加。"); return; }
    const checked = files.map(file => ({ file, error: uploadFileRejection(file) }));
    setFileError(checked.flatMap(item => item.error ? [item.error] : []).join(" ") || null);
    const accepted = checked.filter(item => !item.error).map(item => item.file);
    if (accepted.length) {
      setIncomingFiles({ id: ++nextBatch.current, files: accepted });
      changeTab("materials");
    }
  }
  function dropFiles(event: DragEvent<HTMLElement>) {
    // The embedded picker owns drops inside its own bounds.
    if (event.defaultPrevented || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    acceptFiles(Array.from(event.dataTransfer.files));
  }

  return <section className="relative flex min-h-full min-w-0 flex-col bg-bg text-text" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={dropFiles}>
    <PageHeader title="资料" action={<div className="flex flex-wrap items-center gap-1.5">{opening ? null : <Link className={ui.quiet} href="/preview/notion-import" title="从 Notion 导出文件本地预览导入"><Import size={14} aria-hidden="true" />导入</Link>}<Link className={ui.secondary} href={activeCourseId ? `/opening/map?context=course&id=course/${encodeURIComponent(activeCourseId)}` : "/opening/map"}><Network size={14} aria-hidden="true" />知识地图</Link>{selected === "notes" ? <Link className={ui.secondary} href={libraryNewNotePath(basePath, activeCourseId)}><FilePlus2 size={14} aria-hidden="true" />新建笔记</Link> : null}<button type="button" className={ui.secondary} aria-controls={captureId} aria-expanded={captureOpen && selected === "materials"} onClick={() => { setCaptureMounted(true); if (selected !== "materials") { changeTab("materials"); setCaptureOpen(true); } else setCaptureOpen(value => !value); }}><ClipboardPaste size={14} aria-hidden="true" />粘贴讲解</button><button type="button" className={selected === "materials" && materialsEmpty ? ui.secondary : ui.primary} disabled={uploadBusy || !!incomingFiles} onClick={() => picker.current?.click()}><Upload size={15} aria-hidden="true" />上传</button></div>} />
    <input ref={picker} className="sr-only" tabIndex={-1} type="file" disabled={uploadBusy || !!incomingFiles} multiple accept={openingUploadAccept} aria-label="上传材料" onChange={event => { acceptFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {dragging ? <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-panel border-2 border-dashed border-accent bg-accent-soft/90 backdrop-blur-[2px] text-base font-medium text-accent shadow-float">松开文件，添加到资料</div> : null}
    {fileError ? <p role="alert" className="mx-auto w-full max-w-[1040px] px-4 pt-3 text-sm text-danger sm:px-6">{fileError}</p> : null}
    {tab === "review" ? <p className="mx-auto w-full max-w-[1040px] px-4 pt-3 text-sm text-text-2 sm:px-6">AI 记忆已移至<Link className={ui.quiet} href="/opening/suggestions?tab=memory">AI 建议与记忆</Link>。</p> : null}
    <Tabs value={selected} onValueChange={changeTab} className="min-w-0 flex-1">
      <div className="border-b border-line bg-bg/95">
        <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-2 px-4 sm:px-6">
          <TabsList aria-label="知识库分类" className="border-b-0">{tabs.map(({ id, label, icon: Icon }) => <TabsTrigger key={id} value={id}><Icon size={15} aria-hidden="true" />{label}</TabsTrigger>)}</TabsList>
          {activeCourseId ? <Link className={ui.quiet} href={`${basePath}?tab=${selected}${filterQuery}`}>查看全部{selected === "notes" ? "笔记" : "材料"}</Link> : null}
        </div>
      </div>
      <TabsContent value="materials" forceMount className="mx-auto w-full max-w-[1040px] px-4 py-5 sm:px-6"><div id={captureId} hidden={!captureOpen} className="mb-5">{captureMounted ? <ExternalAiCaptureCard courseId={activeCourseId} /> : null}</div><MaterialLibrary api={api} onCourseChange={setActiveCourseId} onFilterQueryChange={setFilterQuery} courseId={activeCourseId} initialOpen={selected === "materials" ? initialOpen : null} incomingFiles={incomingFiles} onIncomingFilesAccepted={() => setIncomingFiles(null)} onUploadBusyChange={setUploadBusy} onUploadRequested={() => picker.current?.click()} onEmptyChange={setMaterialsEmpty} hideUploadPicker /></TabsContent>
      <TabsContent value="notes" className="mx-auto w-full max-w-[1040px] px-4 py-5 sm:px-6"><details className="group mb-4 rounded-card border border-line bg-surface px-4 py-2 text-xs text-text-2 shadow-card"><summary className="flex min-h-9 cursor-pointer list-none items-center justify-between font-medium text-text-2 hover:text-text [&::-webkit-details-marker]:hidden"><span>查看关联学习记录</span><ChevronDown size={14} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-200 group-open:rotate-180" /></summary><div className="pt-2"><LearnerStateCard courseId={activeCourseId ?? undefined} /></div></details>{activeCourseId ? <CourseNotes courseId={activeCourseId} /> : <LibraryDocumentList basePath={basePath} />}</TabsContent>
    </Tabs>
  </section>;
}
