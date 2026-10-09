"use client";

import { ArrowLeft, BookOpen } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, LoadError, LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { CourseLearningView } from "../opening/learning/course-view";
import type { CourseAsset, CourseSummary } from "./course-model";
import { CourseSettingsPanel } from "./course-settings-panel";
import { createCourseStateClient } from "./course-state-client";
import { CourseStudyActions } from "./course-study-actions";

export function CourseAssets({ courseId, assets, onRemoved, libraryHref }: { courseId: string; assets: CourseAsset[]; onRemoved: (id: string) => void; libraryHref: string }) {
  const [selected, setSelected] = useState<CourseAsset | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function remove() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await createCourseStateClient().removeAsset(courseId, selected);
      onRemoved(selected.id); setSelected(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "移出课程失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3"><ul className="divide-y divide-zinc-200 border-y border-zinc-200">{assets.map((asset) => <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={asset.id}>
    <span className="flex min-w-0 flex-1 items-center gap-3"><BookOpen aria-hidden="true" className="shrink-0 text-emerald-700" size={17} />{asset.document ? <Link href={`${libraryHref}#document-${encodeURIComponent(asset.document.id)}`} className="truncate text-sm text-zinc-800 underline decoration-zinc-300 underline-offset-4 hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-700">{asset.document.title}</Link> : <span className="truncate text-sm text-zinc-800">{asset.source?.name ?? `资产 ${asset.assetId}`}</span>}</span>
    <span className="shrink-0 text-xs text-zinc-500">{asset.role}</span><button className={ui.quiet} disabled={busy} onClick={() => { setSelected(asset); setError(""); }} type="button" aria-label={`将 ${asset.document?.title ?? asset.source?.name ?? asset.assetId} 移出此课程`}>移出课程</button>
  </li>)}</ul>
    {selected ? <div className="space-y-2"><p className="text-xs leading-6 text-zinc-600">将“{selected.document?.title ?? selected.source?.name ?? selected.assetId}”移出此课程？原件和其他课程中的引用仍保留，此操作不会删除资产或停止模型使用。</p><div className="flex gap-2"><button className={ui.secondary} disabled={busy} onClick={() => void remove()} type="button">{busy ? "移出中…" : "确认移出此课程"}</button><button className={ui.quiet} disabled={busy} onClick={() => { setSelected(null); setError(""); }} type="button">取消</button></div></div> : null}
    {error ? <LoadError message={error} /> : null}
  </div>;
}

export function useCourseBundle(id: string) {
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [assets, setAssets] = useState<CourseAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([fetch(`/api/courses/${encodeURIComponent(id)}`, { cache: "no-store" }), fetch(`/api/courses/${encodeURIComponent(id)}/assets`, { cache: "no-store" })])
      .then(async ([courseResponse, assetResponse]) => {
        if (!courseResponse.ok || !assetResponse.ok) throw new Error();
        const courseBody = await courseResponse.json() as { course?: CourseSummary };
        const assetBody = await assetResponse.json() as { assets?: CourseAsset[] };
        if (!courseBody.course) throw new Error();
        if (active) { setCourse(courseBody.course); setAssets(assetBody.assets ?? []); }
      })
      .catch(() => { if (active) setError("课程内容加载失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, reloadToken]);

  return { course, assets, setCourse, setAssets, loading, error, reload: () => setReloadToken((value) => value + 1) };
}

/** Opening course page. Does not reference the legacy mock study provider. */
export function CourseDetail({ id }: { id: string }) {
  const { course, assets, setCourse, setAssets, loading, error, reload } = useCourseBundle(id);
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (error || !course) return <main className="p-5"><Link className={ui.quiet} href="/opening/courses"><ArrowLeft size={14} aria-hidden="true" />返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></main>;
  return <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <PageHeading title={course.title} description={course.description || "课程材料与实际观察记录。"} action={<Link className={ui.quiet} href="/opening/courses"><ArrowLeft size={14} aria-hidden="true" />全部课程</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-5">
      <CourseStudyActions assetCount={assets.length} opening />
      <CourseLearningView courseId={id} />
      <section id="course-assets" className="scroll-mt-6 border-t border-zinc-200 pt-5" aria-labelledby="course-assets-heading"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="course-assets-heading">课程材料</h2><Link className={ui.quiet} href="/opening/library?tab=materials">管理知识库</Link></div>{assets.length ? <CourseAssets key={id} courseId={id} assets={assets} libraryHref="/opening/library?tab=notes" onRemoved={(assetId) => setAssets((current) => current.filter((asset) => asset.id !== assetId))} /> : <EmptyState title="还没有挂接课程材料" description="笔记和材料可以先独立保存在知识库中。" />}</section>
      <CourseSettingsPanel key={id} course={course} onChange={(saved) => setCourse((current) => current?.id === saved.id ? saved : current)} />
      <Link className={ui.quiet} href="/opening/today"><BookOpen aria-hidden="true" size={14} />返回今日学习</Link>
    </div></div>
  </main>;
}
