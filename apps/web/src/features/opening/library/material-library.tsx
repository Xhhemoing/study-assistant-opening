"use client";

import { ArrowDownWideNarrow, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

export function MaterialLibrary({ api, courseId: uploadCourseId = null, initialOpen = null }: { api: OpeningApi; courseId?: string | null; initialOpen?: SourceViewerTarget | null }) {
  const library = useMaterialLibrary(api, { uploadCourseId });
  const { sources, organization, space, selection, loading, refreshing, busy, error, organizationError, refresh, load } = library;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MaterialKind>("all");
  const [status, setStatus] = useState<MaterialStatus>("all");
  const [sort, setSort] = useState<MaterialSort>("newest");
  const [page, setPage] = useState(1);
  const [assignId, setAssignId] = useState<string | null>(null);
  useEffect(() => {
    if (uploadCourseId) library.changeSpace(`course:${uploadCourseId}`);
    // Only react to inbound courseId query — not every library identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadCourseId]);
  const scoped = useMemo(() => materialsInSpace(sources, organization, space), [sources, organization, space]);
  const collection = useMemo(() => collectMaterials(scoped, { query, kind, status, sort, page, pageSize: 20 }), [scoped, query, kind, status, sort, page]);
  const courseId = space.startsWith("course:") ? space.slice(7) : null;
  const titles = { all: "全部原件", inbox: "待整理", ready: "可用于提问", attention: "需处理" };
  const title = courseId ? organization.courses.find(item => item.id === courseId)?.title ?? "课程资料" : titles[space as keyof typeof titles];
  const changeSpace = (next: typeof space) => { library.changeSpace(next); setPage(1); setQuery(""); setKind("all"); setStatus("all"); setAssignId(null); };
  const filtered = query.trim() !== "" || kind !== "all" || status !== "all";
  const incompleteUpload = sources.filter(record => materialStatus(record) === "incomplete_upload").length;
  const parsing = sources.filter(record => materialStatus(record) === "parsing").length;
  const failures = sources.filter(record => materialStatus(record) === "attention").length;
  return <div className="grid min-w-0 gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
    <MaterialSpaceNav sources={sources} organization={organization} space={space} onSpace={changeSpace} onCreate={library.createCourse} disabled={busy || loading || !library.organizationReady} />
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600"><h2 className="text-sm font-semibold text-zinc-900">{title}</h2><span>{scoped.length} 份材料</span>
          {incompleteUpload > 0 ? <span role="status">{incompleteUpload} 份上传未完成</span> : null}
          {parsing > 0 ? <span role="status">{parsing} 份正在解析</span> : null}
          {failures > 0 ? <span className="text-red-700">{failures} 份需处理</span> : null}
        </div>
        <button type="button" className={ui.secondary} disabled={refreshing || busy} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" className={refreshing ? "motion-safe:animate-spin" : ""} />刷新状态</button>
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b border-zinc-200 pb-4">
        <label className="min-w-0 flex-1 basis-56"><span className={`${ui.label} mb-1 block`}>搜索</span><span className="relative block">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
          <input aria-label="搜索材料名称" className={`${ui.input} pl-9`} placeholder="搜索材料名称" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        </span></label>
        <label className="w-36"><span className={`${ui.label} mb-1 block`}>文件格式</span>
          <select className={ui.input} value={kind} onChange={event => { setKind(event.target.value as MaterialKind); setPage(1); }}>{kinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="w-40"><span className={`${ui.label} mb-1 flex items-center gap-1`}><SlidersHorizontal size={12} aria-hidden="true" />处理状态</span>
          <select className={ui.input} value={status} onChange={event => { setStatus(event.target.value as MaterialStatus); setPage(1); }}>{statuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label className="w-36"><span className={`${ui.label} mb-1 flex items-center gap-1`}><ArrowDownWideNarrow size={12} aria-hidden="true" />排序</span>
          <select className={ui.input} value={sort} onChange={event => { setSort(event.target.value as MaterialSort); setPage(1); }}>{sorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        {filtered ? <button type="button" className={ui.quiet} onClick={() => { setQuery(""); setKind("all"); setStatus("all"); setPage(1); }}><X size={14} aria-hidden="true" />清除筛选</button> : null}
      </div>
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {organizationError ? <LoadError message={organizationError} onRetry={() => void load()} /> : null}
      {!loading && !library.organizationReady && !organizationError ? (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          课程关系尚未就绪，暂时无法归入课程或批量整理；仍可查看与上传原件。请稍后刷新。
        </p>
      ) : null}
      {library.result ? <div role="status" className="space-y-1 text-xs text-zinc-700"><p>{library.result.succeeded.length} 份整理成功{library.result.failed.length ? `，${library.result.failed.length} 份未完成` : ""}。</p>
        {library.result.failed.map(item => <p key={item.id} className="break-words text-red-700">{sources.find(source => source.id === item.id)?.name ?? item.id}：{item.message}</p>)}
      </div> : null}
      {loading ? <LoadingRows label="正在读取材料…" /> : <>
        {selection.size ? <MaterialBatchActions key={space} count={selection.size} courses={organization.courses} busy={busy || !library.organizationReady} courseId={courseId}
          onAdd={(target, role) => library.batch(target, role)} onRemove={() => courseId ? library.batch(courseId) : Promise.resolve()}
          onDelete={() => library.deleteSelected()} onClear={library.clearSelection} /> : null}
        <label className="flex items-center gap-2 text-xs text-zinc-600"><input type="checkbox" aria-label="选择当前页材料" className="size-4 accent-emerald-700" disabled={busy || !collection.items.length || !library.organizationReady}
          checked={!!collection.items.length && collection.items.every(item => selection.has(item.id))} onChange={() => library.togglePage(collection.items.map(item => item.id))} />选择当前页</label>
        <div id="upload" className="scroll-mt-4"><InboxPanel api={api} sources={sources} visibleSources={collection.items} onChanged={refresh} selectedIds={selection} onToggle={library.toggle} selectionDisabled={busy || !library.organizationReady} courseId={uploadCourseId} initialOpen={initialOpen}
          renderMetadata={record => library.organizationReady ? <MaterialCourseLabels sourceId={record.id} organization={organization} /> : null}
          onAssign={library.organizationReady ? (id) => setAssignId(current => current === id ? null : id) : undefined}
          renderBelow={record => assignId === record.id ? <MaterialAssignPanel courses={organization.courses} busy={busy || !library.organizationReady}
            onConfirm={async (courseId, role) => { await library.assignOne(record.id, courseId, role); setAssignId(null); }}
            onCancel={() => setAssignId(null)} /> : null} /></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-3 text-xs text-zinc-600">
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
