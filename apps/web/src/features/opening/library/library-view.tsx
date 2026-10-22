"use client";

import { BookOpen, Download, FilePlus2, Files, Import, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aistudy/ui";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { PageHeader, ui } from "../design/ui";
import { LibraryDocumentList } from "../../workspace/library-document-list";
import { libraryNewNotePath, type LibraryBasePath } from "../../editor/library-paths";
import { LearnerStateCard } from "../teaching/learner-state-card";
import { CourseNotes } from "../../courses/course-note";
import { MaterialLibrary } from "./material-library";
import type { SourceViewerTarget } from "../inbox/source-viewer";
import { openingUploadAccept, uploadFileRejection } from "../inbox/upload-dropzone";

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

  return <section className="relative flex h-full min-h-0 min-w-0 flex-col bg-bg text-text" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={dropFiles}>
    <PageHeader title="资料" action={<div className="flex flex-wrap items-center gap-1.5">{opening ? null : <Link className={ui.quiet} href="/preview/notion-import" title="从 Notion 导出文件本地预览导入"><Import size={14} aria-hidden="true" />导入</Link>}<Link className={ui.quiet} href={opening ? "/opening/settings/export" : "/settings/export"}><Download size={14} aria-hidden="true" />导出</Link>{selected === "notes" ? <Link className={ui.secondary} href={libraryNewNotePath(basePath, activeCourseId)}><FilePlus2 size={14} aria-hidden="true" />新建笔记</Link> : null}<button type="button" className={selected === "materials" && materialsEmpty ? ui.secondary : ui.primary} disabled={uploadBusy || !!incomingFiles} onClick={() => picker.current?.click()}><Upload size={15} aria-hidden="true" />上传</button></div>} />
    <input ref={picker} className="sr-only" tabIndex={-1} type="file" disabled={uploadBusy || !!incomingFiles} multiple accept={openingUploadAccept} aria-label="上传材料" onChange={event => { acceptFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {dragging ? <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/95 text-lg font-medium text-accent">松开文件，添加到资料</div> : null}
    {fileError ? <p role="alert" className="px-5 py-3 text-sm text-danger">{fileError}</p> : null}
    {tab === "review" ? <p className="px-5 py-3 text-sm text-text-2">AI 记忆已移至<Link className={ui.quiet} href="/opening/suggestions?tab=memory">AI 建议与记忆</Link>。</p> : null}
    <Tabs value={selected} onValueChange={changeTab} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 sm:px-7"><TabsList aria-label="知识库分类">{tabs.map(({ id, label, icon: Icon }) => <TabsTrigger key={id} value={id}><Icon size={15} aria-hidden="true" />{label}</TabsTrigger>)}</TabsList>{activeCourseId ? <Link className={ui.quiet} href={`${basePath}?tab=${selected}${filterQuery}`}>查看全部{selected === "notes" ? "笔记" : "材料"}</Link> : null}</div>
      <TabsContent value="materials" forceMount className="px-5 py-5 sm:px-7"><MaterialLibrary api={api} onCourseChange={setActiveCourseId} onFilterQueryChange={setFilterQuery} courseId={activeCourseId} initialOpen={selected === "materials" ? initialOpen : null} incomingFiles={incomingFiles} onIncomingFilesAccepted={() => setIncomingFiles(null)} onUploadBusyChange={setUploadBusy} onUploadRequested={() => picker.current?.click()} onEmptyChange={setMaterialsEmpty} hideUploadPicker /></TabsContent>
      <TabsContent value="notes" className="px-5 py-5 sm:px-7"><details className="mb-4 text-xs text-text-2"><summary className="min-h-11 cursor-pointer py-2">查看关联学习记录</summary><LearnerStateCard courseId={activeCourseId ?? undefined} /></details>{activeCourseId ? <CourseNotes courseId={activeCourseId} /> : <LibraryDocumentList basePath={basePath} />}</TabsContent>
    </Tabs>
  </section>;
}
