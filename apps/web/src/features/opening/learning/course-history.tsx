"use client";

import { useEffect, useMemo, useState } from "react";
import { createCourseHistoryClient } from "../client/history-client";
import { LoadError, secondaryButtonClass } from "../design/ui";
import { ObservationRevisionCard } from "./observation-revision-card";
import { createCourseHistoryController, emptyCourseHistory, type CourseHistoryState } from "./course-history-state";

export function CourseHistory({ courseId, requirements, onChanged }: { courseId: string; requirements: string[]; onChanged: () => void }) {
  const [filter, setFilter] = useState("all");
  const requirementKey = filter === "all" ? undefined : filter === "unassigned" ? null : filter.slice(4);
  return <details className="border-y border-zinc-200 py-2">
    <summary className="cursor-pointer py-2 text-sm font-medium text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-700">已保存的观察 · 按固定快照翻阅</summary>
    <div className="space-y-3 pb-3 pt-2">
      <p className="text-xs leading-5 text-zinc-500">每次原练习只计快照内的生效版本。纠正和撤回保留历史，不增加练习次数。</p>
      <label className="block text-xs text-zinc-700">按要求筛选历史<select className="ml-2 rounded border border-zinc-200 bg-white px-2 py-2 text-sm" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">全部要求</option><option value="unassigned">未指定要求</option>
        {requirements.map(key => <option key={key} value={`key:${key}`}>{key || "空要求标识"}</option>)}
      </select></label>
      <CourseHistorySession key={JSON.stringify([courseId, filter])} courseId={courseId} requirementKey={requirementKey} onChanged={onChanged} />
    </div>
  </details>;
}

function CourseHistorySession({ courseId, requirementKey, onChanged }: { courseId: string; requirementKey?: string | null; onChanged: () => void }) {
  const [state, setState] = useState(emptyCourseHistory);
  const controller = useMemo(() => createCourseHistoryController(createCourseHistoryClient().getHistory,
    { courseId, ...(requirementKey !== undefined ? { requirementKey } : {}) }, setState), [courseId, requirementKey]);
  useEffect(() => { void controller.start(); return () => controller.cancel(); }, [controller]);
  return <CourseHistoryPageView state={state} onMore={() => void controller.loadMore()} onRefresh={() => void controller.refresh()}
    onChanged={() => { onChanged(); void controller.refresh(); }} />;
}

export function CourseHistoryPageView({ state, onMore, onRefresh, onChanged }: {
  state: CourseHistoryState; onMore: () => void; onRefresh: () => void; onChanged: () => void;
}) {
  const busy = state.status === "loading" || state.status === "loading_more";
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs leading-5 text-zinc-500">{state.snapshotRevision !== null
        ? `固定快照版本 ${state.snapshotRevision} · 已加载 ${state.observations.length} / ${state.totalCount} 条当前可见记录`
        : "历史尚未读取"}。新作答与修订请刷新查看。</p>
      <button type="button" className={secondaryButtonClass} disabled={state.status === "loading"} onClick={onRefresh}>刷新历史（新快照）</button>
    </div>
    {state.notice ? <p role="status" className="text-xs leading-6 text-amber-800">{state.notice}</p> : null}
    {state.status === "loading" || state.status === "idle" ? <p role="status" className="text-sm text-zinc-500">正在读取课程历史…</p> : null}
    {state.status === "error" ? <LoadError message={state.error} onRetry={onRefresh} /> : null}
    {state.status === "ready" && state.observations.length === 0 ? <p className="text-sm text-zinc-500">当前筛选下没有可见的历史记录。</p> : null}
    {state.status === "ready" || state.status === "loading_more" ? state.observations.map(record =>
      <ObservationRevisionCard key={`${state.snapshotKey}:${record.rootObservationId ?? record.id}`} record={record} onChanged={onChanged} />) : null}
    {state.nextCursor ? <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onMore}>{busy ? "正在读取下一页…" : "继续加载（每页 50 条）"}</button> : null}
  </div>;
}
