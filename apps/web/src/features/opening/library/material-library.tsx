"use client";

import { ArrowDownWideNarrow, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { LoadError, LoadingRows, ui } from "../design/ui";
import { InboxPanel } from "../inbox/inbox-panel";
import { collectMaterials, materialStatus, type MaterialKind, type MaterialSort, type MaterialStatus } from "./material-collection";
import { MaterialSpaceNav } from "./material-space-nav";
import { MaterialBatchActions } from "./material-batch-actions";
import { MaterialAssignPanel } from "./material-assign-panel";
import { materialsInSpace } from "./material-spaces";
import { useMaterialLibrary } from "./use-material-library";
import { MaterialCourseLabels } from "./material-course-labels";
import type { SourceViewerTarget } from "../inbox/source-viewer";
import type { LibraryFileBatch } from "./library-view";

const kinds: Array<{ value: MaterialKind; label: string }> = [
  { value: "all", label: "全部材料" }, { value: "pdf", label: "PDF 文档" },
  { value: "image", label: "图片" }, { value: "text", label: "网页与文本" },
  { value: "audio", label: "音视频" }, { value: "other", label: "演示文稿与其他" },
];
const statuses: Array<{ value: MaterialStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "incomplete_upload", label: "上传未完成" },
  { value: "parsing", label: "正在解析" },
  { value: "ready", label: "可用于提问" },
  { value: "attention", label: "上传或解析失败" },
  { value: "stored", label: "仅保存原件" },
];
const sorts: Array<{ value: MaterialSort; label: string }> = [
  { value: "newest", label: "最近上传" }, { value: "oldest", label: "最早上传" },
  { value: "name", label: "名称排序" }, { value: "largest", label: "文件大小" },
];

export function MaterialLibrary({ api, courseId: uploadCourseId = null, initialOpen = null, onCourseChange, onFilterQueryChange, incomingFiles, onIncomingFilesAccepted, onUploadBusyChange, onUploadRequested, onEmptyChange, hideUploadPicker = false }: { api: OpeningApi; courseId?: string | null; initialOpen?: SourceViewerTarget | null; onCourseChange?: (courseId: string | null) => void; onFilterQueryChange?: (query: string) => void; incomingFiles?: LibraryFileBatch | null; onIncomingFilesAccepted?: () => void; onUploadBusyChange?: (busy: boolean) => void; onUploadRequested?: () => void; onEmptyChange?: (empty: boolean) => void; hideUploadPicker?: boolean }) {
  const library = useMaterialLibrary(api, { uploadCourseId });
  const { sources, organization, space, selection, loading, refreshing, busy, error, organizationError, refresh, load, changeSpace: setLibrarySpace } = library;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MaterialKind>("all");
  const [status, setStatus] = useState<MaterialStatus>("all");
  const [sort, setSort] = useState<MaterialSort>("newest");
  const [page, setPage] = useState(1);
  const [filtersRestored, setFiltersRestored] = useState(false);
  const [managing, setManaging] = useState(false);
  const [assignId, setAssignId] = useState<string | null>(null);
  const previousUploadCourseId = useRef<string | null | undefined>(undefined);
  useEffect(() => { onEmptyChange?.(!loading && !error && sources.length === 0); }, [loading, error, sources.length, onEmptyChange]);
  // Apply only inbound changes, preserving locally selected views or newly created courses.
  useEffect(() => {
    // changeSpace is locked during a confirmed organization action; retry when it settles.
    if (busy) return;
    const previous = previousUploadCourseId.current;
    previousUploadCourseId.current = uploadCourseId;
    if (previous === uploadCourseId) return;
    if (uploadCourseId) setLibrarySpace(`course:${uploadCourseId}`);
    else if (previous && space === `course:${previous}`) setLibrarySpace("all");
  }, [uploadCourseId, space, busy, setLibrarySpace]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery((params.get("q") ?? "").slice(0, 200));
    const kind = params.get("kind"); if (kinds.some(item => item.value === kind)) setKind(kind as MaterialKind);
    const status = params.get("status"); if (statuses.some(item => item.value === status)) setStatus(status as MaterialStatus);
    const sort = params.get("sort"); if (sorts.some(item => item.value === sort)) setSort(sort as MaterialSort);
    const page = Number(params.get("listPage")); if (Number.isSafeInteger(page) && page > 0) setPage(page);
    const view = params.get("view"); if (["all", "inbox", "ready", "attention"].includes(view ?? "") && !params.get("courseId")) setLibrarySpace(view as typeof space);
    setFiltersRestored(true);
  }, [setLibrarySpace]);
  useEffect(() => {
    if (!filtersRestored) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ q: query, kind: kind === "all" ? "" : kind, status: status === "all" ? "" : status, sort: sort === "newest" ? "" : sort, listPage: page === 1 ? "" : String(page), view: space.startsWith("course:") || space === "all" ? "" : space, courseId: space.startsWith("course:") ? space.slice(7) : "" })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);
    const filterParams = new URLSearchParams();
    for (const key of ["q", "kind", "status", "sort", "listPage", "view"]) { const value = url.searchParams.get(key); if (value) filterParams.set(key, value); }
    onFilterQueryChange?.(filterParams.size ? `&${filterParams}` : "");
  }, [filtersRestored, query, kind, status, sort, page, space, onFilterQueryChange]);
  const scoped = useMemo(() => materialsInSpace(sources, organization, space), [sources, organization, space]);
  const collection = useMemo(() => collectMaterials(scoped, { query, kind, status, sort, page, pageSize: 20 }), [scoped, query, kind, status, sort, page]);
  const courseId = space.startsWith("course:") ? space.slice(7) : null;
  const titles = { all: "全部原件", inbox: "待整理", ready: "可用于提问", attention: "需处理" };
  const title = courseId ? organization.courses.find(item => item.id === courseId)?.title ?? "课程资料" : titles[space as keyof typeof titles];
  const changeSpace = (next: typeof space) => { library.changeSpace(next); onCourseChange?.(next.startsWith("course:") ? next.slice(7) : null); setPage(1); setQuery(""); setKind("all"); setStatus("all"); };
  const filtered = query.trim() !== "" || kind !== "all" || status !== "all";
  const incompleteUpload = scoped.filter(record => materialStatus(record) === "incomplete_upload").length;
  const parsing = scoped.filter(record => materialStatus(record) === "parsing").length;
  const failures = scoped.filter(record => materialStatus(record) === "attention").length;
  return <div className="grid min-w-0 gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
    <MaterialSpaceNav sources={sources} organization={organization} space={space} onSpace={changeSpace} onCreate={library.createCourse} disabled={busy || loading || !library.organizationReady} />
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-2"><h2 className="text-sm font-semibold text-text">{title}</h2><span>{scoped.length} 份材料</span>
          {incompleteUpload > 0 ? <span role="status">{incompleteUpload} 份上传未完成</span> : null}
          {parsing > 0 ? <span role="status">{parsing} 份正在解析</span> : null}
          {failures > 0 ? <span className="text-danger">{failures} 份需处理</span> : null}
        </div>
        <button type="button" className={ui.secondary} disabled={refreshing || busy} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新状态</button>
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b border-line pb-4">
        <label className="min-w-0 flex-1 basis-56"><span className={`${ui.label} mb-1 block`}>搜索</span><span className="relative block">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" aria-hidden="true" />
          <input aria-label="搜索材料名称" className={`${ui.input} pl-9`} placeholder="搜索材料名称" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        </span></label>
        <details className="min-w-0"><summary className={`${ui.quiet} cursor-pointer`}>筛选与排序{kind !== "all" || status !== "all" || sort !== "newest" ? " · 已启用" : ""}</summary><div className="mt-3 flex flex-wrap gap-3">
        <label className="w-36"><span className={`${ui.label} mb-1 block`}>文件格式</span>
          <select className={ui.input} value={kind} onChange={event => { setKind(event.target.value as MaterialKind); setPage(1); }}>{kinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="w-40"><span className={`${ui.label} mb-1 flex items-center gap-1`}><SlidersHorizontal size={12} aria-hidden="true" />处理状态</span>
          <select className={ui.input} value={status} onChange={event => { setStatus(event.target.value as MaterialStatus); setPage(1); }}>{statuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="w-36"><span className={`${ui.label} mb-1 flex items-center gap-1`}><ArrowDownWideNarrow size={12} aria-hidden="true" />排序</span>
          <select className={ui.input} value={sort} onChange={event => { setSort(event.target.value as MaterialSort); setPage(1); }}>{sorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        </div></details>
        <button type="button" className={ui.quiet} disabled={busy} aria-pressed={managing} onClick={() => { setManaging(value => !value); library.clearSelection(); }}>{managing ? "退出批量管理" : "批量管理"}</button>
        {filtered || sort !== "newest" ? <button type="button" className={ui.quiet} onClick={() => { setQuery(""); setKind("all"); setStatus("all"); setSort("newest"); setPage(1); }}><X size={14} aria-hidden="true" />清除筛选</button> : null}
      </div>
      {kind !== "all" || status !== "all" || sort !== "newest" ? <p className="text-xs leading-5 text-text-2" role="status">当前条件：{[kind !== "all" ? kinds.find(item => item.value === kind)?.label : null, status !== "all" ? statuses.find(item => item.value === status)?.label : null, sort !== "newest" ? sorts.find(item => item.value === sort)?.label : null].filter(Boolean).join(" · ")}</p> : null}
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {organizationError ? <LoadError message={organizationError} onRetry={() => void load()} /> : null}
      {refreshing && !loading ? <LoadingRows label="正在刷新材料状态…" /> : null}
      {!loading && !library.organizationReady && !organizationError ? (
        <p role="status" className="rounded-lg border border-warn/20 bg-warn-soft px-3 py-2 text-xs text-warn">
          课程关系尚未就绪，暂时无法归入课程或批量整理；仍可查看与上传原件。请稍后刷新。
        </p>
      ) : null}
      {library.result ? <div role="status" className="space-y-1 text-xs text-text-2"><p>{library.result.succeeded.length} 份整理成功{library.result.failed.length ? `，${library.result.failed.length} 份未完成` : ""}。</p>
        {library.result.failed.map(item => <p key={item.id} className="break-words text-danger">{sources.find(source => source.id === item.id)?.name ?? item.id}：{item.message}</p>)}
      </div> : null}
      {loading ? <LoadingRows label="正在读取材料…" /> : <>
        {selection.size ? <MaterialBatchActions key={space} count={selection.size} courses={organization.courses} busy={busy || !library.organizationReady} courseId={courseId}
          onAdd={(target, role) => library.batch(target, role)} onRemove={() => courseId ? library.batch(courseId) : Promise.resolve()}
          onDelete={() => library.deleteSelected()} onClear={library.clearSelection} /> : null}
        {managing ? <label className="flex items-center gap-2 text-xs text-text-2"><input type="checkbox" aria-label="选择当前页材料" className="size-6 accent-accent" disabled={busy || !collection.items.length || !library.organizationReady}
          checked={!!collection.items.length && collection.items.every(item => selection.has(item.id))} onChange={() => library.togglePage(collection.items.map(item => item.id))} />选择当前页</label> : null}
        <div id="upload" className="scroll-mt-4"><InboxPanel liveSources={scoped} incomingFiles={incomingFiles} onIncomingFilesAccepted={onIncomingFilesAccepted} onUploadBusyChange={onUploadBusyChange} onUploadRequested={onUploadRequested} hideUploadPicker={hideUploadPicker} showEmptyState={!error} api={api} sources={sources} visibleSources={collection.items} onChanged={refresh} selectedIds={selection} onToggle={managing ? library.toggle : undefined} selectionDisabled={busy || !library.organizationReady} courseId={courseId} initialOpen={initialOpen} expandedSourceId={assignId}
          renderMetadata={record => library.organizationReady ? <MaterialCourseLabels sourceId={record.id} organization={organization} /> : null}
          onAssign={library.organizationReady ? (id) => setAssignId(current => current === id ? null : id) : undefined}
          renderBelow={record => assignId === record.id ? <MaterialAssignPanel courses={organization.courses} busy={busy || !library.organizationReady}
            onConfirm={async (courseId, role) => { await library.assignOne(record.id, courseId, role); setAssignId(null); }}
            onCancel={() => setAssignId(null)} /> : null} /></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs text-text-2">
          <p role="status">{collection.total === 0 ? "0 份材料" : `${(collection.page - 1) * 20 + 1}–${Math.min(collection.page * 20, collection.total)} / ${collection.total} 份材料`}</p>
          <nav aria-label="材料分页" className="flex items-center gap-2">
            <button type="button" aria-label="上一页材料" title="上一页" className={ui.icon} disabled={collection.page <= 1} onClick={() => setPage(collection.page - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
            <span className="min-w-12 text-center tabular-nums">{collection.page} / {collection.pages}</span>
            <button type="button" aria-label="下一页材料" title="下一页" className={ui.icon} disabled={collection.page >= collection.pages} onClick={() => setPage(collection.page + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
          </nav>
        </div>
      </>}
    </div>
  </div>;
}
